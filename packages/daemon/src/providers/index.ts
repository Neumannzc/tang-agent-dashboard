// provider 工厂：按 id 创建 AgentClient

import type { AgentClient, AgentProvider } from "@agent-console/protocol";
import type { ProviderConfig } from "../config.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex/agent.js";
import { OpenCodeAgentClient } from "./opencode/agent.js";
import { PiRpcAgentClient } from "./pi/agent.js";

export function createClient(
  provider: string,
  providerConfig?: ProviderConfig,
): AgentClient | null {
  const command = providerConfig?.command as [string, ...string[]] | undefined;
  switch (provider) {
    case "pi":
      return new PiRpcAgentClient({ ...(command ? { command } : {}) });
    case "codex":
      return new CodexAppServerAgentClient({ ...(command ? { command } : {}) });
    case "opencode":
      return new OpenCodeAgentClient({ ...(command ? { command } : {}) });
    case "claude":
      return new ClaudeAgentClient();
    default:
      return null;
  }
}

export function listProviders(): string[] {
  return ["pi", "codex", "opencode", "claude"];
}

export function isKnownProvider(provider: string): provider is AgentProvider {
  return listProviders().includes(provider);
}
