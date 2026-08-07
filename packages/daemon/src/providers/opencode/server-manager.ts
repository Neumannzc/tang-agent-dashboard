// OpenCode 长驻 server 管理（简化版，参考 Paseo opencode/server-manager.ts）
// 单例：首次使用时 spawn `opencode serve --port <port>`，多会话共享

import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { spawnProcess } from "../../spawn.js";
import { terminateWithTreeKill } from "../../tree-kill.js";

const STARTUP_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => void;
}

interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  ready: Promise<void>;
  killed?: boolean;
}

let instance: OpenCodeServerManager | null = null;
let configuredCommand: string[] | null = null;

export class OpenCodeServerManager {
  private current: OpenCodeServerGeneration | null = null;
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;

  static configure(command: string[]): void {
    configuredCommand = command;
  }

  static getInstance(): OpenCodeServerManager {
    if (!instance) {
      instance = new OpenCodeServerManager();
      // exit 处理器只能做同步操作：发 SIGTERM 兜底（daemon 的 manager.shutdown() 才是
      // 权威回收路径，会 await killServer；这里只覆盖未捕获异常等非优雅退出场景）
      process.on("exit", () => {
        const server = instance?.current;
        if (server) {
          try {
            server.process.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
      });
    }
    return instance;
  }

  async acquire(): Promise<OpenCodeServerAcquisition> {
    const server = await this.getCurrent();
    server.refCount += 1;
    let released = false;
    return {
      server: { port: server.port, url: server.url },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        server.refCount = Math.max(0, server.refCount - 1);
      },
    };
  }

  async shutdown(): Promise<void> {
    if (!this.current) {
      return;
    }
    const server = this.current;
    this.current = null;
    await this.killServer(server);
  }

  private getCurrent(): Promise<OpenCodeServerGeneration> {
    if (this.current && this.current.process.exitCode === null) {
      return this.current.ready.then(() => this.current!);
    }
    if (this.startPromise) {
      return this.startPromise.then((server) => server.ready.then(() => server));
    }
    this.startPromise = this.startServer().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise.then((server) => server.ready.then(() => server));
  }

  private async startServer(): Promise<OpenCodeServerGeneration> {
    const port = await findAvailablePort();
    const url = `http://127.0.0.1:${port}`;
    // 使用中性的 home 目录作为 server cwd，避免 opencode 把用户目录当 workspace 索引
    const serverCwd = path.join(homedir(), ".agent-console", "opencode-home");
    mkdirSync(serverCwd, { recursive: true });

    const serverProcess = spawnProcess(
      configuredCommand?.[0] ?? "opencode",
      [
        ...(configuredCommand && configuredCommand.length > 1 ? configuredCommand.slice(1) : []),
        "serve",
        "--port",
        String(port),
      ],
      {
        cwd: serverCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      ready: Promise.resolve(),
    };

    server.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        failStartup(
          new Error(
            `OpenCode server startup timeout\nstdout: ${stdoutBuffer}\nstderr: ${stderrBuffer}`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);

      const onListening = () => {
        if (settled) {
          return;
        }
        // “listening on” 打印后 HTTP 接口还需要片刻才能接受连接，轮询健康端点
        void pollUntilHealthy(url, () => settled).then(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve();
        });
      };

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer += output;
        if (output.includes("listening on")) {
          onListening();
        }
      });
      serverProcess.stderr?.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });
      serverProcess.on("error", (error) => {
        failStartup(error instanceof Error ? error : new Error(String(error)));
      });
      serverProcess.on("exit", (code, signal) => {
        if (server.killed) {
          return;
        }
        failStartup(
          new Error(
            `OpenCode server exited before ready with code ${code ?? "null"} and signal ${signal ?? "null"}\nstderr: ${stderrBuffer}`,
          ),
        );
      });
    });

    // 启动失败时回收进程，避免留下孤儿；失败已由 acquire 路径处理
    server.ready.catch(() => this.killServer(server));

    this.current = server;
    return server;
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.process.exitCode !== null && server.process.exitCode !== undefined) {
      return;
    }
    server.killed = true;
    await terminateWithTreeKill(server.process, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
    });
  }
}

async function pollUntilHealthy(url: string, isSettled: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (isSettled()) {
      return;
    }
    try {
      const response = await fetch(`${url}/health`, { method: "GET" });
      void response.body?.cancel();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}
