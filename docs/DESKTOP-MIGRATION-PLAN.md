# Desktop-Only Migration Plan

> Status: **implemented (Phases 1-6 core)** — 迁移已完成，Electron 是唯一入口；打包与 E2E 已验证
> 更新：2026-08-07

## 1. Goal

The future product entry point is the installed Electron application. The project will no longer maintain a browser-accessible Web product or document `http://127.0.0.1:*` as a user-facing entry point.

The existing React + Vite UI remains the renderer implementation, but it becomes an Electron-packaged local resource rather than a deployed or daemon-served Web application.

## 2. Current State

The repository already contains:

- `packages/ui`: React + Vite renderer UI.
- `packages/daemon`: local Node daemon that manages agent subprocesses and exposes WebSocket RPC.
- `packages/protocol`: shared RPC and event types.
- `packages/desktop`: Electron shell that starts the daemon and opens a `BrowserWindow`.

The current desktop shell loads `http://127.0.0.1:8765`. The daemon currently serves both static UI assets and WebSocket RPC on that port. This keeps the browser as a functional product entry point and does not meet the desktop-only objective.

## 3. Target Architecture

```text
+---------------------------------------------------------------+
| Installed Electron application                                |
|                                                               |
|  Main process                                                 |
|  - creates BrowserWindow                                      |
|  - serves packaged UI through tang-ai-chat://app/             |
|  - starts, health-checks, and stops the daemon                |
|  - owns native dialogs, external links, window state          |
|                                                               |
|  Renderer process                                             |
|  - React + Vite production build                              |
|  - connects only to the locally managed daemon by WebSocket   |
|  - accesses desktop abilities through a minimal preload API   |
+------------------------------+--------------------------------+
                               | ws://127.0.0.1:<local-port>
+------------------------------v--------------------------------+
| Node daemon                                                   |
| - WebSocket RPC only                                          |
| - session storage and agent lifecycle management              |
| - Pi, Codex, Claude Code, and OpenCode subprocesses           |
+---------------------------------------------------------------+
```

### Architecture decisions

- Electron remains the desktop shell. The existing Node daemon and Chromium renderer make Electron the lowest-risk choice.
- Production UI is loaded by a custom `tang-ai-chat://app/` protocol from packaged files, with MIME handling, SPA fallback, and path-traversal protection.
- The daemon remains loopback-only and exposes WebSocket RPC. It no longer serves the UI or a general HTTP endpoint.
- Vite remains a development-only renderer tool for hot reload. It is not a product deployment or browser-access mechanism.
- Desktop-only native capabilities are exposed through a narrow preload bridge; the renderer never receives Node or unrestricted Electron APIs.

## 4. Success Criteria

The migration is complete when all of the following are true:

1. The installed Electron application is the only supported user entry point.
2. Production UI loads from packaged application resources, not `http://127.0.0.1:*`.
3. The daemon exposes WebSocket RPC only and no longer serves static UI files.
4. Opening a browser at the daemon port cannot operate the product UI.
5. Starting the desktop application automatically starts the daemon, waits for readiness, and connects the UI.
6. Quitting the application cleans up the daemon and its agent subprocess tree.
7. A packaged application starts without Vite, a manually started daemon, or source-tree-relative runtime assumptions.

## 5. Implementation Plan

### Phase 1: Establish the desktop-only runtime boundary

**Changes**

- Define Electron as the sole production entry point.
- Retain `packages/ui`, `packages/daemon`, and `packages/protocol` responsibilities.
- Define the packaged UI protocol as `tang-ai-chat://app/`.
- Define daemon communication as loopback WebSocket RPC only.
- Replace the renderer's production assumption of a fixed `ws://127.0.0.1:8765` endpoint with an Electron-provided runtime connection configuration.

**Verification**

- The renderer can connect to the Electron-managed daemon without a browser URL query parameter.
- Production UI has no dependency on an HTTP static-file server.

### Phase 2: Build a secure Electron application shell

**Changes**

- Split `packages/desktop/main.cjs` into focused modules for application startup, daemon lifecycle, protocol resource handling, preload IPC, and window management.
- Register `tang-ai-chat://app/` before creating the window.
- Serve only packaged UI resources through the custom protocol.
- Implement SPA fallback and prevent resource-path traversal.
- Configure Electron security defaults:
  - `contextIsolation: true`
  - `sandbox: true`
  - `nodeIntegration: false`
  - `webSecurity: true`
