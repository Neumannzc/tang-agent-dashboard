// Pi MCP 配置注入：写 per-agent --mcp-config 文件，保留原 mcp.json 再叠加
// 参考 PLAN 风险注意 #3：不要用 --append-system-prompt 之外的方式覆盖 pi 自身配置

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MCP_CONFIG_DIR = path.join(homedir(), ".agent-console", "pi-mcp");
const DEFAULT_PI_MCP_PATH = path.join(homedir(), ".pi", "agent", "mcp.json");

export async function writePiMcpConfig(
  cwd: string,
  mcpServers: Record<string, unknown>,
): Promise<string> {
  // 读取 pi 全局 mcp.json，保留原 server 配置后叠加自定义的
  const merged: Record<string, unknown> = {};
  try {
    if (existsSync(DEFAULT_PI_MCP_PATH)) {
      const raw = readFileSync(DEFAULT_PI_MCP_PATH, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, parsed);
      }
    }
  } catch {
    // 忽略：pi 全局 mcp.json 不存在或不可读
  }
  const existingServers = (merged.mcpServers ?? {}) as Record<string, unknown>;
  merged.mcpServers = { ...existingServers, ...mcpServers };

  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  // 文件名按 cwd 确定（覆盖写），避免每次创建会话都新增一个文件、长期累积
  const slug = cwd.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-40) || "default";
  const filePath = path.join(MCP_CONFIG_DIR, `${slug}.json`);
  writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return filePath;
}
