// 配置文件：~/.agent-console/config.json
// 支持 provider 启用开关与命令覆盖、WS 端口

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentProvider } from "@agent-console/protocol";

export interface ProviderConfig {
  /** 是否启用该 provider（默认 true） */
  enabled?: boolean;
  /** 命令覆盖，如 ["/path/to/custom-pi"] */
  command?: string[];
}

export interface ConsoleConfig {
  providers?: Partial<Record<AgentProvider, ProviderConfig>>;
  wsPort?: number;
  /** 默认会话 cwd */
  defaultCwd?: string;
}

const DEFAULT_CONFIG_PATH = path.join(homedir(), ".agent-console", "config.json");

export function loadConfig(filePath = DEFAULT_CONFIG_PATH): ConsoleConfig {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as ConsoleConfig;
  } catch (error) {
    console.warn(`[config] 读取配置失败（${filePath}），使用默认值:`, error);
    return {};
  }
}

export function ensureConfigDir(): string {
  const dir = path.join(homedir(), ".agent-console");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function isProviderEnabled(config: ConsoleConfig, provider: AgentProvider): boolean {
  return config.providers?.[provider]?.enabled !== false;
}
