// Pi agent：AgentClient / AgentSession 实现（裁剪自 Paseo providers/pi/agent.ts）
// 会话 = 一个 `pi --mode rpc` 子进程，JSONL-RPC 通信

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSelectOption,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
} from "@agent-console/protocol";
import { isCommandAvailable } from "../../executable-resolution.js";
import { readCwd } from "../../session-utils.js";
import { writePiMcpConfig } from "./mcp.js";
import { runProviderTurn } from "../../provider-runner.js";
import type { PiRuntimeEvent, PiRuntimeSession } from "./runtime.js";
import { PiJsonlRpcRuntime } from "./runtime.js";
import type { PiAgentMessage, PiAssistantContent } from "./rpc-types.js";
import type { PiThinkingLevel } from "./rpc-types.js";

const PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsMcpServers: true,
  supportsToolInvocations: true,
  supportsReasoningStream: true,
  supportsDynamicModes: false,
};

const DEFAULT_THINKING_LEVEL = "medium";

/** 推理模型的强度档位（pi 内部会按当前模型 clamp 不支持的级别） */
const PI_THINKING_OPTIONS: AgentSelectOption[] = [
  { id: "off", label: "Off", description: "不额外思考" },
  { id: "minimal", label: "Minimal", description: "轻度思考" },
  { id: "low", label: "Low", description: "较少思考" },
  { id: "medium", label: "Medium", description: "均衡思考", isDefault: true },
  { id: "high", label: "High", description: "深入思考" },
  { id: "xhigh", label: "XHigh", description: "很深入思考" },
  { id: "max", label: "Max", description: "极限思考" },
];

function normalizePiThinkingLevel(value: string | null | undefined): PiThinkingLevel | undefined {
  return value && PI_THINKING_OPTIONS.some((option) => option.id === value)
    ? (value as PiThinkingLevel)
    : undefined;
}

export class PiRpcAgentClient implements AgentClient {
  readonly provider = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;

  /** 最近一次 get_available_models 的 modelId → provider 映射（set_model 需要 provider） */
  private readonly modelProviders = new Map<string, string>();
  private modelsLoadPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      command?: [string, ...string[]];
    } = {},
  ) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const runtime = new PiJsonlRpcRuntime({ command: this.options.command });
    const mcpConfigPath = config.mcpServers
      ? await writePiMcpConfig(config.cwd, config.mcpServers)
      : undefined;
    const runtimeSession = runtime.startSession({
      cwd: config.cwd,
      model: await this.normalizeModel(config.model),
      thinkingLevel: normalizePiThinkingLevel(config.thinkingOptionId) ?? DEFAULT_THINKING_LEVEL,
      mcpConfigPath,
    });
    const state = await runtimeSession.getState();
    const session = new PiRpcAgentSession(
      runtimeSession,
      config,
      state.sessionId,
      async (modelId) => this.ensureModelProvider(modelId),
    );
    await session.init();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const sessionFile = handle.nativeHandle;
    if (!sessionFile) {
      throw new Error("Pi resume requires a native session file handle");
    }
    const config: AgentSessionConfig = {
      provider: "pi",
      cwd: readCwd(handle, overrides),
      ...overrides,
    };
    const runtime = new PiJsonlRpcRuntime({ command: this.options.command });
    const runtimeSession = runtime.startSession({
      cwd: config.cwd,
      model: await this.normalizeModel(config.model),
      thinkingLevel: normalizePiThinkingLevel(config.thinkingOptionId) ?? DEFAULT_THINKING_LEVEL,
      session: sessionFile,
    });
    const state = await runtimeSession.getState();
    const session = new PiRpcAgentSession(
      runtimeSession,
      config,
      state.sessionId,
      async (modelId) => this.ensureModelProvider(modelId),
    );
    await session.init();
    return session;
  }

  async fetchModels(): Promise<AgentModelDefinition[]> {
    const runtime = new PiJsonlRpcRuntime({ command: this.options.command });
    const runtimeSession = runtime.startSession({
      cwd: process.cwd(),
      noSession: true,
    });
    try {
      const models = await runtimeSession.getAvailableModels(10_000);
      this.modelProviders.clear();
      for (const model of models) {
        this.modelProviders.set(model.id, model.provider);
      }
      return models.map((model) => ({
        id: model.id,
        // 厂商独立成 vendor 字段，UI 按 vendor 分组展示
        vendor: model.provider,
        label: model.name ?? model.id,
        provider: "pi",
        contextWindow: model.contextWindow,
        ...(model.reasoning
          ? {
              thinkingOptions: PI_THINKING_OPTIONS,
              defaultThinkingOptionId: DEFAULT_THINKING_LEVEL,
            }
          : {}),
      }));
    } finally {
      await runtimeSession.close();
    }
  }

  /** 裸模型名在多个 provider 下会歧义（如 MiniMax-M2.7），启动参数里规范化为 provider/model */
  private async normalizeModel(model?: string): Promise<string | undefined> {
    if (!model || model.includes("/")) {
      return model;
    }
    let provider = this.modelProviders.get(model);
    if (!provider) {
      await this.ensureModelProvidersLoaded();
      provider = this.modelProviders.get(model);
    }
    return provider ? `${provider}/${model}` : model;
  }

  /** 解析 modelId → provider；缓存未命中（如 daemon 重启后）先拉一次模型列表 */
  private async ensureModelProvider(modelId: string): Promise<string> {
    let provider = this.modelProviders.get(modelId);
    if (!provider) {
      await this.ensureModelProvidersLoaded();
      provider = this.modelProviders.get(modelId) ?? "";
    }
    return provider;
  }

  private async ensureModelProvidersLoaded(): Promise<void> {
    if (this.modelProviders.size > 0 || this.modelsLoadPromise) {
      await this.modelsLoadPromise;
      return;
    }
    this.modelsLoadPromise = this.fetchModels()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.modelsLoadPromise = null;
      });
    await this.modelsLoadPromise;
  }

  async isAvailable(): Promise<boolean> {
    const command = this.options.command?.[0] ?? "pi";
    return isCommandAvailable(command);
  }
}

