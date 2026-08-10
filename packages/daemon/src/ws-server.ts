// WS 中控服务：请求-响应 + 事件广播（Phase 3 daemon 侧）
// 独立监听 loopback 端口，不与 HTTP 服务器共存（HTTP 静态服务已迁移到 Electron 协议）

import { WebSocket, WebSocketServer } from "ws";
import type { ClientRequest, ClientResponse, RpcErrorCode } from "@agent-console/protocol";
import type { AgentManager } from "./agent-manager.js";

export interface WsServerOptions {
  port: number;
  host?: string;
}

class UnknownMethodError extends Error {
  readonly code: RpcErrorCode = "UNKNOWN_METHOD";
}

export class WsServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly portHint: number;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly readyPromise: Promise<void>;

  constructor(
    private readonly manager: AgentManager,
    private readonly options: WsServerOptions,
  ) {
    this.portHint = options.port;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.wss = new WebSocketServer({
      port: options.port,
      host: options.host ?? "127.0.0.1",
    });
    // 独立监听模式下，wss.on('listening') 比构造时的同步绑定更可依赖
    this.wss.on("listening", () => {
      this.readyResolve?.();
    });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    // 监听失败（如端口被占用）时 WSS 会同步 re-emit error，拒绝 ready 让上层明确报错退出
    this.wss.on("error", (error) => {
      console.error(`[ws-server] WebSocket 服务错误: ${error.message}`);
      this.readyReject?.(error);
    });
    // 全局事件 → 广播给所有 WS 客户端
    this.manager.onEvent((event) => {
      const push = {
        type: "agent.event" as const,
        sessionId: event.sessionId,
        event,
      };
      this.broadcast(push);
    });
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address ? address.port : this.portHint;
  }

  /** 等待端口就绪；监听失败（端口占用等）时 reject */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  async close(): Promise<void> {
    for (const socket of this.clients) {
      socket.close(1001, "server shutting down");
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("message", (data) => {
      void this.handleMessage(socket, data.toString()).catch((error) => {
        this.send(socket, {
          id: -1,
          ok: false,
          code: "INTERNAL",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let request: ClientRequest & { id: number };
    try {
      request = JSON.parse(raw);
    } catch {
      this.send(socket, { id: -1, ok: false, code: "INVALID_JSON", error: "invalid JSON" });
      return;
    }
    if (typeof request.id !== "number" || typeof request.method !== "string") {
      this.send(socket, { id: -1, ok: false, code: "INVALID_REQUEST", error: "missing id or method" });
      return;
    }
    try {
      const result = await this.dispatch(request);
      this.send(socket, { id: request.id, ok: true, result });
    } catch (error) {
      this.send(socket, {
        id: request.id,
        ok: false,
        code: error instanceof UnknownMethodError ? error.code : "INTERNAL",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatch(request: ClientRequest): Promise<unknown> {
    switch (request.method) {
      case "providers.list":
        return { providers: this.manager.listProviders() };

      case "agent.create": {
        const summary = await this.manager.createSession({
          provider: request.params.provider,
          cwd: request.params.cwd,
          ...(request.params.model ? { model: request.params.model } : {}),
          ...(request.params.modeId ? { modeId: request.params.modeId } : {}),
          ...(request.params.thinkingOptionId ? { thinkingOptionId: request.params.thinkingOptionId } : {}),
          ...(request.params.systemPrompt ? { systemPrompt: request.params.systemPrompt } : {}),
        });
        return summary;
      }

      case "agent.prompt": {
        const result = await this.manager.prompt(request.params.sessionId, request.params.prompt);
        return result;
      }

      case "agent.interrupt":
        await this.manager.interrupt(request.params.sessionId);
        return { interrupted: true };

      case "agent.close": {
        await this.manager.closeSession(request.params.sessionId);
        // 通知所有客户端（桌面壳 + 浏览器多端同步）
        this.broadcast({ type: "agent.closed", sessionId: request.params.sessionId });
        return { closed: true };
      }

      case "agent.modes": {
        const modes = await this.manager.getModes(request.params.sessionId);
        return { modes };
      }

      case "agent.model.set": {
        await this.manager.setModel(request.params.sessionId, request.params.modelId);
        return { model: request.params.modelId };
      }

      case "agent.thinking.set": {
        await this.manager.setThinkingOption(request.params.sessionId, request.params.thinkingOptionId);
        return { thinkingOptionId: request.params.thinkingOptionId };
      }

      case "agent.permission.respond":
        await this.manager.respondToPermission(request.params.sessionId, request.params.requestId, {
          behavior: request.params.behavior,
          ...(request.params.value !== undefined ? { value: request.params.value } : {}),
          ...(request.params.interrupt !== undefined ? { interrupt: request.params.interrupt } : {}),
        });
        return { responded: true };

      case "agent.models": {
        const models = await this.manager.fetchModels(request.params.provider);
        return { models };
      }

      case "sessions.list":
        return { sessions: this.manager.listSessions() };

      case "sessions.scanHistory": {
        const sessions = await this.manager.scanHistory(request.params.providers);
        return { sessions };
      }

      case "sessions.importHistory": {
        const { imported, skipped } = await this.manager.importHistory(request.params.providers);
        return { imported, skipped };
      }

      case "session.resume": {
        const summary = await this.manager.resumeSession(
          request.params.sessionId,
          request.params.cwd,
        );
        return summary;
      }

      default:
        throw new UnknownMethodError(`未知方法: ${(request as { method: string }).method}`);
    }
  }

  private send(socket: WebSocket, response: ClientResponse): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(response));
    } catch (error) {
      // 发送竞态（socket 刚好关闭等）不应冒泡到事件回调链
      console.warn(`[ws-server] 发送响应失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private broadcast(push: unknown): void {
    const payload = JSON.stringify(push);
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch (error) {
          console.warn(`[ws-server] 广播失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}
