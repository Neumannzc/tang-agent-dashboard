// 静态资源服务：托管 UI 构建产物（packages/ui/dist），SPA fallback 到 index.html
// 桌面壳与浏览器场景共用：daemon 在同一个端口上同时提供 HTTP(UI) + WS

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

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
};

export interface StaticHandlerOptions {
  /** UI 构建产物目录（packages/ui/dist） */
  distDir: string;
  /** 开发模式：无构建产物时不 404，返回提示页 */
  dev?: boolean;
}

export function createStaticHandler(options: StaticHandlerOptions) {
  const distDir = path.resolve(options.distDir);
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }
    let pathname: string;
    try {
      // 畸形 URL / 非法百分号编码（如 /%zz）会抛异常，必须兜住避免拖垮 daemon
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    if (pathname === "/") {
      pathname = "/index.html";
    }
    const filePath = path.normalize(path.join(distDir, pathname));
    // 防目录穿越（用分隔符收尾，避免同前缀兄弟目录如 dist2 被放行）
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      serveFile(filePath, res);
      return;
    }
    // SPA fallback
    const indexFile = path.join(distDir, "index.html");
    if (existsSync(indexFile)) {
      serveFile(indexFile, res);
      return;
    }
    if (options.dev) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<h3>UI 未构建</h3><p>请先运行 <code>npm run build</code> 生成 packages/ui/dist，<br>或开发模式使用 <code>npm run dev:ui</code>（Vite 5173 端口）连接本 daemon（WS 8765）。</p>`,
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  };
}

function serveFile(filePath: string, res: ServerResponse): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(res);
}
