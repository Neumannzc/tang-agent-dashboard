// Agent Console Daemon 入口：常驻进程，持有 agent 子进程，暴露 HTTP(静态 UI) + WS 接口
// 用法: tsx src/index.ts [--port 8765]

import { createServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./agent-manager.js";
import { ensureConfigDir, loadConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
import { createStaticHandler } from "./static-server.js";
import { WsServer } from "./ws-server.js";

const DEFAULT_PORT = 8765;

function parseArgs(argv: string[]): { port: number | null } {
  let port: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") {
      const value = Number(argv[i + 1]);
      if (Number.isInteger(value) && value > 0 && value < 65536) {
        port = value;
      }
    }
  }
  return { port };
}

/** UI 构建产物目录：相对 daemon 源码/产物定位到 packages/ui/dist */
function resolveUiDist(): string | null {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist"),
    path.resolve(process.cwd(), "packages/ui/dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? null;
}

async function main(): Promise<void> {
  const cliPort = parseArgs(process.argv.slice(2)).port;
  const config = loadConfig();
  ensureConfigDir();
  const port = cliPort ?? config.wsPort ?? DEFAULT_PORT;

  const store = new SessionStore();
  const manager = new AgentManager(store, config);

  // HTTP 服务器：静态 UI + WS 同端口
  const uiDist = resolveUiDist();
  const handler = createStaticHandler({ distDir: uiDist ?? "packages/ui/dist", dev: !uiDist });
  const httpServer: HttpServer = createServer((req, res) => {
    handler(req, res);
  });
  const wsServer = new WsServer(manager, { port, server: httpServer });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });

  console.log(`[daemon] Agent Console daemon 已启动`);
  console.log(`[daemon] HTTP(UI) + WS 端口 = ${wsServer.port}`);
  if (uiDist) {
    console.log(`[daemon] UI 静态目录 = ${uiDist}`);
  } else {
    console.log(`[daemon] 未找到 UI 构建产物（packages/ui/dist），开发模式请用 npm run dev:ui`);
  }
  console.log(`[daemon] 已注册 provider: ${manager.listProviders().join(", ")}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[daemon] 收到 ${signal}，正在关闭...`);
    try {
      await wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await manager.shutdown();
      console.log("[daemon] 已关闭全部会话与子进程");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // 未捕获异常/拒绝兜底：先回收子进程再退出，避免 pi/codex 等成为孤儿
  process.on("uncaughtException", (error) => {
    console.error("[daemon] 未捕获异常:", error);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[daemon] 未处理的 Promise 拒绝:", reason);
  });
}

main().catch((error) => {
  console.error("[daemon] 启动失败:", error);
  process.exit(1);
});
