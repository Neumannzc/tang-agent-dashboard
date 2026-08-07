// 桌面壳主进程：应用生命周期 + daemon 托管 + 协议注册 + 窗口创建
// 入口流程：
//   1. 注册 privileged scheme（必须在 app.ready 之前）
//   2. 启动 daemon 子进程
//   3. 注册 IPC handler（preload 调用）
//   4. 等待 daemon 端口就绪
//   5. 注册协议资源 handler
//   6. 创建 BrowserWindow（preload + 自定义协议加载 UI）
//   7. app.before-quit 回收 daemon

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import { APP_NAME, DAEMON_DEFAULT_PORT, DAEMON_PORT_ENV, DEV_VITE_URL } from "./config.js";
import { DaemonManager } from "./daemon-manager.js";
import {
  appUrl,
  registerAppProtocolHandler,
  registerAppProtocolScheme,
  resolveUiDistDir,
} from "./protocol-handler.js";
import { createMainWindow, getMainWindow } from "./window-manager.js";
import type { DesktopConfig } from "./preload.js";

// ----- 单实例锁 -----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName(APP_NAME);
  app.on("second-instance", () => {
    const window = getMainWindow();
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  // ----- Scheme 必须在 ready 之前注册 -----
  registerAppProtocolScheme();

  const DEV_MODE = (!app.isPackaged && !process.argv.includes("--prod-ui")) || process.argv.includes("--dev");
  const daemonPort = readDaemonPort();
  const daemon = new DaemonManager({ port: daemonPort });

  let cleanedUp = false;
  const cleanup = async (reason: string) => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    console.log(`[desktop] 退出 (${reason})`);
    await daemon.stop();
  };

  app.on("before-quit", (event) => {
    if (!cleanedUp) {
      event.preventDefault();
      void cleanup("before-quit").finally(() => app.exit(0));
    }
  });

  // ----- IPC handler：preload ↔ main -----
  ipcMain.handle("tang:get-config", (): DesktopConfig => ({
    wsUrl: daemon.wsUrl,
    platform: process.platform,
    version: app.getVersion(),
    mode: "desktop",
  }));

  ipcMain.handle("tang:open-directory", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("tang:open-external", async (_event, url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return;
    }
    await shell.openExternal(url);
  });

  // 渲染端请求截图（自动化测试用，普通用户不触发）
  const SCREENSHOT_PATH = readScreenshotArg();

  // ----- 启动 -----
  app.whenReady().then(async () => {
    daemon.on("exit", (info) => {
      // 仅在 daemon 异常退出时通知 renderer；主动关闭不算
      if (!info.unexpected) {
        return;
      }
      const window = getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send("tang:daemon-exit", { code: info.code, signal: info.signal });
      }
    });

    daemon.start();
    const ready = await daemon.waitForReady();
    if (!ready) {
      dialog.showErrorBox(
        `${APP_NAME} 启动失败`,
        `daemon 未能在限定时间内就绪（${daemon.wsUrl}）。\n请确认端口 ${daemonPort} 未被占用，或查看终端日志。`,
      );
      app.exit(1);
      return;
    }
    console.log(`[desktop] daemon 就绪: ${daemon.wsUrl}`);

    // 协议资源 handler 必须在窗口加载 URL 之前注册
    const { dir, mode } = resolveUiDistDir(__dirname);
    console.log(`[desktop] UI 资源目录 (${mode}): ${dir}`);
    registerAppProtocolHandler({ distDir: dir });

    const preloadPath = path.join(__dirname, "preload.js");
    const iconPath = resolveWindowIcon();
    const window = createMainWindow({ preloadPath, ...(iconPath ? { iconPath } : {}) });

    // 加载 URL：dev 模式 → Vite；prod → 自定义协议
    const loadTarget = DEV_MODE ? DEV_VITE_URL : appUrl("index.html");
    console.log(`[desktop] 加载 UI: ${loadTarget}`);
    void window.loadURL(loadTarget);

    if (SCREENSHOT_PATH) {
      window.webContents.on("did-finish-load", () => {
        setTimeout(async () => {
          try {
            const image = await window.webContents.capturePage();
            const { writeFileSync } = await import("node:fs");
            writeFileSync(SCREENSHOT_PATH, image.toPNG());
            console.log(`[desktop] 截图已保存: ${SCREENSHOT_PATH}`);
          } catch (error) {
            console.error("[desktop] 截图失败:", error);
          }
          app.quit();
        }, 4000);
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createMainWindow({ preloadPath, ...(iconPath ? { iconPath } : {}) });
        void win.loadURL(loadTarget);
      }
    });
  });

  app.on("window-all-closed", () => {
    // macOS 习惯保留 dock 入口；其他平台一并退出
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

// ----- 工具函数 -----

function readDaemonPort(): number {
  const raw = process.env[DAEMON_PORT_ENV];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    console.warn(`[desktop] 忽略非法 ${DAEMON_PORT_ENV}=${raw}，使用默认 ${DAEMON_DEFAULT_PORT}`);
  }
  return DAEMON_DEFAULT_PORT;
}

function readScreenshotArg(): string | null {
  const idx = process.argv.indexOf("--screenshot");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1] ?? null;
  }
  return null;
}

function resolveWindowIcon(): string | null {
  // 候选顺序：packaged icon → dev 包内 icon → null（平台默认）
  const candidates = [
    path.resolve(__dirname, "../../resources/icon.png"),
    path.resolve(__dirname, "../resources/icon.png"),
    path.resolve(__dirname, "../assets/icon.png"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}