- Add a preload API with an explicit allowlist.
- Add native directory selection and controlled external-link opening.
- Add application icon, window minimum dimensions, and persisted window geometry/maximized state.

**Verification**

- The renderer cannot access Node APIs directly.
- The directory picker works through preload IPC.
- External URLs open through the system handler rather than navigation inside the application.
- Window position, size, and maximized state are restored after relaunch.

### Phase 3: Make daemon lifecycle desktop-owned

**Changes**

- Electron selects and manages a local daemon port, or safely owns the configured fixed port.
- Electron starts the daemon before loading the functional UI and waits for WebSocket readiness.
- Propagate the selected endpoint to the renderer through the preload bridge or another controlled local configuration mechanism.
- Ensure Electron startup inherits the required executable `PATH`, including Node version manager environments where relevant.
- Handle daemon startup failures, unexpected exits, and application shutdown clearly.
- On shutdown, terminate the daemon gracefully and ensure its managed Pi, Codex, Claude Code, and OpenCode subprocesses are cleaned up.

**Verification**

- Launching the desktop application requires no separately started daemon.
- Closing the last application window cleans up the daemon process tree.
- A daemon startup failure is surfaced in an actionable native error state.
- An unexpected daemon exit produces a visible disconnected/recovery state in the renderer.

### Phase 4: Remove the Web product path

**Changes**

- Delete daemon static UI serving and remove `packages/daemon/src/static-server.ts` if it has no remaining responsibility.
- Simplify `packages/daemon/src/index.ts` so it creates a WebSocket service only.
- Update `WsServer` so it no longer depends on an HTTP server solely for static asset serving.
- Replace root `dev`, `start`, and `desktop` scripts so desktop development is the default workflow.
- Keep `dev:ui` only as an internal Vite hot-reload helper for Electron development.
- Remove browser-product documentation, browser startup instructions, and Web deployment assumptions.
- Update `docs/PLAN.md`, `docs/FRONTEND-PLAN.md`, `docs/DESKTOP-PLAN.md`, and related references to resolve legacy Web/Expo/Electron strategy conflicts.

**Verification**

- Documentation no longer presents `http://127.0.0.1:5173` or `http://127.0.0.1:8765` as product entry points.
- The daemon port no longer returns the UI HTML or static assets.
- Opening the daemon port in a browser cannot provide the product interface.

### Phase 5: Package and distribute the desktop application

**Changes**

- Add and configure `electron-builder`.
- Package UI output, daemon output, runtime dependencies, and application icons.
- Handle `asar` packaging and unpack any files that must exist on the physical filesystem at runtime.
- Add explicit build scripts, for example:
  - `build:desktop`: build protocol, daemon, UI, and desktop artifacts in dependency order.
  - `package:desktop`: build the distributable installer/package.
- Set application identity, product name, version metadata, and per-platform targets.
- Prioritize Linux package verification in the current environment; configure macOS and Windows targets without requiring signing or notarization in the first delivery.

**Verification**

- A package built outside the source workflow starts with no Vite server and no manually launched daemon.
- The packaged application can create a session, send a prompt, process a permission request, and exit cleanly.

### Phase 6: Desktop regression and release validation

**Changes**

- Retain daemon/provider CLI smoke coverage.
- Convert browser-URL E2E coverage into Electron-based application-window coverage.
- Cover first launch, daemon port collision, daemon startup failure, directory selection, permission handling, session restore, resizing, and clean exit.
- Run a real end-to-end workflow against all four providers: Pi, Codex, Claude Code, and OpenCode.
- Verify Linux packaging and startup first. Add Windows and macOS package startup checks as release environments become available.

**Verification**

- Core desktop workflows pass in an Electron window.
- No test requires Chrome to navigate to a product URL.
- All supported provider flows remain functional after packaging.

## 6. Recommended Execution Order

1. Complete Phases 1-3 first so Electron becomes the only development and runtime entry point.
2. Complete Phase 4 once the desktop runtime is proven, removing the supported browser path rather than maintaining two parallel products.
3. Complete Phases 5-6 to make the desktop application distributable and verify that the packaged application behaves like the development application.

This order validates the runtime model before introducing packaging complexity.

## 7. Explicitly Out of Scope for the First Desktop Release

