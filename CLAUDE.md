# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目一句话

**Tang Agent Dashboard**（npm 名 `agent-console`）：Electron 桌面中控台，统一管理 Pi / Codex / Claude Code / OpenCode 四个 AI 编码 agent。前身借鉴 Paseo，需求收敛为**纯桌面版**（无浏览器入口）。权威文档 `docs/PLAN.md`。

## 开发命令（npm workspaces，Node ≥ 20）

根 `package.json` 已聚合常用脚本，按需单包执行：

| 命令 | 用途 |
|---|---|
| `npm run build` | 按 protocol → daemon → ui → desktop 顺序构建 |
| `npm run build:desktop` | 仅构建 desktop 壳 |
| `npm run dev` | `node scripts/dev.mjs`：并行起 Vite(5173) + Electron（主进程拉 daemon） |
| `npm run dev:ui` | 仅 Vite 渲染端 HMR（daemon 需另起） |
| `npm run start` / `npm run desktop` | 构建后启动桌面壳 |
| `npm run e2e:desktop` | 构建 + `node scripts/e2e-desktop.mjs`（Playwright-core + 系统 Chromium） |

单包：`npm run build -w @agent-console/<pkg>`；daemon 开发态可用 `-w @agent-console/daemon run dev`（`tsx watch src/index.ts`）。

**冒烟测试**（无需 UI，单 agent 一句话）：
```
npx tsx packages/daemon/src/cli-test.ts pi "你好" /tmp/test-cwd
npx tsx packages/daemon/src/cli-test.ts opencode "你好" /tmp/test-cwd "zrocode/gpt-5.6-luna"
```

**桌面打包**（Linux）：`cd packages/desktop && npm run package`（产物 `packages/desktop/dist-app/*.AppImage` / `.deb`）。mac/win 已配置 electron-builder.yml，签名留待发布环境。

## 架构（一张图）

```
packages/ui (React + Vite) ──WS──► packages/daemon (Node/TS, 127.0.0.1:8765) ──spawn──► 4 个 agent 子进程
                                              ▲
                                              │ daemon-manager（spawn/health/exit cleanup）
                                  packages/desktop (Electron)
                                              │
                                  tang-ai-chat://app/ 协议加载 ui/dist
                                  preload IPC: dialog/openExternal/daemon-exit
```

依赖方向：`ui → protocol`、`daemon → protocol`、`desktop → ui(dist) + daemon(binary)`。desktop **不**依赖 ui/daemon 源码，只消费产物。

**协议面**（`@agent-console/protocol`，唯一对外契约）：
- `agent-sdk-types.ts`：`AgentProvider`、`AgentStreamEvent`、`ToolCallDetail`、`AgentPermissionResponse`、`AgentMode`、`AgentModelDefinition`...
- `rpc.ts`：WS 消息形状。客户端请求 `providers.list | agent.create/prompt/interrupt/close | agent.model.set | agent.thinking.set | agent.permission.respond | sessions.list | session.resume | agent.modes | agent.models`；服务端推送 `session.ready | agent.event | agent.closed`；附带 `SessionSummary`、`ClientResponse`。

## 包内分工

- **`packages/protocol`** — 共享类型。改动会同时影响 daemon / ui。
- **`packages/daemon`**
  - `index.ts` 入口；CLI `--port` 覆盖默认 8765
  - `ws-server.ts` — loopback WS，事件 → 广播给所有 client
  - `agent-manager.ts` + `session-store.ts` — 会话集合；落盘 SQLite `~/.agent-console/sessions.db`（WAL；首次启动自动从旧版 `sessions.json` 迁移并归档）
  - `provider-runner.ts` — 回合编排（startTurn + 事件订阅 → 收 timeline → 等终态）
  - `providers/{pi,codex,claude,opencode}/agent.ts` — 各自 agent 的 client 实现，工厂 `providers/index.ts::createClient`
  - `jsonl-rpc-process.ts` / `spawn.ts` / `tree-kill.ts` — 子进程与进程治理
  - `config.ts` — `~/.agent-console/config.json`（provider 启用/命令覆盖/端口）；`executable-resolution.ts` 解析二进制（Windows `.cmd`）
- **`packages/ui`**
  - `ws.ts` — `DaemonClient` + `resolveDaemonWsUrl`（preload → `?ws=` → 默认 8765）
  - `App.tsx` 主界面 + `state.ts`（workspace 聚合、事件归约）
  - `theme.ts`、`App.css` — 设计 token（见 `docs/DESIGN-SYSTEM.md` v1）
  - `components/` — `Sidebar` / `TabsRow` / `Topbar` / `Timeline` / `Composer` / `PermissionCard` / `Modals`
- **`packages/desktop`**
  - `main.ts` 入口：单实例锁 → 注册 `tang-ai-chat://` scheme → daemon-manager → IPC handler → 窗口
  - `daemon-manager.ts` — spawn daemon 子进程、健康探测、退出时 tree-kill 整个 agent 进程树
  - `protocol-handler.ts` — 自定义协议 + SPA fallback + 路径穿越校验
  - `preload.ts` — 暴露 `window.tang`（getConfig/openDirectory/openExternal/onDaemonExit）
  - `window-manager.ts` — 位置/尺寸/最大化持久化
  - `electron-builder.yml` — linux AppImage/deb 已验证，mac/win 已配置

## 关键约定与坑

