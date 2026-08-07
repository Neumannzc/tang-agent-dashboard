// Codex app-server 的自定义 JSON-RPC 传输（裁剪自 Paseo codex/app-server-transport.ts）
// 三种帧：请求（客户端处理并回复）、响应（配对请求）、通知（服务端推送事件）

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { terminateWithTreeKill } from "../../tree-kill.js";

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const STDERR_BUFFER_LIMIT = 8192;

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RequestHandler = (params: unknown, requestId: number) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;
type UnexpectedTerminationHandler = (error: Error) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return isRecord(msg) && typeof msg.id === "number";
}

function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  return isRecord(msg) && typeof msg.id === "number" && typeof msg.method === "string";
}

function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  return isRecord(msg) && typeof msg.method === "string" && msg.id === undefined;
}

export class CodexAppServerClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private unexpectedTerminationHandler: UnexpectedTerminationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line).catch((error) => {
        this.stderrBuffer += `\n${String(error)}`;
      });
    });

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });

    child.on("error", (err) => {
      this.handleUnexpectedTermination(err);
    });

    child.on("exit", (code, signal) => {
      const message =
        code === 0 && !signal
          ? "Codex app-server exited"
          : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
      this.handleUnexpectedTermination(new Error(`${message}\n${this.stderrBuffer}`.trim()));
    });
  }

  setUnexpectedTerminationHandler(handler: UnexpectedTerminationHandler): void {
    this.unexpectedTerminationHandler = handler;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    const payload: JsonRpcNotification = { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unexpectedTerminationHandler = null;
    this.rl.close();
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
    });
  }

  private handleUnexpectedTermination(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rl.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const handler = this.unexpectedTerminationHandler;
    this.unexpectedTerminationHandler = null;
    if (!handler) {
      return;
    }
    try {
      handler(error);
    } catch {
      // ignore
    }
  }

  private writeJsonRpcResponse(response: JsonRpcResponse): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch {
      // ignore
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }

    if (!isRecord(raw)) {
      return;
    }

    if (isJsonRpcResponse(raw)) {
      if (raw.result !== undefined || raw.error) {
        const pending = this.pending.get(raw.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(raw.id);
        if (raw.error) {
          pending.reject(new Error(raw.error.message ?? "Unknown error"));
        } else {
          pending.resolve(raw.result);
        }
        return;
      }
      if (isJsonRpcRequest(raw)) {
        const handler = this.requestHandlers.get(raw.method);
        try {
          const result = handler ? await handler(raw.params, raw.id) : {};
          this.writeJsonRpcResponse({ id: raw.id, result });
        } catch (error) {
          this.writeJsonRpcResponse({
            id: raw.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
        return;
      }
    }

    if (isJsonRpcNotification(raw)) {
      this.notificationHandler?.(raw.method, raw.params);
    }
  }
}
