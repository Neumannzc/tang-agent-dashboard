// Codex agent：AgentClient / AgentSession 实现
// 会话 = 一个 `codex app-server` 子进程，自定义 stdio JSON-RPC

import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
  AgentSelectOption,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
} from "@agent-console/protocol";
import { isCommandAvailable } from "../../executable-resolution.js";
import { readCwd } from "../../session-utils.js";
import { runProviderTurn } from "../../provider-runner.js";
import { spawnProcess } from "../../spawn.js";
import { CodexAppServerClient } from "./app-server-transport.js";

const CODEX_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsMcpServers: true,
  supportsToolInvocations: true,
  supportsReasoningStream: true,
  supportsDynamicModes: true,
};

/** codex model/list 条目（camelCase 已由 app-server 序列化） */
interface CodexModelEntry {
  id: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>;
}

function isCodexModelEntry(value: unknown): value is CodexModelEntry {
  return typeof value === "object" && value !== null && typeof (value as CodexModelEntry).id === "string";
}

function buildCodexThinkingOptions(model: CodexModelEntry): AgentSelectOption[] | undefined {
  const entries = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((entry) => entry?.reasoningEffort)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (entries.length === 0) {
    return undefined;
  }
  const options = entries.map((id) => ({
    id,
    label: id,
    ...(id === model.defaultReasoningEffort ? { isDefault: true } : {}),
  }));
  // 默认档不在列表时补一项，保证 UI 总能高亮当前默认
  if (model.defaultReasoningEffort && !entries.includes(model.defaultReasoningEffort)) {
    options.unshift({ id: model.defaultReasoningEffort, label: model.defaultReasoningEffort, isDefault: true });
  }
  return options;
}

