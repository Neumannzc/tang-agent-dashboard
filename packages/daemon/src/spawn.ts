// 简化版进程 spawn（参考 Paseo utils/spawn.ts，去掉 Windows shell 引号处理，MVP 用）

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SpawnProcessOptions extends Omit<SpawnOptions, "env"> {
  env?: NodeJS.ProcessEnv;
  envOverlay?: NodeJS.ProcessEnv;
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { env, envOverlay, ...spawnOptions } = options ?? {};
  const childEnv: NodeJS.ProcessEnv = env ?? process.env;

  return spawn(command, args, {
    ...spawnOptions,
    env: envOverlay ? { ...childEnv, ...envOverlay } : childEnv,
    stdio: spawnOptions.stdio ?? ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
