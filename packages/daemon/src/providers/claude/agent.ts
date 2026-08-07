// Claude agent：AgentClient / AgentSession 实现
// 使用 @anthropic-ai/claude-agent-sdk 的 query()，canUseTool 桥接权限

import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
import { randomUUID } from "node:crypto";
import { isCommandAvailable } from "../../executable-resolution.js";
import { readCwd } from "../../session-utils.js";
import { runProviderTurn } from "../../provider-runner.js";

const CLAUDE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsMcpServers: true,
  supportsToolInvocations: true,
  supportsReasoningStream: true,
  supportsDynamicModes: true,
};

/** 强度档位标签（SDK ModelInfo.supportedEffortLevels 的展示名） */
const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function buildClaudeThinkingOptions(levels: readonly string[]): AgentSelectOption[] {
  const preferredDefault = levels.includes("medium") ? "medium" : levels[0];
  return levels.map((level) => ({
    id: level,
    label: CLAUDE_EFFORT_LABELS[level] ?? level,
    ...(level === preferredDefault ? { isDefault: true } : {}),
  }));
}

/** claude 运行时列表失败时的兜底（别名始终有效） */
const CLAUDE_FALLBACK_MODELS: AgentModelDefinition[] = [
  { id: "sonnet", label: "Claude Sonnet", provider: "claude" },
  { id: "opus", label: "Claude Opus", provider: "claude" },
  { id: "haiku", label: "Claude Haiku", provider: "claude" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

interface PendingPermission {
  resolve: (value: PermissionResult) => void;
  request: AgentPermissionRequest;
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ClaudeAgentSession(config);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const sessionId = handle.nativeHandle;
    if (!sessionId) {
      throw new Error("Claude resume requires a session id handle");
    }
    const config: AgentSessionConfig = {
      provider: "claude",
      cwd: readCwd(handle, overrides),
      ...overrides,
    };
    // console 侧会话 id 保持稳定（首次创建时的 id）：store/UI 都用它做 key，
    // 恢复出的会话不能换 id，否则 manager 注册与 timeline 全部错位
    const consoleSessionId =
      typeof handle.metadata?.consoleSessionId === "string"
        ? handle.metadata.consoleSessionId
        : undefined;
    return new ClaudeAgentSession(config, sessionId, consoleSessionId);
  }

  async fetchModels(): Promise<AgentModelDefinition[]> {
    // 起一个空 prompt 会话拿到 init 握手后即可调 supportedModels()，
    // 不发送实际 prompt，不消耗 token；列表反映用户真实环境（env/代理/设置）
    const claudeQuery = query({
      prompt: "",
      options: {
        cwd: process.cwd(),
        permissionMode: "default",
        includePartialMessages: false,
      },
    });
    const timeout = setTimeout(() => {
      void claudeQuery.return().catch(() => undefined);
    }, 20_000);
    try {
      for await (const message of claudeQuery) {
        if (message.type === "system" && message.subtype === "init") {
          break;
        }
        if (message.type === "result") {
          break;
        }
      }
      const models = await claudeQuery.supportedModels();
      if (!Array.isArray(models) || models.length === 0) {
        return CLAUDE_FALLBACK_MODELS;
      }
      return models.map((model) => ({
        id: model.value,
        label: model.displayName,
        provider: "claude",
        description: model.description || undefined,
        ...(model.supportsEffort && model.supportedEffortLevels?.length
          ? {
              thinkingOptions: buildClaudeThinkingOptions(model.supportedEffortLevels),
              defaultThinkingOptionId: model.supportedEffortLevels.includes("medium")
                ? "medium"
                : model.supportedEffortLevels[0],
            }
          : {}),
      }));
    } catch {
      return CLAUDE_FALLBACK_MODELS;
    } finally {
      clearTimeout(timeout);
      await claudeQuery.return().catch(() => undefined);
    }
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable("claude");
  }
}

export class ClaudeAgentSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly id: string;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly abortController = new AbortController();
  private query: Query | null = null;
  private activeTurnId: string | null = null;
  private streamConsumption: Promise<void> | null = null;
  private sessionId: string;
  /** 是否为 codex 返回的真实会话 id（首轮 system/init 之前是本地伪 id，不能用于恢复） */
  private realSessionId: boolean;
  private closed = false;

  constructor(
    private readonly config: AgentSessionConfig,
    resumeSessionId?: string,
    /** 首次创建时的 console 侧会话 id（resume 时保持稳定） */
    consoleSessionId?: string,
  ) {
    this.sessionId = resumeSessionId ?? `claude-${randomUUID()}`;
    this.realSessionId = Boolean(resumeSessionId);
    // console id 与 claude 原生 id 分离：原生 id 首轮后才知晓，console id 必须从头稳定
    this.id = consoleSessionId ?? this.sessionId;
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
      throw new Error("Claude session is closed");
    }
    const turnId = `claude-${Date.now()}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: "claude", turnId });

    const claudeQuery = query({
      prompt: promptToText(prompt),
      options: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId
          ? { effort: this.config.thinkingOptionId as "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
        ...(this.sessionId && !this.sessionId.startsWith("claude-")
          ? { resume: this.sessionId }
          : {}),
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool: (toolName, input, permissionOptions) =>
          this.handlePermissionRequest(toolName, input, permissionOptions),
        abortController: this.abortController,
      },
    });
    this.query = claudeQuery;
    this.streamConsumption = this.consumeQuery(claudeQuery, turnId);
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
    if (response.behavior === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({
        behavior: "deny",
        message: response.value ?? "Denied by user",
        ...(response.interrupt ? { interrupt: true } : {}),
      });
    }
    this.emit({
      type: "permission_resolved",
      provider: "claude",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.realSessionId) {
      // 首轮完成前不要落盘伪 id，否则 daemon 重启后 resume 必失败
      return null;
    }
    return {
      provider: "claude",
      nativeHandle: this.sessionId,
      metadata: { cwd: this.config.cwd, model: this.config.model, consoleSessionId: this.id },
    };
  }



  async interrupt(): Promise<void> {
    if (!this.query || !this.activeTurnId) {
      return;
    }
    const turnId = this.activeTurnId;
    // 先结算，避免流消费侧（consumeQuery/result）再发终态事件
    this.activeTurnId = null;
    try {
      await this.query.interrupt();
    } finally {
      this.emit({
        type: "turn_canceled",
        provider: "claude",
        reason: "interrupted",
        turnId,
      });
    }
  }

  async setModel(modelId: string): Promise<void> {
    // 模型在 query options 里按回合生效，更新 config 供后续回合使用
    this.config.model = modelId;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    // effort 在 query options 里按回合生效，更新 config 供后续回合使用
    this.config.thinkingOptionId = thinkingOptionId ?? undefined;
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
        provider: "claude",
        reason: "session closed",
        turnId,
      });
    }
    this.abortController.abort();
    if (this.query) {
      try {
        await this.query.return();
      } catch {
        // ignore
      }
    }
    if (this.streamConsumption) {
      await this.streamConsumption.catch(() => undefined);
    }
    this.subscribers.clear();
  }

  private handlePermissionRequest: CanUseTool = async (toolName, input, options) => {
    const requestId = `permission-${randomUUID()}`;
    const kind = toolName === "ExitPlanMode" ? "plan" : "tool";
    const request: AgentPermissionRequest = {
      id: requestId,
      kind,
      description: options.title ?? describeClaudePermission(toolName, input),
      detail: kind === "tool" ? JSON.stringify(input) : typeof input.plan === "string" ? (input.plan as string).slice(0, 2000) : undefined,
      raw: { toolName, input },
    };

    this.emit({
      type: "permission_requested",
      provider: "claude",
      request,
      turnId: this.activeTurnId ?? undefined,
    });

    return await new Promise<PermissionResult>(
      (resolve, reject) => {
        const abortHandler = () => {
          this.pendingPermissions.delete(requestId);
          reject(new Error("Permission request aborted"));
        };
        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
        this.pendingPermissions.set(requestId, { resolve, request });
      },
    );
  };

  private async consumeQuery(claudeQuery: Query, turnId: string): Promise<void> {
    // 流式事件缓冲：text / thinking / tool_use
    const buffers = new Map<number, { kind: string; text?: string; json?: string; name?: string }>();
    try {
      for await (const message of claudeQuery) {
        this.handleSdkMessage(message, turnId, buffers);
      }
    } catch (error) {
      if (!this.abortController.signal.aborted && this.activeTurnId) {
        this.emit({
          type: "turn_failed",
          provider: "claude",
          error: error instanceof Error ? error.message : String(error),
          turnId,
        });
        this.activeTurnId = null;
      }
    }
  }

  private handleSdkMessage(
    message: SDKMessage,
    turnId: string,
    buffers: Map<number, { kind: string; text?: string; json?: string; name?: string }>,
  ): void {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init" && message.session_id) {
          this.sessionId = message.session_id;
          this.realSessionId = true;
          this.emit({ type: "thread_started", sessionId: message.session_id, provider: "claude" });
        }
        break;
      }
      case "stream_event": {
        const event = message.event;
        if (event.type === "content_block_start") {
          const block = event.content_block as unknown as Record<string, unknown>;
          if (block.type === "text" || block.type === "thinking") {
            buffers.set(event.index, { kind: block.type, text: "" });
          } else if (block.type === "tool_use") {
            buffers.set(event.index, {
              kind: "tool_use",
              json: "",
              name: typeof block.name === "string" ? block.name : "tool",
            });
            const callId = typeof block.id === "string" ? block.id : `tool-${event.index}`;
            this.emitTimeline({
              type: "tool_call",
              callId,
              name: typeof block.name === "string" ? block.name : "tool",
              detail: { kind: "unknown", raw: {} },
              status: "running",
            });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as unknown as Record<string, unknown>;
          const buffer = buffers.get(event.index);
          if (!buffer) {
            break;
          }
          if (buffer.kind === "text" && delta.type === "text_delta") {
            buffer.text = (buffer.text ?? "") + (typeof delta.text === "string" ? delta.text : "");
            this.emitTimeline({ type: "assistant_message", text: buffer.text });
          } else if (buffer.kind === "thinking" && delta.type === "thinking_delta") {
            buffer.text = (buffer.text ?? "") + (typeof delta.thinking === "string" ? delta.thinking : "");
            this.emitTimeline({ type: "reasoning", text: buffer.text.slice(-200) });
          } else if (buffer.kind === "tool_use" && delta.type === "input_json_delta") {
            buffer.json = (buffer.json ?? "") + (typeof delta.partial_json === "string" ? delta.partial_json : "");
          }
        }
        break;
      }
      case "assistant": {
        const content = Array.isArray(message.message.content)
          ? (message.message.content as unknown as Array<Record<string, unknown>>)
          : [];
        const text = content
          .filter((block) => block.type === "text")
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .join("");
        if (text) {
          this.emitTimeline({ type: "assistant_message", text });
        }
        // 完成的工具调用
        for (const block of content) {
          const toolBlock = block as { type?: string; id?: string; name?: string; input?: unknown };
          if (toolBlock.type === "tool_use" && toolBlock.id) {
            const name = toolBlock.name ?? "tool";
            this.emitTimeline({
              type: "tool_call",
              callId: toolBlock.id,
              name,
              detail: mapClaudeToolDetail(name, toolBlock.input),
              status: "completed",
            });
          }
        }
        break;
      }
      case "result": {
        const usage = {
          ...(typeof message.total_cost_usd === "number" ? { totalCostUsd: message.total_cost_usd } : {}),
          ...(isRecord(message.usage)
            ? {
                inputTokens: typeof message.usage.input_tokens === "number" ? message.usage.input_tokens : undefined,
                outputTokens: typeof message.usage.output_tokens === "number" ? message.usage.output_tokens : undefined,
              }
            : {}),
        };
        if (this.activeTurnId !== turnId) {
          break; // 已被 interrupt()/close 结算
        }
        if (message.subtype === "success") {
          this.emit({ type: "turn_completed", provider: "claude", usage, turnId });
        } else {
          this.emit({
            type: "turn_failed",
            provider: "claude",
            error: message.errors?.[0]?.slice(0, 500) ?? "Claude turn failed",
            turnId,
          });
        }
        if (this.activeTurnId === turnId) {
          this.activeTurnId = null;
        }
        break;
      }
      default:
        break;
    }
  }

  private emitTimeline(item: AgentTimelineItem): void {
    this.emit({ type: "timeline", item, provider: "claude", turnId: this.activeTurnId ?? undefined });
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

function describeClaudePermission(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `运行命令: ${typeof input.command === "string" ? input.command : ""}`;
    case "Read":
      return `读取文件: ${typeof input.file_path === "string" ? input.file_path : ""}`;
    case "Edit":
      return `编辑文件: ${typeof input.file_path === "string" ? input.file_path : ""}`;
    case "Write":
      return `写入文件: ${typeof input.file_path === "string" ? input.file_path : ""}`;
    case "WebFetch":
      return `访问网络: ${typeof input.url === "string" ? input.url : ""}`;
    case "ExitPlanMode":
      return "查看并确认实施计划";
    default:
      return `使用工具: ${toolName}`;
  }
}

function mapClaudeToolDetail(name: string, input: unknown): ToolCallDetail {
  const record = isRecord(input) ? input : {};
  switch (name) {
    case "Bash":
      return { kind: "shell", command: typeof record.command === "string" ? record.command : "" };
    case "Read":
      return { kind: "read", path: typeof record.file_path === "string" ? record.file_path : "" };
    case "Edit":
      return { kind: "edit", path: typeof record.file_path === "string" ? record.file_path : "" };
    case "Write":
      return { kind: "write", path: typeof record.file_path === "string" ? record.file_path : "" };
    case "WebFetch":
      return { kind: "fetch", url: typeof record.url === "string" ? record.url : "" };
    case "Grep":
      return { kind: "search", query: typeof record.pattern === "string" ? record.pattern : "" };
    default:
      return { kind: "unknown", raw: input };
  }
}