const TURN_START_TIMEOUT_MS = 90 * 1000;
const MODE_PRESETS: Record<string, { approvalPolicy: string; sandbox: string }> = {
  plan: { approvalPolicy: "never", sandbox: "read-only" },
  default: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

function toSandboxPolicy(type: string, networkAccess = false): Record<string, unknown> {
  switch (type) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite", networkAccess };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return { type: "workspaceWrite", networkAccess };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export class CodexAppServerAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;

  constructor(
    private readonly options: {
      command?: [string, ...string[]];
    } = {},
  ) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const child = spawnAppServer(config.cwd, this.options.command);
    const client = new CodexAppServerClient(child);
    try {
      await client.request("initialize", {
        clientInfo: { name: "agent-console", title: "Agent Console", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      client.notify("initialized", {});
      const session = new CodexAppServerAgentSession(client, config);
      session.setUnexpectedTerminationHandler();
      session.registerRequestHandlers();
      // 提前建线程锁定会话 id（thread_xxx）：否则首轮 prompt 时才建线程，
      // session.id 中途变化会导致事件广播 id 与 manager 注册 id 不一致（UI 收不到事件）
      await session.ensureThread();
      return session;
    } catch (error) {
      await client.dispose();
      throw toReadableSpawnError(error, this.options.command?.[0] ?? "codex");
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const threadId = handle.nativeHandle;
    if (!threadId) {
      throw new Error("Codex resume requires a thread id handle");
    }
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: readCwd(handle, overrides),
      ...overrides,
    };
    const child = spawnAppServer(config.cwd, this.options.command);
    const client = new CodexAppServerClient(child);
    try {
      await client.request("initialize", {
        clientInfo: { name: "agent-console", title: "Agent Console", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      client.notify("initialized", {});
      await client.request("thread/resume", { threadId });
    } catch (error) {
      await client.dispose();
      throw toReadableSpawnError(error, this.options.command?.[0] ?? "codex");
    }
    const session = new CodexAppServerAgentSession(client, config, threadId);
    session.setUnexpectedTerminationHandler();
    session.registerRequestHandlers();
    return session;
  }

  async fetchModels(): Promise<AgentModelDefinition[]> {
    // 复用 app-server：initialize 后调 model/list，返回 codex 完整模型目录
    const child = spawnAppServer(process.cwd(), this.options.command);
    const client = new CodexAppServerClient(child);
    try {
      await client.request("initialize", {
        clientInfo: { name: "agent-console", title: "Agent Console", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      client.notify("initialized", {});
      const entries: CodexModelEntry[] = [];
      let cursor: string | undefined;
      do {
        const raw = await client.request("model/list", {
          ...(cursor ? { cursor } : {}),
        });
        const response = isRecord(raw) ? raw : {};
        if (Array.isArray(response.data)) {
          for (const entry of response.data) {
            if (isCodexModelEntry(entry)) {
              entries.push(entry);
            }
          }
        }
        cursor =
          typeof response.nextCursor === "string" && response.nextCursor.length > 0
            ? response.nextCursor
            : undefined;
      } while (cursor);
      return entries
        .filter((model) => model.hidden !== true)
        .map((model) => ({
          id: model.id,
          label: model.displayName || model.id,
          provider: "codex" as const,
          description: model.description || undefined,
          isDefault: model.isDefault === true,
          ...(buildCodexThinkingOptions(model)
            ? {
                thinkingOptions: buildCodexThinkingOptions(model),
                defaultThinkingOptionId: model.defaultReasoningEffort,
              }
            : {}),
        }));
    } catch (error) {
      throw toReadableSpawnError(error, this.options.command?.[0] ?? "codex");
    } finally {
      await client.dispose();
    }
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable("codex");
  }
}

export class CodexAppServerAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  id: string;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissionResolvers = new Map<
    string,
    { method: string; resolve: (value: unknown) => void; request: AgentPermissionRequest }
  >();
  private activeTurnId: string | null = null;
  private currentThreadId: string | null;
  private streamingAssistantText = "";
  private activeToolCalls = new Map<string, { name: string; callId: string; detail: ToolCallDetail }>();
  private lastUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  private closed = false;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly config: AgentSessionConfig,
    threadId?: string,
  ) {
    this.id = threadId ?? `codex-${Date.now()}`;
    this.currentThreadId = threadId ?? null;
  }

  setUnexpectedTerminationHandler(): void {
    this.client.setUnexpectedTerminationHandler((error) => {
      if (this.activeTurnId) {
        this.emit({
          type: "turn_failed",
          provider: "codex",
          error: error.message,
          turnId: this.activeTurnId,
        });
        this.activeTurnId = null;
      }
    });
  }

  registerRequestHandlers(): void {
    this.client.setRequestHandler("item/commandExecution/requestApproval", (params) =>
      this.handleApprovalRequest(params, "command", { kind: "shell", command: readString(params, "command") ?? "" }),
    );
    this.client.setRequestHandler("item/fileChange/requestApproval", (params) =>
      this.handleApprovalRequest(params, "file", {
        kind: "edit",
        path: extractFilePath(params),
      }),
    );
    this.client.setRequestHandler("item/tool/requestUserInput", (params) =>
      this.handleUserInputRequest(params),
    );
    this.client.setRequestHandler("tool/requestUserInput", (params) =>
      this.handleUserInputRequest(params),
    );
    this.client.setNotificationHandler((method, params) => this.handleNotification(method, params));
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
      throw new Error("Codex session is closed");
    }
    const input = promptToText(prompt);
    await this.ensureThread();
    const preset = MODE_PRESETS[this.config.modeId ?? "default"] ?? MODE_PRESETS.default!;
    const approvalPolicy = preset.approvalPolicy;
    const sandboxPolicyType = preset.sandbox;
    const params: Record<string, unknown> = {
      threadId: this.currentThreadId,
      input: [{ type: "text", text: input }],
      approvalPolicy,
      sandboxPolicy: toSandboxPolicy(sandboxPolicyType),
    };
    if (this.config.model) {
      params.model = this.config.model;
    }
    if (this.config.thinkingOptionId) {
      params.effort = this.config.thinkingOptionId;
    }
    if (this.config.systemPrompt) {
      params.developerInstructions = this.config.systemPrompt;
    }
    if (this.config.cwd) {
      params.cwd = this.config.cwd;
    }
    await this.client.request("turn/start", params, TURN_START_TIMEOUT_MS);
    // 真实 turn id 由随后的 turn/started 通知给出（通知可能已在 await 期间到达）。
    // 通知未到时先用占位 id 保证 run() 编排可用，turn_started 事件统一由通知补发（带真实 id）。
    this.activeTurnId ??= `codex-turn-${Date.now()}`;
    this.streamingAssistantText = "";
    this.lastUsage = undefined; // 按回合结算，避免上一回合的 token 数据串用
    return { turnId: this.activeTurnId };
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
    const pending = this.pendingPermissionResolvers.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissionResolvers.delete(requestId);
    const decision = response.behavior === "allow" ? "accept" : response.interrupt ? "cancel" : "decline";
    if (pending.method === "userInput") {
      pending.resolve({ answers: response.value ? { question: [response.value] } : {} });
    } else {
      pending.resolve({ decision });
    }
    this.emit({
      type: "permission_resolved",
      provider: "codex",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.currentThreadId) {
      return null;
    }
    return {
      provider: "codex",
      nativeHandle: this.currentThreadId,
      metadata: { cwd: this.config.cwd, model: this.config.model, modeId: this.config.modeId },
    };
  }

  async interrupt(): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      return;
    }
    const turnId = this.activeTurnId;
    // 先结算，避免 turn/completed 通知随后再发一次终态事件
    this.activeTurnId = null;
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.currentThreadId,
        // 真实 turn id 尚未从 turn/started 到达时（仍是占位 id），传空串：
        // app-server 将空 turnId 视作 startup interrupt，同样会中断当前回合
        turnId: turnId.startsWith("codex-turn-") ? "" : turnId,
      });
    } finally {
      this.emit({
        type: "turn_canceled",
        provider: "codex",
        reason: "interrupted",
        turnId,
      });
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
        provider: "codex",
        reason: "session closed",
        turnId,
      });
    }
    this.subscribers.clear();
    await this.client.dispose();
  }

  async getAvailableModes(): Promise<{ id: string; label: string }[]> {
    return Object.keys(MODE_PRESETS).map((id) => ({ id, label: id }));
  }

  async setModel(modelId: string): Promise<void> {
    // 模型在 turn/start 参数里按回合生效，更新 config 供后续回合使用
    this.config.model = modelId;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    // effort 在 turn/start 参数里按回合生效，更新 config 供后续回合使用
    this.config.thinkingOptionId = thinkingOptionId ?? undefined;
  }

  /** 建立 codex 线程并锁定会话 id（createSession 时提前调用） */
  async ensureThread(): Promise<void> {
    if (this.currentThreadId) {
      return;
    }
    const params: Record<string, unknown> = {
      model: this.config.model ?? null,
      cwd: this.config.cwd ?? null,
      approvalPolicy: MODE_PRESETS[this.config.modeId ?? "default"]?.approvalPolicy ?? "on-request",
      sandbox: MODE_PRESETS[this.config.modeId ?? "default"]?.sandbox ?? "workspace-write",
      ...(this.config.systemPrompt ? { developerInstructions: this.config.systemPrompt } : {}),
    };
    const rawResponse = await this.client.request("thread/start", params);
    const response = toObjectRecord(rawResponse);
    const threadRecord = toObjectRecord(response?.thread);
    const threadId = typeof threadRecord?.id === "string" ? threadRecord.id : undefined;
    if (!threadId) {
      throw new Error("Codex app-server did not return thread id");
    }
    this.currentThreadId = threadId;
    this.id = threadId;
    this.emit({ type: "thread_started", sessionId: threadId, provider: "codex" });
  }

  private handleApprovalRequest(
    params: unknown,
    kind: "command" | "file",
    detail: ToolCallDetail,
  ): Promise<unknown> {
    const parsed = toObjectRecord(params);
    const itemId = readString(params, "itemId") ?? `unknown-${Date.now()}`;
    const command = readString(params, "command");
    const description =
      kind === "command"
        ? command
          ? `运行命令: ${command}`
          : "执行命令"
        : detail.kind === "edit" && detail.path
          ? `修改文件: ${detail.path}`
          : "修改文件";
    const request: AgentPermissionRequest = {
      id: `permission-${itemId}`,
      kind: "tool",
      description,
      detail: JSON.stringify(detail),
      raw: params,
    };
    return new Promise((resolve) => {
      this.pendingPermissionResolvers.set(request.id, { method: kind, resolve, request });
      this.emit({
        type: "permission_requested",
        provider: "codex",
        request,
        turnId: this.activeTurnId ?? undefined,
      });
    });
  }

  private handleUserInputRequest(params: unknown): Promise<unknown> {
    const parsed = toObjectRecord(params);
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const description =
      questions.length > 0
        ? questions.map((q) => readString(q, "question") ?? "").filter(Boolean).join("\n")
        : "Codex 请求用户输入";
    const request: AgentPermissionRequest = {
      id: `user-input-${Date.now()}`,
      kind: "question",
      description: description || "请提供输入",
      raw: params,
    };
    return new Promise((resolve) => {
      this.pendingPermissionResolvers.set(request.id, { method: "userInput", resolve, request });
      this.emit({
        type: "permission_requested",
        provider: "codex",
        request,
        turnId: this.activeTurnId ?? undefined,
      });
    });
  }

  private handleNotification(method: string, params: unknown): void {
    const p = toObjectRecord(params);
    switch (method) {
      case "thread/started": {
        const thread = toObjectRecord(p.thread);
        const threadId = readString(thread, "id");
        if (threadId) {
          this.currentThreadId = threadId;
          this.emit({ type: "thread_started", sessionId: threadId, provider: "codex" });
        }
        break;
      }
      case "turn/started": {
        // 记录真实 turn id（turn/interrupt 必须与活动 turn 匹配），并补发 turn_started
        const turn = toObjectRecord(p.turn);
        const realTurnId = readString(turn, "id");
        if (realTurnId) {
          this.activeTurnId = realTurnId;
          this.emit({ type: "turn_started", provider: "codex", turnId: realTurnId });
        }
        break;
      }
      case "turn/completed": {
        const turn = toObjectRecord(p.turn);
        const status = readString(turn, "status");
        const turnId = this.activeTurnId;
        if (!turnId) {
          break; // 已被 interrupt()/close 结算
        }
        if (status === "failed") {
          this.emit({
            type: "turn_failed",
            provider: "codex",
            error: readString(turn, "errorMessage") ?? "Codex turn failed",
            turnId,
          });
        } else if (status === "interrupted") {
          this.emit({ type: "turn_canceled", provider: "codex", reason: "interrupted", turnId });
        } else {
          this.emit({ type: "turn_completed", provider: "codex", usage: this.lastUsage, turnId });
        }
        this.activeTurnId = null;
        break;
      }
      case "item/agentMessage/delta":
      case "codex/event/agentMessage/delta": {
        const text = readString(p, "delta");
        if (text) {
          this.streamingAssistantText += text;
          this.emitTimeline({ type: "assistant_message", text: this.streamingAssistantText });
        }
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const text = readString(p, "delta") ?? readString(toObjectRecord(p.item), "text");
        if (text) {
          this.emitTimeline({ type: "reasoning", text });
        }
        break;
      }
      case "codex/event/item_started":
      case "item/started": {
        const item = toObjectRecord(p.item);
        const itemId = readString(item, "id");
        const itemType = readString(item, "type");
        if (itemId && itemType && isCodexToolItem(itemType)) {
          this.handleItemStarted(itemId, itemType, item, p);
        }
        break;
      }
      case "codex/event/item_completed":
      case "item/completed": {
        const item = toObjectRecord(p.item);
        const itemId = readString(item, "id");
        const itemType = readString(item, "type");
        if (itemId && itemType) {
          if (itemType === "agentMessage") {
            // 无 delta 时（如缓存命中），用完整文本补发一条 assistant_message
            const text = readString(item, "text");
            if (text && text !== this.streamingAssistantText) {
              this.streamingAssistantText = text;
              this.emitTimeline({ type: "assistant_message", text });
            }
          } else if (isCodexToolItem(itemType)) {
            this.handleItemCompleted(itemId, itemType, item, p);
          }
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = toObjectRecord(p.tokenUsage);
        const total = toObjectRecord(tokenUsage.total);
        this.lastUsage = {
          inputTokens: numOrUndefined(total.inputTokens),
          outputTokens: numOrUndefined(total.outputTokens),
        };
        break;
      }
      default:
        break;
    }
  }

  private handleItemStarted(
    itemId: string,
    itemType: string,
    item: Record<string, unknown>,
    params: Record<string, unknown>,
  ): void {
    const detail = mapCodexItemDetail(itemType, item);
    const name = mapCodexItemName(itemType, detail);
    this.activeToolCalls.set(itemId, { name, callId: itemId, detail });
    this.emitTimeline({ type: "tool_call", callId: itemId, name, detail, status: "running" });
  }

  private handleItemCompleted(
    itemId: string,
    itemType: string,
    item: Record<string, unknown>,
    params: Record<string, unknown>,
  ): void {
    const tracked = this.activeToolCalls.get(itemId);
    const detail = tracked?.detail ?? mapCodexItemDetail(itemType, item);
    const name = tracked?.name ?? itemType;
    const isError =
      readString(item, "errorMessage") !== undefined ||
      readString(item, "error") !== undefined ||
      readString(params, "errorMessage") !== undefined;
    this.activeToolCalls.delete(itemId);
    this.emitTimeline({
      type: "tool_call",
      callId: itemId,
      name,
      detail,
      status: isError ? "failed" : "completed",
    });
  }

  private emitTimeline(item: AgentTimelineItem): void {
    this.emit({ type: "timeline", item, provider: "codex", turnId: this.activeTurnId ?? undefined });
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

function readString(value: unknown, key: string): string | undefined {
  const record = isRecord(value) ? value : {};
  const found = record[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

/** 从 codex 文件变更审批请求中提取文件路径（params 顶层或 item 嵌套均可） */
function extractFilePath(params: unknown): string {
  const record = toObjectRecord(params);
  const item = toObjectRecord(record.item);
  return (
    readString(params, "filePath") ??
    readString(params, "path") ??
    readString(item, "filePath") ??
    readString(item, "path") ??
    ""
  );
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isCodexToolItem(itemType: string): boolean {
  return !["userMessage", "agentMessage", "reasoning"].includes(itemType);
}

function mapCodexItemName(itemType: string, detail: ToolCallDetail): string {
  if (itemType === "commandExecution") {
    return "shell";
  }
  if (itemType === "patchApply" || itemType === "fileChange") {
    return "apply_patch";
  }
  if (itemType === "plan") {
    return "plan";
  }
  if (itemType === "requestUserInput" || itemType === "userInput") {
    return "request_user_input";
  }
  return itemType;
}

function mapCodexItemDetail(itemType: string, item: Record<string, unknown>): ToolCallDetail {
  if (itemType === "commandExecution") {
    const command =
      readString(item, "command") ?? readString(item, "cmd") ?? readString(item, "scriptPath") ?? "";
    return { kind: "shell", command };
  }
  if (itemType === "patchApply" || itemType === "fileChange") {
    return { kind: "edit", path: readString(item, "cwd") ?? "" };
  }
  if (itemType === "plan") {
    const planText = readString(item, "text") ?? readString(item, "summary") ?? "";
    return { kind: "plan", text: planText };
  }
  if (itemType === "requestUserInput" || itemType === "userInput") {
    return { kind: "plain_text", text: "请求用户输入" };
  }
  return { kind: "unknown", raw: { itemType, item } };
}

function spawnAppServer(
  cwd: string | undefined,
  command?: [string, ...string[]],
): ChildProcessWithoutNullStreams {
  const [cmd = "codex", ...args] = command ?? ["codex"];
  // 防御：cwd 为空/无效时 spawn 会抛误导性的 ENOENT
  // （正常流程 resume/create 已在 agent-manager 校验回退，这里兜底直接调用方：回退默认目录后继续）
  const resolvedCwd = resolveCwd(cwd);
  let child: ChildProcess;
  try {
    child = spawnProcess(cmd, [...args, "app-server"], {
      cwd: resolvedCwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(codexNotFoundMessage(cmd));
    }
    throw error;
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Codex app-server was spawned without stdio streams");
  }
  return child as ChildProcessWithoutNullStreams;
}

/** 解析 codex 工作目录：无效/空值回退用户主目录（正常路径已由 agent-manager 保证有效） */
function resolveCwd(cwd: string | undefined): string {
  if (typeof cwd === "string" && cwd.length > 0 && existsSync(cwd) && statSync(cwd).isDirectory()) {
    return cwd;
  }
  console.warn(`[codex] 工作目录无效（${cwd ?? "(空)"}），已回退到默认目录 ${homedir()}`);
  return homedir();
}

/** spawn ENOENT 判定（同步 throw 与子进程 error 事件共用） */
function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** codex 可执行文件未找到 → 可读中文提示（替代裸 spawn codex ENOENT） */
function codexNotFoundMessage(commandName: string): string {
  return `未找到 ${commandName} 可执行文件，请确认已安装 codex CLI 或检查配置 providers.codex.command`;
}

/** spawn 失败（ENOENT 等）→ 可读中文提示；其余错误原样抛出 */
function toReadableSpawnError(error: unknown, commandName: string): Error {
  if (isEnoentError(error)) {
    return new Error(codexNotFoundMessage(commandName));
  }
  return error instanceof Error ? error : new Error(String(error));
}
