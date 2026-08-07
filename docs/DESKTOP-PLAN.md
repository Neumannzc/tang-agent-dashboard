# Desktop 方案调研与规划

> 状态：**已落地（2026-08-07）**，具体实现与验证见 `DESKTOP-MIGRATION-PLAN.md` §9
> 背景：早期调研面向 Expo/React Native 三端；随后需求收敛为纯桌面版（Vite + React + Electron，见 `FRONTEND-PLAN.md` v2），本文档保留为方案调研与架构依据
> 以下 §1 调研结论仍有效（选 Electron 而非 Tauri）；§2 的方案描述以最终实现为准

---

## 1. 调研：现有 agent desktop 实现方案

### 1.1 分类总览

| 方案 | 壳技术 | UI 来源 | 后端/daemon | 与本项目的相似度 |
|---|---|---|---|---|
| **Paseo** | Electron | **Expo app 的 web 产物** | **Electron 主进程内置 daemon 管理** | ★★★★★ 同构 |
| OpenCode | 无壳 | 自带 web UI（`opencode serve` + 浏览器） | 本地 Go 二进制 | ★★★ 思路参考 |
| Cherry Studio | Electron | 内置 React 前端 | 无 daemon（纯前端直连 LLM API） | ★★ 壳/分发参考 |
| Jan | Electron | 内置 React 前端 | 本地推理运行时（无 agent 子进程概念） | ★★ 同上 |
| Cursor / Windsurf | Electron（VS Code fork） | 完整 IDE | 内置 | ★ 太重，不借鉴 |
| Claude/ChatGPT Desktop | Electron（闭源） | 内置 | 云端 | ★ 无从参考内部 |
| Tauri 系（Amp 等） | Tauri（Rust + 系统 WebView） | Web 产物或原生混合 | 各异 | ★★★ 轻量趋势，有兼容性风险 |

### 1.2 Paseo（深度调研，最相关参考）

Paseo 恰好就是 "**Expo app + Electron 壳 + 复用 web 产物**" 的成熟实现，且本项目 provider 层本就抄自 Paseo，架构同源，借鉴成本最低。其 desktop 方案要点：

**加载方式（关键）**
- 开发模式：`BrowserWindow.loadURL(EXPO_DEV_URL)` —— 直接连 Metro dev server，热更新
- 生产模式：**自定义协议 `paseo://`** + `protocol.handle()` 从 `process.resourcesPath/app-dist` 读 Expo `expo export --platform web` 的静态产物；带 **SPA fallback**（无扩展名的路径 → 返回 index.html）和路径穿越防护（`path.relative` 校验）

**daemon 治理**
- Electron 主进程内置 **daemon-manager**：spawn server 子进程、健康检查、退出时优雅关闭（quit-lifecycle：先通知 renderer → 关 transport → 停 daemon → 装更新 → 退出）
- **local-transport**：renderer ↔ daemon 通过 socket/pipe/本地 WS 传输，不依赖固定端口
- 登录 shell 环境继承（macOS GUI 应用拿不到 PATH，需从 login shell 继承）

**桌面增强**（壳的全部价值所在）
- 深链 `paseo://`（从 CLI/浏览器唤起并路由到指定会话/项目）、单实例锁、多窗口
- 窗口状态持久化（位置/尺寸/最大化）、系统主题
- 系统对话框（目录选择、文件）、通知、托盘
- 自动更新（electron-updater，GitHub release）、应用菜单（macOS 兼容）
- CLI 透传（`paseo [path]` 启动即打开项目）

**打包分发**（electron-builder）
- mac：dmg + zip，hardenedRuntime + notarize（公证）
- win：nsis 安装器 + zip，x64 + arm64
- linux：AppImage + deb + rpm
- `extraResources` 放 app-dist / 图标 / 内置二进制；asarUnpack 个别需要原生访问的文件
- 安全基线：contextIsolation: true、nodeIntegration: false、sandbox: true

### 1.3 OpenCode（CLI + serve 思路）

Go 单二进制，无独立桌面壳。`opencode serve` 起本地 HTTP 服务，浏览器/IDE 插件接入。**结论**：桌面体验 = 浏览器 + 本地服务，零安装成本，但缺系统集成（托盘/深链/目录选择），且每个 agent 一个服务，本项目要统一四个 agent，该模式不适用。

### 1.4 Cherry Studio / Jan（chat 客户端）

均为 Electron + React，体积大但生态成熟（electron-builder 分发、多平台）。但它们**没有 daemon/子进程概念**（Cherry 纯前端直连 API，Jan 内嵌推理运行时），而本项目必须持有四个 agent 子进程 → 架构不适用，仅壳与分发经验可参考。

