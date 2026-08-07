// 二进制查找（简化版 PATH 扫描）

import { existsSync } from "node:fs";
import path from "node:path";

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
