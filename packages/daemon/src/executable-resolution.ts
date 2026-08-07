// 二进制查找（简化版 PATH 扫描）
// 注意：桌面壳从 GUI 启动时 PATH 常缺用户级 bin（nvm/bun/cargo 等），
// 导致 agent 二进制找不到——daemon 启动时先调 augmentAgentPath() 兜底

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 已知 agent 二进制名（与 providers/index.ts 的 provider 列表对齐） */
const AGENT_BIN_NAMES = ["codex", "pi", "opencode", "claude"];

/** 常见用户级 bin 目录（GUI 启动的 PATH 可能不含；nvm 每个 node 版本各一个 bin） */
function userBinCandidates(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/usr/local/bin",
  ];
  // nvm 版本目录按版本号新→旧排序：agent 进程的 `env node` shebang 会命中 PATH
  // 里第一个 node，旧版本 node 可能跑不动新 agent（如 pi 的 undici），必须新版本在前
  const nvmVersions = path.join(home, ".nvm", "versions", "node");
  const versions: string[] = [];
  try {
    for (const version of readdirSync(nvmVersions)) {
      const bin = path.join(nvmVersions, version, "bin");
      if (existsSync(bin)) {
        versions.push(version);
      }
    }
  } catch {
    // 无 nvm，忽略
  }
  versions.sort((a, b) => compareNodeVersions(b, a));
  for (const version of versions) {
    dirs.push(path.join(nvmVersions, version, "bin"));
  }
  return dirs;
}

/** 形如 v24.15.0 的 nvm 版本号比较；不合法时按字符串兜底 */
function compareNodeVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^v/, "").split(".").map((n) => Number(n));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}

/**
 * 把含 agent 二进制的用户级 bin 目录补进 process.env.PATH（幂等，可重复调用）。
 * 只补实际含 agent 二进制的目录；追加在 PATH 末尾（fallback 语义），
 * 不抢占已有目录，避免旧版 node/agent 遮蔽当前版本。
 */
export function augmentAgentPath(): void {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const existingSet = new Set(existing);
  const additions: string[] = [];
  for (const dir of userBinCandidates()) {
    if (existingSet.has(dir)) {
      continue;
    }
    if (AGENT_BIN_NAMES.some((name) => existsSync(path.join(dir, name)))) {
      additions.push(dir);
    }
  }
  if (additions.length > 0) {
    process.env.PATH = [...existing, ...additions].join(path.delimiter);
  }
}

export async function findExecutable(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  // 含路径分隔符：直接检查
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return existsSync(trimmed) ? trimmed : null;
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathEntries) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, trimmed);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