1. **daemon 端口 8765** loopback only（`AGENT_CONSOLE_PORT` env 覆盖），端口被占时 daemon 启动失败提示。**不要**让浏览器访问此端口——浏览器不会得到 UI，UI 必须由 Electron 加载。
2. **tsconfig.base.json** 启用了 `noUncheckedIndexedAccess: true`：所有数组下标访问必须处理 `undefined`，包括 `process.argv[i+1]` 这种。strict 全开。
3. **opencode**：`opencode serve` 必须用中性 home `~/.agent-console/opencode-home` 启动，否则把用户家目录当 workspace 索引；模型列表需从用户 `~/.config/opencode/opencode.json` 解析。
4. **pi**：系统提示注入走动态 `--extension` 文件，**不要**用 `--append-system-prompt`（会替换 Pi 自带 APPEND_SYSTEM.md）；MCP 走 per-agent `--mcp-config` 文件并叠加原 `mcp.json`（见 `providers/pi/mcp.ts`）；文本模型不支持图片，需 `model.input` 含 "image" 才发图，否则会污染历史。
5. **codex**：`session.abort` 取消整个会话而非单轮，stop 边界要在 provider 会话内处理；`turn/start` 当前 90s 超时。
6. **opencode 用户消息 id** 由 opencode 自己生成（`msg*`），不要传自己的 id。
7. **PATH 补齐**：`scripts/dev.mjs` 与 desktop 的 `buildChildEnv` 都把 `node_modules/.bin` / nvm bin 注入 PATH，否则非交互 shell 找不到 agent 二进制（spawn ENOENT）。
8. **daemon cwd 校验**：`agent-manager.createSession` 校验目录存在性，否则报「目录不存在或不可用」（不是误导的 `spawn pi ENOENT`）。
9. **agent.close** 仅对已加载 active 会话生效，未加载会话需二期处理（见 `FRONTEND-PLAN.md` §9.5 #3）。

## 进程治理纪律（事故教训，docs/FRONTEND-PLAN.md §10）

- 杀进程前 `ps -p <pid> -o comm,args` 确认身份，**只杀自己启动的**
- 优先 `kill <pid>`（TERM），禁用 `kill -9` 与宽泛 `pkill -f`
- 端口占用 `ss -tlnp`；TIME_WAIT 等 60s
- 启停 dev/daemon 前告知用户；批量清理不要在用户在场时做

## 测试

- 没有传统的 unit test 套件。冒烟靠 `cli-test.ts`（provider 真实回合）；UI 自动化 `scripts/e2e-desktop.mjs`（Playwright-core + 系统 Chromium，9/9 通过）；可针对打包产物设置 `E2E_EXECUTABLE=packages/desktop/dist-app/linux-unpacked/@agent-consoledesktop npm run e2e:desktop`。
- UI 自动化跑在打包后的 Electron 窗口里，覆盖欢迎页→建 workspace→建会话→发消息→markdown→关会话→多会话全链路。

## 设计系统速查

`docs/DESIGN-SYSTEM.md` v1 已定稿。暗色优先，珊瑚橙 `#cd8f74` 仅点缀（发送按钮/选中态）。四 agent 身份色与品牌严格分离：Pi `#7c5cd6` / Codex `#4b54ff` / Claude `#b05a48` / OpenCode `#3f7f5f`，只用于身份识别，禁止装饰。原型真源 `design/preview.html`。

## 关键参考

- `docs/PLAN.md` — 全栈计划与里程碑（M1/M2/M3 已完成）
- `docs/FRONTEND-PLAN.md` — 前端 v2 计划、workspace IA、问题清单、运维纪律
- `docs/DESKTOP-PLAN.md` / `DESKTOP-MIGRATION-PLAN.md` — 桌面壳方案与迁移落地
- `docs/DESIGN-SYSTEM.md` — 设计 token 与组件规范
- `docs/UI-DESIGN.md` — 早期 UI 设计（部分被 FRONTEND-PLAN.md v2 取代，IA 与品牌以 DESIGN-SYSTEM 为准）

## 外部参考（开发时常用）

> 环境：Linux Mint。**官网文档更新常常滞后**，以**源码 + 本机实际安装版本**为准（见各 agent 子节）。

### 可借鉴的项目（同级目录 `/home/tang/project/ai-chat/`）

| 路径 | 用途 | 主要借鉴点 |
|---|---|---|
| `paseo/` | 多 agent 中控台原型（本项目 provider 层直接抄自此处） | `packages/protocol/` WS 协议、`agent/agent-sdk-types.ts`、`agent/providers/` 四 provider 实现、`spawn.ts` / `tree-kill.ts`、`electron/` 桌面壳加载方式（Paseo 模式） |
| `CodexPlusPlus/` | Codex 的桌面端实现 | codex 桌面壳 UI、health-grid 卡片、`codex app-server` 接入范式 |
| `opencode/` | opencode 桌面版（新版） | opencode 桌面产品形态、模型目录与 provider 配置 UX |

### Agent 源码（事实源）

| Agent | 路径 | 备注 |
|---|---|---|
| opencode | `/home/tang/project/ai-chat/opencode` | 二进制 + Go 源码；新版桌面同目录 |
| codex | `/home/tang/project/ai-chat/codex` | Rust 实现；`codex app-server` 子模块 |
| pi | `/home/tang/project/ai-chat/pi` | TypeScript；`pi --mode rpc` 的 JSONL schema |

### 官网文档（仅供参考，可能滞后）

| Agent | URL |
|---|---|
| claude | https://code.claude.com/docs/zh-CN/overview |
| codex | https://learn.chatgpt.com/docs/codex/cli |
| opencode | https://opencode.ai/docs/zh-cn |
| pi | https://pi.dev/docs/latest |

### 调研/真伪优先级

1. **本机 `which <agent>` / `agent --version`** —— 确认实际安装的版本与能力
2. **同级目录源码** —— 真实协议/事件 schema（尤其 opencode、codex、pi 经常领先文档）
3. **可借鉴项目** —— 看别人怎么接、有没有坑（paseo、CodexPlusPlus）
4. **官网文档** —— 最后兜底，遇到与源码冲突时以源码为准