### 1.5 Cursor / Claude Desktop

Cursor 是 VS Code fork（Electron），功能完整但需维护整个编辑器代码库，远超本项目范围。Claude Desktop 闭源。均不借鉴。

### 1.6 Tauri 系与 PWA 趋势

- **Tauri**：体积小（~10MB vs Electron ~100MB+）、用系统 WebView（mac WKWebView / win WebView2）。**风险**：react-native-web 在非 Chromium WebView 上的兼容性（flex 布局、WebSocket、剪贴板、CSS 变量等），以及 mac/win WebView 行为不一致需要双端测试。Amp（Sourcegraph）曾用 Tauri + Swift/Kotlin 原生混合，已转向/闭源，参考价值有限。
- **PWA**：零安装，但缺系统集成与本地 daemon 托管，不适合桌面主力形态。

### 1.7 调研结论

1. **本项目与 Paseo 完全同构**（Expo app + Electron 壳 + 内置 daemon），且代码同源（provider 层抄自 Paseo），直接按 Paseo 模式裁剪落地成本最低。
2. agent 控制台**必须有 daemon**（持有子进程），纯前端 chat 客户端架构（Cherry/Jan）不适用。
3. **选 Electron 而非 Tauri**：① react-native-web 在 Chromium 渲染零兼容性风险；② daemon 是 Node，Electron 主进程可直接 spawn/tree-kill（复用现有 `spawn.ts`/`tree-kill.ts`）；③ 与 Paseo 一致，代码可抄；④ 体积大是唯一缺点，对桌面开发工具可接受。
4. 桌面端相对 web/移动端的核心增量 = **本地 daemon 免运维**（自动起停）+ **系统集成**（目录选择、托盘、深链、自动更新）。

---

## 2. 本项目 desktop 方案（重新规划）

### 2.1 定位与范围

- `packages/desktop`：Electron 壳，**只做窗口 + daemon 托管 + 系统集成**，不含任何业务 UI（业务全在 Expo app 的 web 产物里）
- 本期范围：窗口加载、daemon 自动起停、目录选择对话框、深链、菜单、窗口状态持久化
- 二期（预留，不实现）：托盘、自动更新、多窗口、系统通知

### 2.2 架构（最终实现：Vite + React）

```
packages/ui (Vite + React)              packages/daemon (Node)
  vite build / dev(5173)                    ws-server (127.0.0.1:PORT, loopback only)
  └── dist/* ─────────────────┐               ▲
                              ▼               │ WS (同一协议)
packages/desktop (Electron)  ┌────────────┐  ┌────────────────┐
  src/main.ts ──────────────►│ BrowserWindow │──┐ spawn / tree-kill
  src/protocol-handler.ts    │  loadURL      │  │
  src/daemon-manager.ts ─────►│  (dev: Vite)  │  ▼
  src/window-manager.ts      │  (prod: tang-ai-chat://app/)│ daemon 子进程（四 agent 孙进程）
  src/preload.ts (IPC 桥)     └────────────┘
```

### 2.3 壳加载方式（最终实现）

- **dev**：`loadURL(http://127.0.0.1:5173)`，Vite 做 renderer HMR；daemon 由 Electron 主进程拉起
- **prod**：自定义协议 `tang-ai-chat://app/` → `resources/app-dist`（UI 产物），含 SPA fallback + 路径穿越防护（见 `src/protocol-handler.ts`）
- **传输**：renderer 直连 `ws://127.0.0.1:<daemon端口>`（daemon 只 bind 127.0.0.1）；端口由 Electron 持有（env `AGENT_CONSOLE_PORT` 或默认 8765）

### 2.4 daemon 生命周期（桌面端核心价值）

```
启动：desktop 起窗口前先 spawn daemon → health check（WS ping / HTTP /health）→ ready 后加载 UI
退出：窗口关闭 → 通知 renderer 保存 → 停 daemon（tree-kill，含 agent 孙进程）→ 退出
异常：daemon 崩溃 → 主进程检测 → UI 显示重连/重启（复用 UI 的 ConnectionBanner）
```

**三模式连接**（UI 侧 `connect(url)` 已是参数化设计，天然支持）：

| 模式 | 场景 | daemon 来源 |
|---|---|---|
| 桌面一体化（默认） | Electron | 壳自动托管 |
| 外连本地 | Web/移动端开发 | 用户自己跑 `npm run dev:daemon` |
| 外连远程 | 移动端真机/异地 | 配置 daemon 地址（二期：中继） |

### 2.5 桌面特有能力（preload IPC 桥 + UI 平台分支）

