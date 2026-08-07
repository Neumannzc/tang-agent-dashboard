// 自定义协议 handler：tang-ai-chat://app/<path> → 返回 packaged UI 资源
// 约束：仅服务协议前缀下资源、MIME 推断、SPA fallback、路径穿越防护

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, protocol } from "electron";

import { PROTOCOL_SCHEME } from "./config.js";

const APP_PREFIX = "app/";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface AppProtocolOptions {
  /** UI 构建产物根目录 */
  distDir: string;
}

/** 必须早于 app.whenReady() 调用，注册为 privileged scheme */
export function registerAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

/** 在 app.whenReady() 之后注册 handler（依赖 privileges 声明） */
export function registerAppProtocolHandler(options: AppProtocolOptions): void {
  const distDir = path.resolve(options.distDir);

  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    try {
      return await serveAppRequest(request, distDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[desktop] 协议请求失败: ${message}`);
      return new Response(message, { status: 500 });
    }
  });
}

async function serveAppRequest(request: Request, distDir: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== "app") {
    return new Response("Not Found", { status: 404 });
  }
  // 相对路径（剥离前缀），防止协议层注入
  let relPath = decodeURIComponent(url.pathname);
  if (relPath.startsWith("/")) {
    relPath = relPath.slice(1);
  }
  // 空路径或纯目录请求 → index.html
  if (!relPath || relPath.endsWith("/")) {
    relPath = path.join(relPath, "index.html");
  }
  // 路径穿越防护：用解析后的绝对路径反向校验
  const candidate = path.normalize(path.join(distDir, relPath));
  if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  let target = candidate;
  // 文件不存在 → SPA fallback 到 index.html
  if (!existsSync(target) || !statSync(target).isFile()) {
    target = path.join(distDir, "index.html");
    if (!existsSync(target)) {
      return new Response(
        `UI 构建产物缺失：${distDir}\n请先运行 npm run build -w @agent-console/ui`,
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
  }
  const ext = path.extname(target).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  const body = await readFile(target);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    },
  });
}

/** 解析 dev/prod 的 UI 资源目录（统一入口）
 * 注意：staging/ 只是 electron-builder 的打包输入，不作为 dev 运行来源，
 * 避免 dev 模式加载过期 UI 产物 */
export function resolveUiDistDir(runtimeDir: string): { dir: string; mode: "packaged" | "dev-built" | "missing" } {
  if (app.isPackaged) {
    // packaged：resources/app-dist（runtimeDir 在 app.asar/dist，../.. 归一化到 resources/）
    const packaged = path.resolve(runtimeDir, "../../app-dist");
    if (existsSync(packaged) && statSync(packaged).isDirectory()) {
      return { dir: packaged, mode: "packaged" };
    }
    return { dir: packaged, mode: "missing" };
  }
  // dev：packages/ui/dist（npm run build 产物）
  const devBuilt = path.resolve(runtimeDir, "../../ui/dist");
  if (existsSync(devBuilt) && statSync(devBuilt).isDirectory()) {
    return { dir: devBuilt, mode: "dev-built" };
  }
  return { dir: devBuilt, mode: "missing" };
}

/** 协议对外可见的应用根（用于 BrowserWindow.loadURL） */
export function appUrl(pathname = "index.html"): string {
  return `${PROTOCOL_SCHEME}://app/${pathname}`;
}