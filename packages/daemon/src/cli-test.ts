import type { AgentClient, AgentProvider, AgentSession, AgentStreamEvent } from "@agent-console/protocol";
import { createClient } from "./providers/index.js";

const KNOWN_PROVIDERS: AgentProvider[] = ["pi", "codex", "opencode", "claude"];

async function main() {
  const [providerArg, prompt, cwd, model] = process.argv.slice(2);
  if (!providerArg || !prompt || !cwd) {
    console.error("用法: tsx src/cli-test.ts <provider> <prompt> <cwd> [model]");
    process.exit(1);
  }

  const provider = KNOWN_PROVIDERS.includes(providerArg as AgentProvider)
    ? (providerArg as AgentProvider)
    : null;
  if (!provider) {
    console.error(`未知 provider: ${providerArg}`);
    process.exit(1);
  }

  const client = createClient(provider) as AgentClient | null;
  if (!client) {
    console.error(`未知 provider: ${provider}`);
    process.exit(1);
  }
  let session: AgentSession | undefined;
  console.log(`[cli-test] 创建 ${provider} 会话, cwd=${cwd}${model ? `, model=${model}` : ""}`);
  session = await client.createSession({ provider, cwd, ...(model ? { model } : {}) });

  const unsubscribe = session.subscribe((event: AgentStreamEvent) => {
    const line = formatEvent(event);
    if (line) {
      console.log(`[event] ${line}`);
    }
    // 冒烟测试：自动批准所有权限请求
    if (event.type === "permission_requested") {
      void session
        ?.respondToPermission(event.request.id, { behavior: "allow" })
        .catch((error) => console.error("[cli-test] 权限响应失败:", error));
    }
  });

  console.log(`[cli-test] 发送: ${prompt}`);
  const result = await session.run(prompt);
  console.log(`[cli-test] 完成. finalText=${JSON.stringify(result.finalText.slice(0, 200))}`);
  console.log(`[cli-test] timeline 条数=${result.timeline.length}`);

  unsubscribe();
  await session.close();
  console.log("[cli-test] 会话已关闭");
}

function formatEvent(event: AgentStreamEvent): string | null {
  switch (event.type) {
    case "turn_started":
      return `turn_started (${event.turnId ?? "-"})`;
    case "turn_completed":
      return `turn_completed usage=${JSON.stringify(event.usage)}`;
    case "turn_failed":
      return `turn_failed: ${event.error}`;
    case "turn_canceled":
      return `turn_canceled: ${event.reason}`;
    case "timeline": {
      const item = event.item;
      switch (item.type) {
        case "assistant_message":
          return `assistant: ${item.text.slice(-100).replace(/\n/g, " ")}`;
        case "reasoning":
          return `reasoning: ${item.text.slice(-60).replace(/\n/g, " ")}`;
        case "tool_call":
          return `tool_call: ${item.name} ${JSON.stringify(item.detail).slice(0, 120)} [${item.status}]`;
        case "error":
          return `error: ${item.message}`;
        default:
          return `timeline: ${item.type}`;
      }
    }
    case "permission_requested":
      return `permission_requested [${event.request.kind}]: ${event.request.description} (id=${event.request.id})`;
    case "permission_resolved":
      return `permission_resolved: ${event.requestId} → ${event.resolution.behavior}`;
    default:
      return null;
  }
}

main().catch((error) => {
  console.error("[cli-test] 失败:", error);
  process.exit(1);
});
