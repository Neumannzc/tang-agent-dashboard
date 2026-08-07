// dev：并行启动 Vite（renderer HMR）+ Electron（拉起 daemon + 加载 Vite URL）
// daemon 由 Electron 主进程持有，避免端口冲突 / 双 socket。
// 用法: npm run dev

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const desktopEntry = path.join(rootDir, "packages/desktop");
const desktopDist = path.join(desktopEntry, "dist", "main.js");

// 桌面壳 TS 产物缺失时先构建（tsc 约 1s）
if (!existsSync(desktopDist)) {
  console.log("[dev] 构建 desktop 包...");
  execSync("npm run build -w @agent-console/desktop", { stdio: "inherit", cwd: rootDir });
}

// agent 二进制（pi/codex/claude/opencode）通常与 node 同目录（如 nvm bin）
// 非交互 shell 的 PATH 可能不含它，显式补上
const BIN_DIR = path.dirname(process.execPath);
const baseEnv = {
  ...process.env,
  FORCE_COLOR: "1",
  PATH: [process.env.PATH, BIN_DIR].filter(Boolean).join(path.delimiter),
};

// Vite dev server（renderer HMR）
const vite = spawn("npm", ["run", "dev:ui"], {
  stdio: "inherit",
  cwd: rootDir,
  env: baseEnv,
});

// Electron：主进程内部拉 daemon，再加载 Vite URL（http://127.0.0.1:5173）
const electronBin = path.join(rootDir, "node_modules", ".bin", "electron");
const electron = spawn(electronBin, [desktopEntry, "--dev"], {
  stdio: "inherit",
  cwd: rootDir,
  env: baseEnv,
});

const children = [vite, electron];
const shutdown = (signal) => {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
};

for (const child of children) {
  child.on("exit", (code) => {
    shutdown("SIGTERM");
    process.exit(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));