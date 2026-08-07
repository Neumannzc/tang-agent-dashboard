// desktop 配置常量：协议 scheme、端口、dev URL 等
// 单点真源，main / preload / daemon-manager 都引用这里

import path from "node:path";

/** 自定义协议 scheme（与产品名 tang-ai-chat 对齐） */
export const PROTOCOL_SCHEME = "tang-ai-chat";

/** 应用名（用户可见） */
export const APP_NAME = "Tang Agent Dashboard";

/** daemon 端口：env 覆盖 > 默认 */
export const DAEMON_DEFAULT_PORT = 8765;
export const DAEMON_PORT_ENV = "AGENT_CONSOLE_PORT";

/** dev 模式 Vite dev server 地址（renderer HMR） */
export const DEV_VITE_URL = "http://127.0.0.1:5173";

/** 桌面壳等待 daemon 就绪的超时（毫秒） */
export const DAEMON_READY_TIMEOUT_MS = 30_000;

/** 桌面壳等待 daemon 优雅退出的超时，超时后强杀 */
export const DAEMON_SHUTDOWN_GRACE_MS = 5_000;

/** 窗口状态最小尺寸 */
export const WINDOW_MIN_WIDTH = 960;
export const WINDOW_MIN_HEIGHT = 640;

/** 默认窗口尺寸（无持久化状态时） */
export const WINDOW_DEFAULT_WIDTH = 1280;
export const WINDOW_DEFAULT_HEIGHT = 860;

/** 子进程 PATH 兜底：把 node 同级 bin 目录追加进去（nvm / fnm 等场景） */
export function buildChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const binDir = path.dirname(process.execPath);
  return {
    ...process.env,
    FORCE_COLOR: "1",
    PATH: [process.env.PATH, binDir].filter(Boolean).join(path.delimiter),
    ...extra,
  };
}

/** 当前文件目录（compiled JS 时为 dist/） */
export const RUNTIME_DIR = __dirname;