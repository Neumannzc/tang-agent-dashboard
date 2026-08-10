// 会话编排：创建/恢复/中断/销毁 + 事件扇出（Phase 2）

import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  HistorySession,
} from "@agent-console/protocol";
import type { SessionSummary } from "@agent-console/protocol";
import { createClient, isKnownProvider, listProviders } from "./providers/index.js";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { ConsoleConfig, ProviderConfig } from "./config.js";
import type { SessionStore, StoredSession } from "./session-store.js";
import { importHistory, scanHistory } from "./history-import.js";

export type ManagedSessionEvent = AgentStreamEvent & { sessionId: string };

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly subscribers = new Set<(event: ManagedSessionEvent) => void>();
  private readonly running = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    private readonly config: ConsoleConfig = {},
    private readonly clientFactory: (provider: string, providerConfig?: ProviderConfig) => AgentClient | null = createClient,
  ) {}

  onEvent(callback: (event: ManagedSessionEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  listProviders(): string[] {
    return listProviders().filter((provider) => this.config.providers?.[provider as AgentProvider]?.enabled !== false);
  }

  listSessions(): SessionSummary[] {
    return this.store.list().map((stored) => this.toSummary(stored));
  }

  /** 扫描 agent 本地历史会话（只读；与 store 去重标记 imported） */
  async scanHistory(providers: AgentProvider[]): Promise<HistorySession[]> {
    return scanHistory(providers, this.store);
  }

  /** 导入 agent 本地历史会话（未导入过的；幂等） */
  async importHistory(providers: AgentProvider[]): Promise<{ imported: SessionSummary[]; skipped: number }> {
    const { imported, skipped } = await importHistory(providers, this.store);
    return { imported: imported.map((summary) => this.toSummary(summary)), skipped };
  }

  async createSession(config: AgentSessionConfig): Promise<SessionSummary> {
    const client = await this.getClient(config.provider);
    if (!(await client.isAvailable())) {
      throw new Error(`provider 不可用: ${config.provider}（未找到可执行文件或依赖缺失）`);
    }
    // 明确校验 cwd，避免 spawn 时报误导性的 ENOENT
    if (!config.cwd || !existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
      throw new Error(`目录不存在或不可用: ${config.cwd ?? "(空)"}`);
    }
    const session = await client.createSession(config);
    return this.register(session, config);
  }

  async resumeSession(sessionId: string, cwd?: string): Promise<SessionSummary> {
    const stored = this.store.get(sessionId);
    if (!stored?.handle) {
      throw new Error(`未找到可恢复的会话: ${sessionId}`);
    }
    const client = await this.getClient(stored.provider as AgentProvider);
    // 导入的历史会话其 cwd 可能来自已删除的目录（spawn 会抛误导性的 ENOENT）。
    // 校验存在性，无效则逐级回退；warning 里保留原始失效路径便于排查。
    const resolvedCwd = resolveResumeCwd(stored.cwd, cwd, this.config.defaultCwd);
    const config: AgentSessionConfig = {
      provider: stored.provider as AgentProvider,
      cwd: resolvedCwd,
      ...(stored.model ? { model: stored.model } : {}),
      ...(stored.modeId ? { modeId: stored.modeId } : {}),
      ...(stored.thinkingOptionId ? { thinkingOptionId: stored.thinkingOptionId } : {}),
      ...(stored.systemPrompt ? { systemPrompt: stored.systemPrompt } : {}),
    };
    const session = await client.resumeSession(stored.handle, config);
    this.store.put({
      sessionId,
      provider: stored.provider,
      cwd: config.cwd,
      model: config.model,
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      systemPrompt: config.systemPrompt,
      title: stored.title,
      createdAt: stored.createdAt,
      handle: stored.handle,
    });
    return this.register(session, config, stored.createdAt, stored.title);
  }

  async prompt(sessionId: string, prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const session = this.getSession(sessionId);
    // 同一会话不允许并发回合：多个 runProviderTurn 订阅同一事件流会互相
    // 污染 timeline，且一个回合的终态事件会错误结算另一个回合
    if (this.running.has(sessionId)) {
      throw new Error("会话正在运行中，请先中断或等待完成");
    }
    this.running.add(sessionId);
    try {
      this.store.touch(sessionId);
      return await session.run(prompt, options);
    } finally {
      this.running.delete(sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.getSession(sessionId).interrupt();
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    await this.getSession(sessionId).respondToPermission(requestId, response);
  }

  async getModes(sessionId: string): Promise<AgentMode[]> {
    const session = this.getSession(sessionId);
    return (await session.getAvailableModes?.()) ?? [];
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session.setModel) {
      throw new Error("当前 provider 不支持切换模型");
    }
    await session.setModel(modelId);
    // 持久化，daemon 重启后 resume 仍使用新模型
    const stored = this.store.get(sessionId);
    if (stored) {
      this.store.put({ ...stored, model: modelId });
    }
  }

  async setThinkingOption(sessionId: string, thinkingOptionId: string | null): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session.setThinkingOption) {
      throw new Error("当前 provider 不支持切换强度");
    }
    await session.setThinkingOption(thinkingOptionId);
    const stored = this.store.get(sessionId);
    if (stored) {
      this.store.put({
        ...stored,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      });
    }
  }

  async fetchModels(provider: AgentProvider): Promise<AgentModelDefinition[]> {
    const client = await this.getClient(provider);
    return (await client.fetchModels?.()) ?? [];
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    try {
      await session.close();
    } finally {
      this.emit({ sessionId, type: "turn_canceled", provider: session.provider, reason: "session closed" });
    }
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
    await Promise.allSettled([...this.clients.values()].map((client) => client.shutdown?.()));
  }

  private async getClient(provider: AgentProvider): Promise<AgentClient> {
    const existing = this.clients.get(provider);
    if (existing) {
      return existing;
    }
    if (!isKnownProvider(provider)) {
      throw new Error(`未知 provider: ${provider}`);
    }
    if (this.config.providers?.[provider]?.enabled === false) {
      throw new Error(`provider 已禁用: ${provider}`);
    }
    const client = this.clientFactory(provider, this.config.providers?.[provider] as ProviderConfig | undefined);
    if (!client) {
      throw new Error(`未知 provider: ${provider}`);
    }
    this.clients.set(provider, client);
    return client;
  }

  private getSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在或已关闭: ${sessionId}`);
    }
    return session;
  }

  private register(
    session: AgentSession,
    config: AgentSessionConfig,
    createdAt?: number,
    title?: string,
  ): SessionSummary {
    this.sessions.set(session.id, session);
    const handle = session.describePersistence();
    const summary: SessionSummary = {
      sessionId: session.id,
      provider: session.provider,
      cwd: config.cwd,
      model: config.model,
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      ...(title ? { title } : {}),
      createdAt: createdAt ?? Date.now(),
      active: true,
      ...(handle ? { handle } : {}),
    };
    this.store.put({
      sessionId: session.id,
      provider: session.provider,
      cwd: config.cwd,
      model: config.model,
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      systemPrompt: config.systemPrompt,
      ...(title ? { title } : {}),
      createdAt: summary.createdAt,
      ...(handle ? { handle } : {}),
    });
    session.subscribe((event) => {
      // 部分 provider（claude）的真实恢复句柄要等首轮（thread_started）才可用，
      // 此时回写 store，否则 handle 永远缺失导致无法 resume
      if (event.type === "thread_started") {
        const stored = this.store.get(session.id);
        const handle = session.describePersistence();
        if (stored && handle) {
          this.store.put({ ...stored, handle });
        }
      }
      this.emit({ sessionId: session.id, ...event });
    });
    return summary;
  }

  private emit(event: ManagedSessionEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /** StoredSession（或其子集）→ SessionSummary；active 以内存会话 map 为准 */
  private toSummary(stored: SessionLike): SessionSummary {
    return {
      sessionId: stored.sessionId,
      provider: stored.provider as AgentProvider,
      cwd: stored.cwd,
      model: stored.model,
      modeId: stored.modeId,
      thinkingOptionId: stored.thinkingOptionId,
      title: stored.title,
      createdAt: stored.createdAt,
      lastActiveAt: stored.lastActiveAt,
      active: this.sessions.has(stored.sessionId),
      handle: stored.handle,
    };
  }
}

/** StoredSession 与 SessionSummary 共有的展示字段 */
type SessionLike = Pick<
  StoredSession,
  "sessionId" | "provider" | "cwd" | "model" | "modeId" | "thinkingOptionId" | "title" | "createdAt" | "lastActiveAt" | "handle"
>;

/** 解析恢复会话的 cwd：requested → stored → config.defaultCwd → homedir()。
 *  每级校验存在且为目录；失效/空值记录 warning 并降级，避免 spawn 抛误导性 ENOENT。
 *  （GUI 启动的 daemon cwd 是启动目录，不算合理默认，故不用 process.cwd()） */
export function resolveResumeCwd(
  storedCwd: string | undefined,
  requestedCwd?: string,
  defaultCwd?: string,
): string {
  const levels: Array<{ label: string; path: string | undefined; requested?: boolean }> = [
    { label: "显式请求的工作目录", path: requestedCwd, requested: true },
    { label: "会话原工作目录", path: storedCwd },
    { label: "配置默认目录", path: defaultCwd },
  ];
  for (const { label, path, requested } of levels) {
    if (typeof path === "string" && path.length > 0) {
      if (existsSync(path) && statSync(path).isDirectory()) {
        return path;
      }
      console.warn(`[agent-manager] ${label}不存在或不可用（${path}），已回退到下一个默认目录`);
    } else if (requested && typeof path === "string") {
      // 显式请求了空串：同样视为无效请求，给出警告再降级
      console.warn(`[agent-manager] ${label}为空字符串，已回退到下一个默认目录`);
    }
  }
  return homedir();
}