- Automatic updates.
- System tray functionality.
- macOS signing, notarization, or Windows code signing.
- Mobile applications.
- Browser/PWA distribution.
- Remote daemon hosting and browser access as a supported end-user workflow.

## 8. Open Release Decision

Confirm the initial distribution scope before Phase 5:

- Linux only for the first installable release, with macOS and Windows configuration prepared later; or
- Linux, macOS, and Windows installers required for the first release.

The current environment supports validating the Linux package directly. macOS and Windows require their respective build and test environments, plus signing credentials if signed distribution is required.

## 9. Implementation Log (2026-08-07)

### Phase 1-3 完成：桌面壳 + 安全边界 + daemon 生命周期

`packages/desktop` 从单一 `main.cjs` 重构为 TypeScript 模块（`tsc` 输出 `dist/`）：

| 模块 | 职责 |
|---|---|
| `src/main.ts` | 应用生命周期、IPC handler、单实例锁、截图调试 |
| `src/daemon-manager.ts` | daemon spawn / 端口探测 / 优雅退出（SIGTERM → tree-kill） |
| `src/protocol-handler.ts` | `tang-ai-chat://app/` 协议：MIME、SPA fallback、路径穿越防护 |
| `src/window-manager.ts` | 窗口创建、安全配置、位置/尺寸/最大化持久化（userData/window-state.json） |
| `src/preload.ts` | preload 桥：`getConfig` / `openDirectory` / `openExternal` / `onDaemonExit` |

关键实现点：

- **Renderer 连接配置**：`resolveDaemonWsUrl()` 优先读 `window.tang.getConfig().wsUrl`（preload 注入），其次 `?ws=`（仅 dev 调试），最后默认。
- **安全基线**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`；外部链接走 `shell.openExternal`，`window.open`/`will-navigate` 全部拦截。
- **daemon 子进程**：以 `ELECTRON_RUN_AS_NODE=1` 纯 Node 模式启动（避免 Electron 二进制）；PATH 追加 node bin 目录（nvm 场景）。
- **协议注册时机**：`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 前；`protocol.handle` 必须在 `loadURL` 前。
- **目录选择器**：`NewWorkspaceModal` 的"浏览…"按钮通过 preload IPC 调系统对话框。

### Phase 4 完成：移除 Web 产品路径

- 删除 `packages/daemon/src/static-server.ts`；`WsServer` 独立监听 loopback，不再附着 HTTP server。
- `packages/daemon/src/index.ts` 精简为 WS-only（`wsServer.ready()` 等待监听）。
- 验证：daemon 端口返回 `426 Upgrade Required`，浏览器无法再获得 UI。
- 根脚本：`npm run dev` = Vite(HMR) + Electron（Electron 拉起 daemon）；`npm run desktop` = 构建 + 运行。
- daemon 增加 cwd 存在性校验（原 `spawn pi ENOENT` 误导信息改为「目录不存在或不可用」）。

### Phase 5 完成（Linux 验证）：electron-builder 打包

- `packages/desktop/scripts/stage.mjs`：把 daemon dist + 运行时依赖（递归收集）+ UI 产物 stage 到 `staging/`。
- `electron-builder.yml`：`app.asar`（主进程/preload）+ `extraResources`（app-dist / daemon / icon）。
- 脚本：`build:desktop`（根）、`package:desktop`（`npm run package -w @agent-console/desktop`）、`package:dir`。
- 打包产物验证：`dist-app/linux-unpacked/@agent-consoledesktop` 无需 Vite / 手动 daemon，可创建会话、发送 prompt、正常退出。

### Phase 6 完成（核心）：Electron E2E

- `scripts/e2e-desktop.mjs`：playwright-core `_electron` 启动器，覆盖「窗口加载 → preload 连接 → 建 workspace → 建会话 → 发消息 → 收回复 → 回合结束 → 干净退出」。
- 支持 `E2E_EXECUTABLE` 指向打包二进制验证 packaged 产物。
- 运行：`npm run e2e:desktop`（dev-built）或 `E2E_EXECUTABLE=... npm run e2e:desktop`。

### 遗留

- macOS / Windows 打包与安装验证（需要对应环境；electron-builder.yml 已配置 dmg/nsis target）。
- `window-state.json` 持久化已实现，未在打包环境做自动回归。
- 打包的 asar 中 tree-kill 保留（desktop 直接依赖），daemon 的 node_modules 以 extraResources 方式随包分发。
