// 会话恢复相关的共享小工具

import type { AgentPersistenceHandle, AgentSessionConfig } from "@agent-console/protocol";

/** 从持久化句柄元数据或 overrides 中解析 cwd */
export function readCwd(
  handle: AgentPersistenceHandle,
  overrides?: Partial<AgentSessionConfig>,
): string {
  const fromHandle = handle.metadata?.cwd;
  if (typeof fromHandle === "string" && fromHandle.length > 0) {
    return fromHandle;
  }
  return overrides?.cwd ?? process.cwd();
}
