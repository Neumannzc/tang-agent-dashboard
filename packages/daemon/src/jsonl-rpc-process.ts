// JSONL-over-stdio RPC 子进程（参考 Paseo jsonl-rpc-process.ts，精简）

import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "./spawn.js";
import { terminateWithTreeKill } from "./tree-kill.js";

/** 控制面短请求默认超时 */
export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
/** 长阻塞请求（如 compact）不设墙钟超时 */
export const JSONL_RPC_NO_TIMEOUT = null;

const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug?: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void };
  diagnosticName?: string;
  spawn?: (launch: JsonlRpcLaunch) => ChildProcessWithoutNullStreams;
}

export interface JsonlRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

function assertChildWithPipes(child: ChildProcess): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSONL RPC process was spawned without stdio streams");
  }
}

const noopLogger = {
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
};

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageSubscribers = new Set<(message: Record<string, unknown>) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonlRpcExit) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private stdoutBuffer = "";
  private readonly logger: NonNullable<JsonlRpcProcessOptions["logger"]>;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.logger = options.logger ?? noopLogger;
    const child = (options.spawn ?? spawnJsonlRpcProcess)(options.launch);
    this.child = child;
    child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onMessage(callback: (message: Record<string, unknown>) => void): () => void {
    this.messageSubscribers.add(callback);
    return () => {
      this.messageSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonlRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  startRequest(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(timeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out for ${command.type}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.disposed) return;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // ignore cleanup races
    }
    await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.logger.warn({ error, line }, `Ignoring non-JSON ${this.diagnosticName} stdout line`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === "response") {
      this.handleResponse(message as unknown as { id?: string; success?: boolean; data?: unknown; error?: string });
      return;
    }
    for (const subscriber of this.messageSubscribers) {
      subscriber(message);
    }
  }

  private handleResponse(response: { id?: string; success?: boolean; data?: unknown; error?: string }): void {
    if (!response.id) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(
        new Error(response.error ?? `${this.diagnosticName} request failed`),
      );
      return;
    }
    pending.resolve(response.data);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function spawnJsonlRpcProcess(launch: JsonlRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
  });
  assertChildWithPipes(child);
  return child;
}

function createRequestTimeout(
  timeoutMs: number | null,
  onTimeout: () => void,
): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}
