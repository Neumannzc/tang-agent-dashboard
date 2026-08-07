// 主题常量：provider 身份色（DESIGN-SYSTEM.md §4：品牌色与 agent 身份分离）

import type { AgentProvider } from "@agent-console/protocol";

export const PROVIDER_META: Record<string, { name: string; color: string; sub: string; models: string[] }> = {
  pi: { name: "Pi", color: "#7c5cd6", sub: "JSONL over stdio", models: [] },
  codex: { name: "Codex", color: "#4b54ff", sub: "app-server", models: [] },
  claude: { name: "Claude", color: "#b05a48", sub: "Agent SDK", models: [] },
  opencode: { name: "OpenCode", color: "#3f7f5f", sub: "serve + SDK", models: [] },
};

export function providerMeta(provider: string) {
  return PROVIDER_META[provider] ?? { name: provider, color: "#6e6e6e", sub: "", models: [] };
}

export function providerLabel(provider: AgentProvider | string): string {
  return providerMeta(provider).name;
}
