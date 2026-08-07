// daemon WS 客户端：请求-响应 + 事件推送

import type {
  AgentModelDefinition,
  AgentPermissionResponse,
  AgentProvider,
  AgentRunResult,
  ServerPush,
  SessionSummary,
} from "@agent-console/protocol";

export const DEFAULT_WS_URL = "ws://127.0.0.1:8765";

export class DaemonClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  onPush: (push: ServerPush) => void = () => undefined;
  /** 连接断开回调（被动断开时触发，主动 close() 不触发） */
  onClose: () => void = () => undefined;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url = DEFAULT_WS_URL): Promise<void> {
    return new Promise((resolve, reject) => {
      // 替换旧连接时先摘掉其回调，避免旧 socket 的 close 事件触发 onClose/重连
      const previous = this.ws;
      if (previous) {
        previous.onopen = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.onclose = null;
        try {
          previous.close();
        } catch {
          // ignore
        }
      }
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`无法连接 daemon: ${url}`));
      ws.onmessage = (event) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        this.handleMessage(msg);
      };
      ws.onclose = () => {
        this.rejectAll(new Error("与 daemon 的连接已断开"));
        this.onClose();
      };
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  // ---------- 类型化 RPC ----------

  providersList(): Promise<string[]> {
    return this.rpc<{ providers: string[] }>("providers.list").then((r) => r.providers);
  }

  createSession(params: { provider: AgentProvider; cwd: string; model?: string }): Promise<SessionSummary> {
    return this.rpc<SessionSummary>("agent.create", params);
  }

  resumeSession(sessionId: string): Promise<SessionSummary> {
    return this.rpc<SessionSummary>("session.resume", { sessionId });
  }

  sessionsList(): Promise<SessionSummary[]> {
    return this.rpc<{ sessions: SessionSummary[] }>("sessions.list").then((r) => r.sessions);
  }

  prompt(sessionId: string, prompt: string): Promise<AgentRunResult> {
    return this.rpc<AgentRunResult>("agent.prompt", { sessionId, prompt });
  }

  interrupt(sessionId: string): Promise<void> {
    return this.rpc("agent.interrupt", { sessionId }).then(() => undefined);
  }

  closeSession(sessionId: string): Promise<void> {
    return this.rpc("agent.close", { sessionId }).then(() => undefined);
  }

  models(provider: AgentProvider): Promise<AgentModelDefinition[]> {
    return this.rpc<{ models: AgentModelDefinition[] }>("agent.models", { provider }).then((r) => r.models);
  }

  setModel(sessionId: string, modelId: string): Promise<void> {
    return this.rpc("agent.model.set", { sessionId, modelId }).then(() => undefined);
  }

  respondPermission(sessionId: string, requestId: string, response: AgentPermissionResponse): Promise<void> {
    return this.rpc("agent.permission.respond", {
      sessionId,
      requestId,
      behavior: response.behavior,
      ...(response.value !== undefined ? { value: response.value } : {}),
      ...(response.interrupt !== undefined ? { interrupt: response.interrupt } : {}),
    }).then(() => undefined);
  }

  // ---------- 底层 ----------

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("未连接 daemon"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        // send 竞态（socket 恰好关闭）时清理 pending，避免泄漏
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      return;
    }
    const record = msg as Record<string, unknown>;
    if (typeof record.id === "number") {
      const pending = this.pending.get(record.id);
      if (!pending) {
        return;
      }
      this.pending.delete(record.id);
      if (record.ok) {
        pending.resolve(record.result);
      } else {
        pending.reject(new Error(typeof record.error === "string" ? record.error : "RPC 失败"));
      }
      return;
    }
    if (typeof record.type === "string") {
      this.onPush(record as unknown as ServerPush);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
