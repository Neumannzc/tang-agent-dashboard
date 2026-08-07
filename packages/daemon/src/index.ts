// Agent Console Daemon 入口：常驻进程，持有 agent 子进程，仅暴露 WS 接口
// UI 由 Electron 壳通过 tang-ai-chat://app/ 协议加载，daemon 不再服务 HTTP/静态资源
// 用法: tsx src/index.ts [--port 8765]

import { AgentManager } from "./agent-manager.js";
import { ensureConfigDir, loadConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
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

async function main(): Promise<void> {
  const cliPort = parseArgs(process.argv.slice(2)).port;
  const config = loadConfig();
  ensureConfigDir();
  const port = cliPort ?? config.wsPort ?? DEFAULT_PORT;

  const store = new SessionStore();
  const manager = new AgentManager(store, config);
  const wsServer = new WsServer(manager, { port, host: "127.0.0.1" });
  try {
    await wsServer.ready();
  } catch (error) {
    console.error(
      `[daemon] 启动失败：无法监听 ${port}（${error instanceof Error ? error.message : String(error)}）`,
    );
    console.error(`[daemon] 请确认端口 ${port} 未被其他进程占用后重试`);
    process.exit(1);
  }

  console.log(`[daemon] Tang Agent Dashboard daemon 已启动`);
  console.log(`[daemon] WS 端口 = ${wsServer.port} (loopback only)`);
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