interface PendingPermission {
  request: AgentPermissionRequest;
  method: string;
}

export class PiRpcAgentSession implements AgentSession {
  readonly provider = "pi" as const;
  readonly id: string;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private activeTurnId: string | null = null;
  private streamingAssistantText = "";
  private activeToolCalls = new Map<string, { name: string; callId: string; args: unknown }>();
  private sessionFile: string | undefined;
  private closed = false;
  private unsubscribe: () => void;

  constructor(
    private readonly runtimeSession: PiRuntimeSession,
    private readonly config: AgentSessionConfig,
    sessionId: string,
    /** 解析 modelId → provider（set_model 需要；由 client 缓存模型目录提供） */
    private readonly resolveModelProvider: (modelId: string) => Promise<string> = async () => "",
  ) {
    this.id = sessionId;
    this.unsubscribe = runtimeSession.onEvent((event) => this.handleRuntimeEvent(event));
  }

  async init(): Promise<void> {
    const state = await this.runtimeSession.getState();
    if (state.sessionFile) {
      this.sessionFile = state.sessionFile;
    }
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (cb) => this.subscribe(cb),
      getSessionId: () => this.id,
    });
  }

  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Pi session is closed");
    }
    const text = promptToText(prompt);
    const ack = await this.runtimeSession.prompt(text);
    const turnId = ack.requestId ?? `pi_${Date.now()}`;
    this.activeTurnId = turnId;
    this.streamingAssistantText = "";
    this.emit({ type: "turn_started", provider: "pi", turnId });
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    const { method } = pending;
    if (method === "confirm") {
      this.runtimeSession.respondToExtensionUiRequest(requestId, {
        confirmed: response.behavior === "allow",
        cancelled: response.behavior === "deny",
      });
    } else {
      this.runtimeSession.respondToExtensionUiRequest(requestId, {
        value: response.value ?? "",
        confirmed: response.behavior === "allow",
        cancelled: response.behavior === "deny",
      });
    }
    this.emit({
      type: "permission_resolved",
      provider: "pi",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "pi",
      nativeHandle: this.sessionFile,
      metadata: { cwd: this.config.cwd, model: this.config.model },
    };
  }

  async interrupt(): Promise<void> {
    if (this.closed) {
      return;
    }
    const turnId = this.activeTurnId;
    // 先结算，避免 abort 期间 agent_end 误发 turn_completed
    this.activeTurnId = null;
    try {
      await this.runtimeSession.abort();
    } finally {
      if (turnId) {
        this.emit({
          type: "turn_canceled",
          provider: "pi",
          reason: "interrupted",
          turnId,
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // 运行中的回合先结算，否则 run() 的完成 promise 永远不 resolve（WS 请求悬挂）
    const turnId = this.activeTurnId;
    if (turnId) {
      this.activeTurnId = null;
      this.emit({
        type: "turn_canceled",
        provider: "pi",
        reason: "session closed",
        turnId,
      });
    }
    this.unsubscribe();
    await this.runtimeSession.close();
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async setModel(modelId: string): Promise<void> {
    this.config.model = modelId;
    const provider = await this.resolveModelProvider(modelId);
    const slash = modelId.indexOf("/");
    await this.runtimeSession.setModel(
      provider || (slash > 0 ? modelId.slice(0, slash) : ""),
      slash > 0 ? modelId.slice(slash + 1) : modelId,
    );
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const level = normalizePiThinkingLevel(thinkingOptionId) ?? DEFAULT_THINKING_LEVEL;
    this.config.thinkingOptionId = level;
    await this.runtimeSession.setThinkingLevel(level);
  }

  private handleRuntimeEvent(event: PiRuntimeEvent): void {
    switch (event.type) {
      case "message_update": {
        const delta = (event.assistantMessageEvent as { delta?: string }).delta;
        if (event.assistantMessageEvent.type === "text_delta" && delta) {
          this.streamingAssistantText += delta;
          this.emitTimeline({ type: "assistant_message", text: this.streamingAssistantText });
        } else if (event.assistantMessageEvent.type === "thinking_delta" && delta) {
          this.emitTimeline({ type: "reasoning", text: delta });
        }
        break;
      }
      case "message_end": {
        const text = extractAssistantText(event.message);
        if (text) {
          this.streamingAssistantText = text;
          this.emitTimeline({ type: "assistant_message", text });
        }
        break;
      }
      case "tool_execution_start":
        this.activeToolCalls.set(event.toolCallId, {
          name: event.toolName,
          callId: event.toolCallId,
          args: event.args,
        });
        this.emitTimeline({
          type: "tool_call",
          callId: event.toolCallId,
          name: event.toolName,
          detail: mapPiToolDetail(event.toolName, event.args),
          status: "running",
        });
        break;
      case "tool_execution_end": {
        const tracked = this.activeToolCalls.get(event.toolCallId);
        this.activeToolCalls.delete(event.toolCallId);
        const name = tracked?.name ?? event.toolName;
        const detail = mapPiToolDetail(name, tracked?.args);
        this.emitTimeline({
          type: "tool_call",
          callId: event.toolCallId,
          name,
          detail,
          status: event.isError ? "failed" : "completed",
          ...(event.isError ? { error: event.result } : {}),
        });
        break;
      }
      case "extension_ui_request": {
        this.handleExtensionUiRequest(event);
        break;
      }
      case "agent_end": {
        if (this.activeTurnId) {
          this.emit({ type: "turn_completed", provider: "pi", turnId: this.activeTurnId });
          this.activeTurnId = null;
        }
        break;
      }
      case "process_exit": {
        if (this.activeTurnId) {
          this.emit({ type: "turn_failed", provider: "pi", error: event.error, turnId: this.activeTurnId });
          this.activeTurnId = null;
        }
        break;
      }
      default:
        break;
    }
  }

  private handleExtensionUiRequest(event: PiRuntimeEvent & { id: string; method: string }): void {
    const method = event.method;
    const description = describeExtensionUiRequest(event);
    const request: AgentPermissionRequest = {
      id: event.id,
      kind: "question",
      description,
      detail: JSON.stringify(event),
      raw: event,
    };
    this.pendingPermissions.set(event.id, { request, method });
    this.emit({ type: "permission_requested", provider: "pi", request, turnId: this.activeTurnId ?? undefined });
  }

  private emitTimeline(item: AgentTimelineItem): void {
    this.emit({ type: "timeline", item, provider: "pi", turnId: this.activeTurnId ?? undefined });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

// ---------- helpers ----------

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

function extractAssistantText(message: PiAgentMessage): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  const parts = message.content.filter(
    (part): part is Extract<PiAssistantContent, { type: "text" }> => part.type === "text",
  );
  const text = parts.map((part) => part.text).join("");
  return text || undefined;
}

function mapPiToolDetail(toolName: string, args: unknown): ToolCallDetail {
  const record = (args ?? {}) as Record<string, unknown>;
  const readString = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  switch (toolName) {
    case "bash":
      return { kind: "shell", command: readString("command") ?? "" };
    case "read":
      return { kind: "read", path: readString("path") ?? "" };
    case "edit":
      return { kind: "edit", path: readString("path") ?? "" };
    case "write":
      return { kind: "write", path: readString("path") ?? "" };
    case "find":
    case "grep":
    case "ls":
      return { kind: "search", query: readString("pattern") ?? readString("path") ?? "" };
    case "fetch":
      return { kind: "fetch", url: readString("url") ?? "" };
    default:
      return { kind: "unknown", raw: args };
  }
}

function describeExtensionUiRequest(event: Record<string, unknown>): string {
  const method = event.method;
  const message = typeof event.message === "string" ? event.message : undefined;
  if (message) {
    return message;
  }
  if (method === "select") {
    const options = Array.isArray(event.options)
      ? (event.options as unknown[]).map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>)?.label ?? o))).join(", ")
      : "";
    return `请选择: ${options}`;
  }
  if (method === "confirm") {
    return "请确认操作";
  }
  if (method === "input" || method === "editor") {
    return "请提供输入";
  }
  return `Pi 请求: ${method}`;
}
