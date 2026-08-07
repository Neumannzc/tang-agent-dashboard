// dev：并行启动 daemon + UI
// 用法: npm run dev

import { spawn } from "node:child_process";
import path from "node:path";

// agent 二进制（pi/codex/claude/opencode）通常与 node 同目录（如 nvm bin）
// 非交互 shell 的 PATH 可能不含它，显式补上（npm run 脚本环境同样需要）
const BIN_DIR = path.dirname(process.execPath);
const env = {
  ...process.env,
  FORCE_COLOR: "1",
  PATH: [process.env.PATH, BIN_DIR].filter(Boolean).join(path.delimiter),
};

const children = [
  spawn("npm", ["run", "dev", "-w", "@agent-console/daemon"], {
    stdio: "inherit",
    env,
  }),
  spawn("npm", ["run", "dev", "-w", "@agent-console/ui"], {
    stdio: "inherit",
    env,
  }),
];

for (const child of children) {
  child.on("exit", (code) => {
    for (const other of children) {
      other.kill("SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
