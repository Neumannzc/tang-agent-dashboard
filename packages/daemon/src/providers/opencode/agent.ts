// OpenCode agent：AgentClient / AgentSession 实现
// 长驻 `opencode serve` HTTP server + 官方 SDK（@opencode-ai/sdk）

import {
  createOpencodeClient,
  type GlobalEvent as OpenCodeGlobalEvent,
  type OpencodeClient,
  type Part as OpenCodePart,
} from "@opencode-ai/sdk/v2/client";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
} from "@agent-console/protocol";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isCommandAvailable } from "../../executable-resolution.js";
import { readCwd } from "../../session-utils.js";
import { runProviderTurn } from "../../provider-runner.js";
import { OpenCodeServerManager } from "./server-manager.js";

const OPENCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsMcpServers: true,
  supportsToolInvocations: true,
  supportsReasoningStream: true,
  supportsDynamicModes: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export class OpenCodeAgentClient implements AgentClient {
  readonly provider = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;

  constructor(
    private readonly options: {
      command?: [string, ...string[]];
    } = {},
  ) {
    if (options.command) {
      OpenCodeServerManager.configure(options.command);
    }
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const acquisition = await OpenCodeServerManager.getInstance().acquire();
    const client = createOpencodeClient({
      baseUrl: acquisition.server.url,
      directory: config.cwd,
    });
    try {
      const response = await client.session.create({ directory: config.cwd });
      if (response.error) {
        throw new Error(`Failed to create OpenCode session: ${JSON.stringify(response.error)}`);
      }
      const session = response.data;
      if (!session) {
        throw new Error("OpenCode session creation returned no data");
      }
      return new OpenCodeAgentSession(client, session.id, config, acquisition.release);
    } catch (error) {
      acquisition.release();
      throw error;
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const sessionId = handle.nativeHandle;
    if (!sessionId) {
      throw new Error("OpenCode resume requires a session id handle");
    }
    const config: AgentSessionConfig = {
      provider: "opencode",
      cwd: readCwd(handle, overrides),
      ...overrides,
    };
    const acquisition = await OpenCodeServerManager.getInstance().acquire();
    const client = createOpencodeClient({
      baseUrl: acquisition.server.url,
      directory: config.cwd,
    });
    return new OpenCodeAgentSession(client, sessionId, config, acquisition.release);
  }

  async fetchModels(): Promise<AgentModelDefinition[]> {
    // opencode server 运行在中性 home 目录（PLAN 风险 #1），模型目录来自用户配置
    // 直接解析用户 ~/.config/opencode/opencode.json 的 provider.models
    return readUserOpencodeModels();
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable("opencode");
  }

  async shutdown(): Promise<void> {
    // daemon 退出时回收长驻 server，避免孤儿进程（AgentManager.shutdown 会调用）
    await OpenCodeServerManager.getInstance().shutdown();
  }
}

export class OpenCodeAgentSession implements AgentSession {
  readonly provider = "opencode" as const;
  readonly id: string;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, { kind: "tool" | "question" }>();
  private activeTurnId: string | null = null;
  private streamingAssistantText = "";
  private reasoningText = "";
  private messageRoles = new Map<string, string>();
  private closed = false;
  private eventAbortController: AbortController | null = null;
  private eventStreamConsumption: Promise<void> | null = null;

  constructor(
    private readonly client: OpencodeClient,
    sessionId: string,
    private readonly config: AgentSessionConfig,
    private readonly releaseServer: () => void,
  ) {
    this.id = sessionId;
    this.startEventStream();
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
      throw new Error("OpenCode session is closed");
    }
    const turnId = `opencode-${Date.now()}`;
    this.activeTurnId = turnId;
    this.streamingAssistantText = "";
    this.reasoningText = "";
    this.emit({ type: "turn_started", provider: "opencode", turnId });

    const parts = promptToParts(prompt);
    const system = this.config.systemPrompt;
    const model = this.config.model;
    const agent = this.config.modeId;

    // promptAsync 立即返回，事件通过 SSE 流推送
    const response = await this.client.session.promptAsync({
      sessionID: this.id,
      directory: this.config.cwd,
      parts,
      ...(system ? { system } : {}),
      ...(model ? { model: parseModelRef(model) } : {}),
      ...(agent ? { agent } : {}),
    });
    if (response.error) {
      this.finishTurnFailed(JSON.stringify(response.error));
      return { turnId };
    }
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
    if (pending.kind === "tool") {
      await this.client.permission.reply({
        requestID: requestId,
        reply: response.behavior === "allow" ? "once" : "reject",
      });
    } else if (response.behavior === "allow") {
      await this.client.question.reply({
        requestID: requestId,
        answers: [response.value ? [response.value] : []],
      });
    } else {
      // 拒绝问题应走 reject，而不是提交空答案
      await this.client.question.reject({ requestID: requestId });
    }
    this.emit({
      type: "permission_resolved",
      provider: "opencode",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "opencode",
      nativeHandle: this.id,
      metadata: { cwd: this.config.cwd, model: this.config.model, modeId: this.config.modeId },
    };
  }

  async setModel(modelId: string): Promise<void> {
    // 模型在 promptAsync 参数里按回合生效，更新 config 供后续回合使用
    this.config.model = modelId;
  }

  async interrupt(): Promise<void> {
    if (this.closed) {
      return;
    }
    const turnId = this.activeTurnId;
    // 先结算，避免 abort 期间 session.idle 再发 turn_completed
    this.activeTurnId = null;
    try {
      await this.client.session.abort({ sessionID: this.id });
    } finally {
      if (turnId) {
        this.emit({
          type: "turn_canceled",
          provider: "opencode",
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
        provider: "opencode",
        reason: "session closed",
        turnId,
      });
    }
    this.eventAbortController?.abort();
    if (this.eventStreamConsumption) {
      await this.eventStreamConsumption.catch(() => undefined);
    }
    this.subscribers.clear();
    this.releaseServer();
  }

  private startEventStream(): void {
    this.eventAbortController = new AbortController();
    const controller = this.eventAbortController;
    this.eventStreamConsumption = (async () => {
      try {
        const result = await this.client.global.event({
          signal: controller.signal,
          sseMaxRetryAttempts: 0,
        });
        for await (const rawEvent of result.stream) {
          this.handleOpenCodeEvent(rawEvent);
        }
      } catch (error) {
        if (!controller.signal.aborted && this.activeTurnId) {
          this.finishTurnFailed(error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }

  private handleOpenCodeEvent(rawEvent: OpenCodeGlobalEvent): void {
    // 全局 SSE 事件被包在 GlobalEvent 里，真实事件在 payload
    const payload = rawEvent.payload as unknown as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "";
    const props = (isRecord(payload.properties) ? payload.properties : {}) as Record<string, unknown>;
    if (props.sessionID !== undefined && props.sessionID !== this.id) {
      return;
    }
    switch (type) {
      case "message.updated": {
        const info = isRecord(props.info) ? props.info : {};
        const role = typeof info.role === "string" ? info.role : "";
        const messageId = typeof info.id === "string" ? info.id : "";
        if (messageId) {
          this.messageRoles.set(messageId, role);
        }
        if (role !== "assistant") {
          break;
        }
        const parts = Array.isArray(info.parts) ? (info.parts as OpenCodePart[]) : [];
        const text = extractPartsText(parts);
        if (text) {
          this.streamingAssistantText = text;
          this.emitTimeline({ type: "assistant_message", text });
        }
        break;
      }
      case "message.part.updated": {
        const part = isRecord(props.part) ? (props.part as OpenCodePart) : null;
        if (!part) {
          break;
        }
        const partId = typeof part.id === "string" ? part.id : "";
        if (this.partRole(partId) !== "assistant") {
          break;
        }
        if (part.type === "text") {
          const text = typeof part.text === "string" ? part.text : "";
          if (text) {
            this.streamingAssistantText = text;
            this.emitTimeline({ type: "assistant_message", text });
          }
        } else if (part.type === "reasoning") {
          const text = typeof part.text === "string" ? part.text : "";
          if (text && text !== this.reasoningText) {
            this.reasoningText = text;
            this.emitTimeline({ type: "reasoning", text: text.slice(-200) });
          }
        } else if (part.type === "tool") {
          const callId = partId || `tool-${Date.now()}`;
          const name = readPartString(part, "tool") ?? "tool";
          this.handleToolPart(callId, name, part);
        }
        break;
      }
      case "message.part.delta": {
        const field = props.field;
        const delta = typeof props.delta === "string" ? props.delta : "";
        const messageId = typeof props.messageID === "string" ? props.messageID : "";
        if (messageId && this.messageRoles.get(messageId) !== "assistant") {
          break;
        }
        if (field === "text" && delta) {
          this.streamingAssistantText += delta;
          this.emitTimeline({ type: "assistant_message", text: this.streamingAssistantText });
        } else if (field === "reasoning" && delta) {
          this.reasoningText += delta;
          this.emitTimeline({ type: "reasoning", text: this.reasoningText.slice(-200) });
        }
        break;
      }
      case "permission.asked": {
        const requestId = readString(props, "id");
        const permission = readString(props, "permission") ?? "unknown";
        const patterns = Array.isArray(props.patterns) ? (props.patterns as string[]) : [];
        if (!requestId) {
          break;
        }
        const request: AgentPermissionRequest = {
          id: requestId,
          kind: "tool",
          description: describeOpenCodePermission(permission, patterns),
          detail: patterns.join(", "),
          raw: props,
        };
        this.pendingPermissions.set(requestId, { kind: "tool" });
        this.emit({
          type: "permission_requested",
          provider: "opencode",
          request,
          turnId: this.activeTurnId ?? undefined,
        });
        break;
      }
      case "question.asked": {
        const requestId = readString(props, "id");
        const questions = Array.isArray(props.questions) ? (props.questions as Array<Record<string, unknown>>) : [];
        if (!requestId) {
          break;
        }
        const description = questions
          .map((q) => (typeof q.question === "string" ? q.question : ""))
          .filter(Boolean)
          .join("\n");
        const request: AgentPermissionRequest = {
          id: requestId,
          kind: "question",
          description: description || "OpenCode 请求用户输入",
          detail: JSON.stringify(props),
          raw: props,
        };
        this.pendingPermissions.set(requestId, { kind: "question" });
        this.emit({
          type: "permission_requested",
          provider: "opencode",
          request,
          turnId: this.activeTurnId ?? undefined,
        });
        break;
      }
      case "session.idle": {
        if (this.activeTurnId) {
          this.emit({
            type: "turn_completed",
            provider: "opencode",
            turnId: this.activeTurnId,
          });
          this.activeTurnId = null;
        }
        break;
      }
      case "session.error": {
        const error = isRecord(props.error) ? props.error : props.error;
        const message =
          (isRecord(error) && typeof error.message === "string" ? error.message : undefined) ??
          "OpenCode session error";
        this.finishTurnFailed(message);
        break;
      }
      default:
        break;
    }
  }

  private handleToolPart(callId: string, name: string, part: OpenCodePart): void {
    const state = readPartString(part, "state");
    const detail = mapOpenCodeToolDetail(name, part);
    if (state === "completed" || state === "error") {
      this.emitTimeline({
        type: "tool_call",
        callId,
        name,
        detail,
        status: state === "error" ? "failed" : "completed",
        ...(state === "error" ? { error: part } : {}),
      });
    } else {
      this.emitTimeline({
        type: "tool_call",
        callId,
        name,
        detail,
        status: "running",
      });
    }
  }

  private finishTurnFailed(error: string): void {
    if (this.activeTurnId) {
      this.emit({ type: "turn_failed", provider: "opencode", error, turnId: this.activeTurnId });
      this.activeTurnId = null;
    }
  }

  /** part id 形如 "msg_xxx-0"，去掉后缀得到所属 message id */
  private partRole(partId: string): string | undefined {
    const exact = this.messageRoles.get(partId);
    if (exact) {
      return exact;
    }
    const base = partId.replace(/-\d+$/, "");
    return this.messageRoles.get(base);
  }

  private emitTimeline(item: AgentTimelineItem): void {
    this.emit({ type: "timeline", item, provider: "opencode", turnId: this.activeTurnId ?? undefined });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

// ---------- helpers ----------

function promptToParts(prompt: AgentPromptInput): Array<{ type: "text"; text: string }> {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  return prompt
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => ({ type: "text", text: part.text }));
}

/** 支持 "provider/model" 或纯 modelID 两种写法 */
function parseModelRef(model: string): { providerID: string; modelID: string } {
  const slashIndex = model.indexOf("/");
  if (slashIndex > 0) {
    return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
  }
  return { providerID: "", modelID: model };
}

function extractPartsText(parts: OpenCodePart[]): string | undefined {
  const textParts = parts.filter(
    (part) => part.type === "text" && typeof part.text === "string",
  ) as Array<{ type: "text"; text: string }>;
  const text = textParts.map((part) => part.text).join("");
  return text || undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function readPartString(part: OpenCodePart, key: string): string | undefined {
  const record = part as unknown as Record<string, unknown>;
  return readString(record, key);
}

function describeOpenCodePermission(permission: string, patterns: string[]): string {
  const patternText = patterns.length > 0 ? ` (${patterns.join(", ")})` : "";
  switch (permission) {
    case "bash":
      return `运行命令${patternText}`;
    case "edit":
    case "write":
      return `修改文件${patternText}`;
    case "read":
      return `读取文件${patternText}`;
    case "webfetch":
      return `访问网络: ${patterns[0] ?? ""}`;
    default:
      return `${permission}${patternText}`;
  }
}

function mapOpenCodeToolDetail(name: string, part: OpenCodePart): ToolCallDetail {
  const record = part as unknown as Record<string, unknown>;
  const input = record.input;
  if (name === "bash" && isRecord(input)) {
    return { kind: "shell", command: typeof input.command === "string" ? input.command : "" };
  }
  if (name === "read" && isRecord(input)) {
    return { kind: "read", path: typeof input.filePath === "string" ? input.filePath : "" };
  }
  if (name === "edit" && isRecord(input)) {
    return { kind: "edit", path: typeof input.filePath === "string" ? input.filePath : "" };
  }
  if (name === "write" && isRecord(input)) {
    return { kind: "write", path: typeof input.filePath === "string" ? input.filePath : "" };
  }
  if (name === "webfetch" && isRecord(input)) {
    return { kind: "fetch", url: typeof input.url === "string" ? input.url : "" };
  }
  if (name === "grep" || name === "glob" || name === "list") {
    return { kind: "search", query: "" };
  }
  return { kind: "unknown", raw: part };
}

/** 读取用户 opencode 配置中的模型目录（provider/models） */
function readUserOpencodeModels(): AgentModelDefinition[] {
  const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
  try {
    if (!existsSync(configPath)) {
      return [];
    }
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as { provider?: Record<string, { models?: Record<string, { name?: string }> }> };
    const providers = parsed.provider ?? {};
    const models: AgentModelDefinition[] = [];
    for (const [providerID, providerConfig] of Object.entries(providers)) {
      for (const modelID of Object.keys(providerConfig?.models ?? {})) {
        models.push({
          id: `${providerID}/${modelID}`,
          label: providerConfig.models?.[modelID]?.name ?? modelID,
          provider: "opencode",
        });
      }
    }
    return models;
  } catch {
    return [];
  }
}
