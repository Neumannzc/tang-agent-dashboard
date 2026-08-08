// 历史会话扫描/导入冒烟 CLI（无需 UI，直接调 history-import 模块）
// 用法:
//   tsx src/history-import-cli.ts scan pi codex claude opencode   # 扫描（只读）
//   tsx src/history-import-cli.ts import pi codex                 # 导入（写 store；幂等）
//   tsx src/history-import-cli.ts list                            # store 会话总数
//   tsx src/history-import-cli.ts resume <sessionId>              # resume 一个已导入会话

import type { AgentProvider } from "@agent-console/protocol";
import { AgentManager } from "./agent-manager.js";
import { importHistory, scanHistory } from "./history-import.js";
import { SessionStore } from "./session-store.js";

const KNOWN_PROVIDERS: AgentProvider[] = ["pi", "codex", "opencode", "claude"];

function parseProviders(args: string[]): AgentProvider[] {
  const providers = args.filter((a) => KNOWN_PROVIDERS.includes(a as AgentProvider)) as AgentProvider[];
  if (providers.length === 0) {
    console.error(`用法: tsx src/history-import-cli.ts <scan|import> ${KNOWN_PROVIDERS.join("|")} ...`);
    process.exit(1);
  }
  return providers;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new SessionStore();
  try {
    switch (cmd) {
      case "scan": {
        const providers = parseProviders(rest);
        const started = Date.now();
        const sessions = await scanHistory(providers, store);
        for (const provider of providers) {
          const list = sessions.filter((s) => s.provider === provider);
          const fresh = list.filter((s) => !s.imported).length;
          const gone = list.filter((s) => !s.recoverable).length;
          console.log(
            `[${provider}] 共 ${list.length} 条 · 新导入 ${fresh} · 已存在 ${list.length - fresh} · 不可恢复 ${gone}`,
          );
          for (const session of list.slice(0, 3)) {
            console.log(
              `    - ${session.title ?? "(无标题)"}  cwd=${session.cwd ?? "(无)"}  created=${new Date(session.createdAt).toISOString()}  imported=${session.imported}  recoverable=${session.recoverable}`,
            );
          }
        }
        console.log(`扫描耗时 ${Date.now() - started}ms`);
        break;
      }

      case "import": {
        const providers = parseProviders(rest);
        const result = await importHistory(providers, store);
        console.log(`导入完成: imported=${result.imported.length}, skipped=${result.skipped}`);
        for (const session of result.imported.slice(0, 3)) {
          console.log(
            `    - ${session.title ?? "(无标题)"}  provider=${session.provider}  sessionId=${session.sessionId}`,
          );
        }
        // 再次导入应全跳过（幂等）
        const again = await importHistory(providers, store);
        console.log(`再次导入（幂等检查）: imported=${again.imported.length}, skipped=${again.skipped}`);
        break;
      }

      case "list": {
        const all = store.list();
        console.log(`store 会话总数: ${all.length}`);
        for (const session of all.slice(0, 5)) {
          console.log(
            `    - ${session.title ?? "(无标题)"}  provider=${session.provider}  cwd=${session.cwd ?? "(无)"}`,
          );
        }
        break;
      }

      case "clean": {
        // 清除某 provider 的已导入会话（重新导入用）
        const providers = parseProviders(rest);
        let removed = 0;
        for (const session of store.list()) {
          if (providers.includes(session.provider as AgentProvider)) {
            store.remove(session.sessionId);
            removed += 1;
          }
        }
        console.log(`已清除 ${providers.join("/")} 会话行: ${removed}`);
        break;
      }

      case "resume": {
        const sessionId = rest[0];
        if (!sessionId) {
          console.error("用法: resume <sessionId>");
          process.exit(1);
        }
        const manager = new AgentManager(store);
        const summary = await manager.resumeSession(sessionId);
        console.log(
          `resume 成功: sessionId=${summary.sessionId} provider=${summary.provider} title=${summary.title ?? "(无)"} active=${summary.active}`,
        );
        await manager.closeSession(sessionId);
        await manager.shutdown();
        console.log("已关闭");
        break;
      }

      default:
        console.error(`未知命令: ${cmd}`);
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error("[history-import-cli] 失败:", error);
  process.exit(1);
});