| 能力 | IPC 通道 | UI 用法 |
|---|---|---|
| **目录选择** | `dialog:openDirectory` | 新建会话的 cwd 用系统对话框选择（替代手输，桌面端体验关键项） |
| 深链 `agent-console://session/<id>` | `deep-link:route` | 浏览器/CLI 唤起直达指定会话 |
| 系统通知 | `notify` | 回合完成/权限请求时提示（UI 事件订阅） |
| 窗口状态 | 壳内处理 | 位置/尺寸/最大化持久化 |
| 应用菜单 | 壳内处理 | mac 兼容（About/Quit/新建窗口） |
| 打开外部链接 | `shell:openExternal` | 代码中 URL/路径点击用系统浏览器打开 |

UI 侧约定：**业务组件零平台分支**，通过 `Platform.OS === 'web' && window.desktopBridge` 探测桌面桥，能力可用才显示（如"选择目录"按钮仅桌面显示）。

### 2.6 打包与分发（electron-builder）

```
electron-builder.yml
  appId: io.agent-console.desktop
  files: dist/**  (主进程产物)
  extraResources:
    - from: ../ui/dist        → app-dist   (Expo web 产物)
    - from: assets/icon.png   → icon.png
  mac:    dmg + zip（x64+arm64），hardenedRuntime + notarize（发布时配置）
  win:    nsis + zip（x64+arm64）
  linux:  AppImage + deb
```

脚本：`npm run build:desktop` = `expo export (ui)` → `tsc (desktop)` → `electron-builder`。

### 2.7 安全基线

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`；preload 只暴露白名单 IPC；自定义协议仅服务 app-dist 内的静态文件（路径穿越校验）。

### 2.8 三端差异化矩阵

| 能力 | iOS/Android | Web 浏览器 | Desktop (Electron) |
|---|---|---|---|
| daemon | 外连远程 | 外连本地/远程 | **自动托管（默认）** |
| cwd 选择 | 不可用（daemon 侧默认） | 手输 | **系统目录选择器** |
| 深链 | 通用 scheme | 无 | `agent-console://` |
| 系统通知 | 推送（二期） | 浏览器通知（二期） | 桌面通知（二期） |
| 布局 | compact 单栏 | 响应式分栏 | expanded 分栏 + 桌面菜单 |

### 2.9 monorepo 集成与 dev 工作流（最终实现）

```
npm run dev        = node scripts/dev.mjs
                     ├── ui (vite dev server, 5173, renderer HMR)
                     └── desktop (electron，主进程内拉 daemon，加载 http://127.0.0.1:5173)
npm run desktop    = npm run build && electron（dev 场景加载 ui/dist 或 Vite）
npm run package -w @agent-console/desktop = stage（daemon+deps+ui）→ electron-builder（Linux）
```

依赖方向：`desktop → ui(dist)`、`desktop → daemon(spawn)`；`ui → protocol`、`daemon → protocol`。desktop 不依赖 ui/daemon 源码，只消费产物。

### 2.10 实施顺序与验证（已完成，2026-08-07）

```
D1 壳骨架：desktop 包 + 窗口 + dev 模式 loadURL(Vite)     → ✅ dev 全链路跑通
D2 生产加载：tang-ai-chat:// 协议 + SPA fallback + 打包     → ✅ 打包产物离线可跑（E2E 通过）
D3 daemon 托管：spawn/端口探测/退出清理（tree-kill）       → ✅ 关窗口 daemon 进程树清干净（端口释放验证）
D4 桌面集成：目录选择对话框 + 窗口状态持久化               → ✅ preload IPC + window-state.json
D5（后续）深链、菜单、系统通知                            → ⏳ 二期
```

### 2.11 与现有文档的衔接

- `docs/UI-DESIGN.md` §9（原 Electron 壳草稿）→ 以 `DESKTOP-MIGRATION-PLAN.md` + `FRONTEND-PLAN.md` v2 为准
- 技术栈已定：Vite + React + Electron（无 Expo/RN）

---

## 3. 决策清单（已定稿）

1. ✅ 桌面端 = Electron 壳（Paseo 模式），不引入 Tauri —— 理由见 §1.7
2. ✅ desktop 包只消费 ui 产物 + daemon 二进制，不依赖两者源码
3. ✅ 传输用 `ws://127.0.0.1:<port>`，不做 Paseo 的 local-transport 抽象
4. ✅ 深链 scheme：`tang-ai-chat://`（产品名已定；深链路由本身为二期）
5. ✅ daemon 端口：固定 8765（env `AGENT_CONSOLE_PORT` 可覆盖），Electron 持有；端口被占时启动失败提示
6. ✅ mac/win 打包配置已就绪（electron-builder.yml），签名/公证留待发布环境
