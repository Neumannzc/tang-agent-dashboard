// daemon 生命周期：spawn → 等待就绪 → 退出回收（含 agent 孙进程）
// 桌面壳独占 daemon 端口（生产模式）；dev 模式下也由 Electron 拉起 daemon，
// 保证 renderer / dev 流程走的是同一条连接路径

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import treeKill from "tree-kill";

import { app } from "electron";

import { buildChildEnv, DAEMON_PORT_ENV, DAEMON_READY_TIMEOUT_MS, DAEMON_SHUTDOWN_GRACE_MS, RUNTIME_DIR } from "./config.js";

const POLL_INTERVAL_MS = 250;

/** 解析 daemon 入口：packaged > 开发构建 > tsx 源码
 * 注意：staging/ 只是 electron-builder 的打包输入，不作为运行入口，
 * 避免 dev 模式被过期打包产物劫持 */
function resolveDaemonEntry(): { command: string; args: string[]; nodePath?: string } {
  if (app.isPackaged) {
    // packaged：resources/daemon/dist/index.js（electron-builder extraResources）
    // __dirname 在 asar 中是 .../resources/app.asar/dist，
    // path.resolve 字符串归一化后 ../.. 指向 resources/
    const packaged = path.resolve(RUNTIME_DIR, "../../daemon/dist/index.js");
    if (existsSync(packaged)) {
      return {
        command: process.execPath,
        args: [packaged],
        // deps 与 daemon 同目录（resources/daemon/node_modules），Node 向上查找即可，
        // 无需 NODE_PATH；保留此项以防 node_modules 被 asar 化
        nodePath: path.resolve(RUNTIME_DIR, "../../daemon/node_modules"),
      };
    }
  }
  // dev：packages/daemon/dist/index.js（npm run build 产物）
  const distEntry = path.resolve(RUNTIME_DIR, "../../daemon/dist/index.js");
  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }
  // dev 兜底：tsx 直接跑 TS（源码始终最新，无需先构建）
  const tsxBin = path.resolve(RUNTIME_DIR, "../../../../node_modules/.bin/tsx");
  const srcEntry = path.resolve(RUNTIME_DIR, "../../daemon/src/index.ts");
  return { command: process.execPath, args: [tsxBin, srcEntry] };
}

export interface DaemonManagerOptions {
  port: number;
}

export class DaemonManager extends EventEmitter {
  private readonly options: DaemonManagerOptions;
  private child: ChildProcess | null = null;
  private starting = false;

  constructor(options: DaemonManagerOptions) {
    super();
    this.options = options;
  }

  get port(): number {
    return this.options.port;
  }

  /** ws:// 端点（renderer 通过 preload 拿） */
  get wsUrl(): string {
    return `ws://127.0.0.1:${this.options.port}`;
  }

  /** 启动 daemon 子进程 */
  start(): void {
    if (this.child || this.starting) {
      return;
    }
    this.starting = true;
    const { command, args, nodePath } = resolveDaemonEntry();
    // node:sqlite 在 Node 22（Electron 35 内置）仍需 --experimental-sqlite flag；
    // Node flag 必须位于入口脚本之前，升级到内置 Node ≥ 24 的 Electron 后可移除
    const finalArgs = ["--experimental-sqlite", ...args, "--port", String(this.options.port)];
    console.log(`[desktop] 启动 daemon: ${command} ${finalArgs.join(" ")}`);
    const env = buildChildEnv({
      [DAEMON_PORT_ENV]: String(this.options.port),
      // 关键：Electron 主进程的 process.execPath 是 electron 二进制，
      // 必须用 ELECTRON_RUN_AS_NODE=1 让子进程以纯 Node 模式跑 daemon
      ELECTRON_RUN_AS_NODE: "1",
      ...(nodePath ? { NODE_PATH: nodePath } : {}),
    });
    const child = spawn(command, finalArgs, {
      stdio: "inherit",
      env,
    });
    this.child = child;
    this.starting = false;
    child.on("exit", (code, signal) => {
      const wasRunning = this.child === child;
      if (wasRunning) {
        this.child = null;
      }
      console.log(`[desktop] daemon 退出 code=${code} signal=${signal}`);
      // 主动 stop() 触发的退出不当作"异常"，避免触发 renderer 的恢复 UI
      if (wasRunning) {
        this.emit("exit", { code, signal, unexpected: true });
      }
    });
  }

  /** 等待 daemon 端口可连接（TCP 探测，端口绑定即视为就绪） */
  async waitForReady(timeoutMs = DAEMON_READY_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) {
        return false;
      }
      const ok = await probePort(this.options.port);
      if (ok) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  /** 优雅退出 daemon：SIGTERM → 超时后 SIGKILL 进程树 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child || child.killed || child.exitCode !== null) {
        this.child = null;
        resolve();
        return;
      }
      this.child = null;
      const pid = child.pid;
      if (!pid) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch (error) {
        console.error(`[desktop] daemon SIGTERM 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      setTimeout(() => {
        if (settled) {
          return;
        }
        console.warn(`[desktop] daemon 未在 ${DAEMON_SHUTDOWN_GRACE_MS}ms 内退出，强制 tree-kill`);
        treeKill(pid, "SIGKILL", (err) => {
          if (err) {
            console.error(`[desktop] tree-kill 失败: ${err.message}`);
          }
          done();
        });
      }, DAEMON_SHUTDOWN_GRACE_MS);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TCP 探测端口（端口可连接 = WS server 监听 = 就绪） */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), POLL_INTERVAL_MS);
  });
}