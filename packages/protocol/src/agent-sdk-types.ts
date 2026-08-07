// 共享类型：provider 抽象 + 事件流 + WS 协议
// 事件模型借鉴 Paseo 的 agent-sdk-types.ts，裁剪到本项目的需求

export type AgentProvider = "pi" | "codex" | "opencode" | "claude";

// ---------- 模型与模式 ----------

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
}

export interface AgentModelDefinition {
  id: string;
  label?: string;
  provider: AgentProvider;
  isDefault?: boolean;
  isSelectable?: boolean;
  contextWindow?: number;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

// ---------- 工具调用 ----------

export type ToolCallDetail =
  | { kind: "shell"; command: string }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string }
  | { kind: "write"; path: string }
  | { kind: "search"; query: string }
  | { kind: "fetch"; url: string }
  | { kind: "plan"; text: string }
  | { kind: "plain_text"; text: string }
  | { kind: "unknown"; raw: unknown };

// ---------- Timeline 与事件流 ----------

export interface ToolCallTimelineItem {
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  status: "running" | "completed" | "failed" | "canceled";
  error?: unknown;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string };

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage; turnId?: string }
  | { type: "turn_failed"; provider: AgentProvider; error: string; turnId?: string }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: AgentProvider; turnId?: string; timestamp?: string }
  | { type: "permission_requested"; provider: AgentProvider; request: AgentPermissionRequest; turnId?: string }
  | { type: "permission_resolved"; provider: AgentProvider; requestId: string; resolution: AgentPermissionResponse; turnId?: string }
  | { type: "mode_changed"; provider: AgentProvider; currentModeId: string | null; availableModes: AgentMode[] }
  | { type: "model_changed"; provider: AgentProvider; modelId: string; modelProvider?: string };

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

// ---------- 权限 ----------

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "other";

export interface AgentPermissionRequest {
  id: string;
  kind: AgentPermissionRequestKind;
  /** 一句话描述（如：运行 shell 命令 rm -rf ...） */
  description: string;
  /** 详情（命令文本 / 问题原文等） */
  detail?: string;
  /** provider 原始数据（用于高级展示） */
  raw?: unknown;
}

export interface AgentPermissionResponse {
  behavior: "allow" | "deny";
  /** 是否中断整个回合 */
  interrupt?: boolean;
  /** 附加内容（如问答题的答案） */
  value?: string;
}

// ---------- AgentClient / AgentSession 接口 ----------

export type AgentPromptInput = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export interface AgentRunOptions {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  modeId?: string;
  mcpServers?: Record<string, unknown>;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  /** 各 provider 自定义的恢复句柄（pi: JSONL session 文件；codex/opencode: 会话 id） */
  nativeHandle?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string;
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  getAvailableModes?(): Promise<AgentMode[]>;
  getCurrentMode?(): Promise<string | null>;
  setMode?(modeId: string): Promise<void>;
  setModel?(modelId: string): Promise<void>;
}

export interface AgentSlashCommand {
  name: string;
  description?: string;
  kind: "command" | "skill";
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession>;
  fetchModels?(): Promise<AgentModelDefinition[]>;
  isAvailable(): Promise<boolean>;
  shutdown?(): Promise<void>;
}

export interface AgentCapabilityFlags {
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsMcpServers: boolean;
  supportsToolInvocations: boolean;
  supportsReasoningStream: boolean;
  supportsDynamicModes: boolean;
}

export interface ProviderCatalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
  defaultModeId?: string | null;
}
