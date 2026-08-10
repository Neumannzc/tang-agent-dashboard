// 窗口管理：BrowserWindow 创建、安全配置、窗口状态持久化（位置/尺寸/最大化）

import { app, BrowserWindow, type Rectangle } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from "./config.js";
import { isSafeExternalUrl } from "./external-url.js";

interface PersistedWindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

let mainWindow: BrowserWindow | null = null;
let stateSaveScheduled = false;

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadPersistedState(): PersistedWindowState {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) {
      return {};
    }
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as PersistedWindowState;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function scheduleSaveState(): void {
  if (stateSaveScheduled) {
    return;
  }
  stateSaveScheduled = true;
  // 简单防抖：合并多次 close/move/resize 事件
  setTimeout(() => {
    stateSaveScheduled = false;
    saveStateNow();
  }, 300);
}

function saveStateNow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const bounds = mainWindow.getNormalBounds();
  const state: PersistedWindowState = {
    bounds,
    maximized: mainWindow.isMaximized(),
  };
  try {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn(`[desktop] 窗口状态保存失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface CreateMainWindowOptions {
  preloadPath: string;
  iconPath?: string;
  show?: boolean;
}

/** 创建主窗口（只创建一次，重启走 activate 路径） */
export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const persisted = loadPersistedState();
  const window = new BrowserWindow({
    width: persisted.bounds?.width ?? WINDOW_DEFAULT_WIDTH,
    height: persisted.bounds?.height ?? WINDOW_DEFAULT_HEIGHT,
    x: persisted.bounds?.x,
    y: persisted.bounds?.y,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: app.getName(),
    backgroundColor: "#0f1115",
    show: options.show ?? true,
    ...(options.iconPath ? { icon: options.iconPath } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 阻止渲染端意外打开新窗口；外部链接走 preload IPC 由主进程 shell.openExternal 处理
      javascript: true,
    },
  });

  if (persisted.maximized) {
    window.maximize();
  }

  window.on("ready-to-show", () => {
    window.show();
  });
  window.on("close", () => {
    saveStateNow();
  });
  window.on("resize", () => scheduleSaveState());
  window.on("move", () => scheduleSaveState());
  window.on("maximize", () => scheduleSaveState());
  window.on("unmaximize", () => scheduleSaveState());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  // 拦截 window.open / target=_blank → 走 shell
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeExternalUrl(url)) {
      return { action: "deny" };
    }
    void shellOpenExternal(url);
    return { action: "deny" };
  });
  // 禁止应用内导航到外部 URL（点击 a 标签）
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url === current) {
      return;
    }
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shellOpenExternal(url);
    }
  });

  mainWindow = window;
  return window;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** shell.openExternal（延迟加载避免顶层循环依赖） */
async function shellOpenExternal(url: string): Promise<void> {
  const { shell } = await import("electron");
  try {
    await shell.openExternal(url);
  } catch (error) {
    console.warn(`[desktop] 打开外部链接失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
