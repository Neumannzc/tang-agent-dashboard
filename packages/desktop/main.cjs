// Agent Console 桌面壳主进程
// 职责：拉起 daemon（内置）→ 等待就绪 → 打开窗口加载本地 UI → 退出时回收 daemon

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const DAEMON_PORT = process.env.AGENT_CONSOLE_PORT ?? "8765";
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const DEV_MODE = process.argv.includes("--dev");
const SCREENSHOT_PATH = getArgValue("--screenshot");

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

/** 解析 daemon 启动入口：优先构建产物，其次 tsx 源码 */
function resolveDaemonEntry() {
  const distEntry = path.resolve(__dirname, "../daemon/dist/index.js");
  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry, "--port", DAEMON_PORT] };
  }
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  const srcEntry = path.resolve(__dirname, "../daemon/src/index.ts");
  return { command: process.execPath, args: [tsxBin, srcEntry, "--port", DAEMON_PORT] };
}

/** 启动 daemon 子进程，返回其引用；退出时回收 */
function startDaemon() {
  const { command, args } = resolveDaemonEntry();
  console.log(`[desktop] 启动 daemon: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.on("exit", (code, signal) => {
    console.log(`[desktop] daemon 退出 code=${code} signal=${signal}`);
  });
  return child;
}

/** 轮询 daemon HTTP 就绪 */
async function waitForDaemon(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DAEMON_URL, { method: "GET" });
      void response.body?.cancel();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

let daemonProcess = null;
let mainWindow = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Agent Console",
    backgroundColor: "#0f1115",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(DAEMON_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (SCREENSHOT_PATH) {
    mainWindow.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          const { writeFileSync } = require("node:fs");
          writeFileSync(SCREENSHOT_PATH, image.toPNG());
          console.log(`[desktop] 截图已保存: ${SCREENSHOT_PATH}`);
        } catch (error) {
          console.error("[desktop] 截图失败:", error);
        }
        app.quit();
      }, 4000);
    });
  }
}

app.whenReady().then(async () => {
  daemonProcess = startDaemon();
  const ready = await waitForDaemon();
  if (!ready) {
    dialog.showErrorBox(
      "Agent Console 启动失败",
      `daemon 未能在 30 秒内就绪（${DAEMON_URL}）。\n请确认端口 ${DAEMON_PORT} 未被占用，或查看终端日志。`,
    );
    app.quit();
    return;
  }
  console.log(`[desktop] daemon 就绪: ${DAEMON_URL}`);
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

// 退出时回收 daemon（daemon 监听 SIGTERM 优雅关闭全部 agent 子进程）
app.on("before-quit", () => {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    daemonProcess = null;
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
