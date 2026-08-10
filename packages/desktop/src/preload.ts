// preload 桥：通过 contextBridge 暴露白名单能力给 renderer
// sandbox + contextIsolation：renderer 拿不到 Node / Electron，只能用这里暴露的 API

import { contextBridge, ipcRenderer } from "electron";

export interface DesktopConfig {
  /** daemon WS 端点（loopback） */
  readonly wsUrl: string;
  readonly token: string;
  /** 运行平台 */
  readonly platform: NodeJS.Platform;
  /** 桌面壳版本 */
  readonly version: string;
  /** 当前运行模式 */
  readonly mode: "desktop";
}

const api = {
  /** 同步获取配置（主进程启动时已把 wsUrl 写入，主进程 handler 直接返回） */
  async getConfig(): Promise<DesktopConfig> {
    return ipcRenderer.invoke("tang:get-config");
  },

  /** 系统目录选择对话框（替换手输 cwd） */
  async openDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("tang:open-directory");
  },

  /** 通过系统 handler 打开外部 URL */
  async openExternal(url: string): Promise<void> {
    await ipcRenderer.invoke("tang:open-external", url);
  },

  /** 订阅 daemon 异常退出（renderer 展示重连/恢复 UI） */
  onDaemonExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: { code: number | null; signal: NodeJS.Signals | null }) => {
      try {
        listener(payload);
      } catch (error) {
        console.error("[preload] daemon-exit listener 异常:", error);
      }
    };
    ipcRenderer.on("tang:daemon-exit", handler);
    return () => {
      ipcRenderer.removeListener("tang:daemon-exit", handler);
    };
  },
};

contextBridge.exposeInMainWorld("tang", api);

export type DesktopApi = typeof api;
