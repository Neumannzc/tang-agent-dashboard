# Tang Agent Dashboard

> Electron 桌面中控台，统一管理 **Pi / Codex / Claude Code / OpenCode** 四个 AI 编码 agent。

纯桌面版（无浏览器入口），由 Electron 壳加载前端并管理 daemon 进程。前身借鉴 Paseo，需求已收敛为桌面中控。

## 特性

- **多 Agent 统一管理**：同一界面下创建/切换会话，对接 Pi、Codex、Claude Code、OpenCode 四种 agent
- **实时回合流**：通过 daemon 的 WS 协议订阅 agent 事件，流式呈现 timeline
- **会话持久化**：会话落盘 `~/.agent-console/sessions.json`，支持恢复续聊
- **权限卡片**：agent 请求工具调用时弹出权限确认卡片
- **暗色优先设计**：珊瑚橙点缀，四 agent 身份色严格隔离品牌

## 架构

```
packages/ui (React + Vite) ──WS──► packages/daemon (Node/TS, 127.0.0.1:8765) ──spawn──► 4 个 agent 子进程
                                              ▲
                                              │ daemon-manager（spawn/health/exit cleanup）
                                  packages/desktop (Electron)
                                              │
                                  tang-ai-chat://app/ 协议加载 ui/dist
                                  preload IPC: dialog/openExternal/daemon-exit
```

依赖方向：`ui → protocol`、`daemon → protocol`、`desktop → ui(dist) + daemon(binary)`。desktop 不依赖 ui/daemon 源码，只消费产物。

### 包结构（npm workspaces）

| 包 | 说明 |
|---|---|
| `packages/protocol` | 共享类型与 WS RPC 契约，唯一对外接口面 |
| `packages/daemon` | Node/TS 后端，管理 agent 子进程生命周期、会话与事件广播 |
| `packages/ui` | React + Vite 前端，含 Sidebar / Timeline / Composer / PermissionCard 等组件 |
| `packages/desktop` | Electron 桌面壳：自定义协议、daemon-manager、IPC preload、打包 |

## 环境要求

- **Node.js ≥ 20**
- 已安装至少一个 agent 二进制（`pi` / `codex` / `claude` / `opencode`），需在 PATH 中可用

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式：并行启动 Vite(5173) + Electron（主进程自动拉起 daemon）
npm run dev

# 仅前端 HMR（daemon 需另起）
npm run dev:ui

# 完整构建（protocol → daemon → ui → desktop）
npm run build

# 构建并启动桌面壳
npm run desktop
```

### 冒烟测试（无需 UI）

```bash
npx tsx packages/daemon/src/cli-test.ts pi "你好" /tmp/test-cwd
npx tsx packages/daemon/src/cli-test.ts opencode "你好" /tmp/test-cwd "zrocode/gpt-5.6-luna"
```

### 桌面打包（Linux）

```bash
cd packages/desktop && npm run package
# 产物：packages/desktop/dist-app/*.AppImage / .deb
```

mac/win 已配置 `electron-builder.yml`，签名留待发布环境。

### 端到端测试

```bash
# Headless Linux 需要 Xvfb
xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" npm run test:e2e:desktop

# 验证 linux-unpacked 打包产物
xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" npm run test:e2e:packaged
# 使用 packages/desktop/dist-app/linux-unpacked/tang-agent-dashboard
```

Playwright-core + 系统 Chromium，跑在打包后的 Electron 窗口里，覆盖欢迎页 → 建 workspace → 建会话 → 发消息 → markdown → 关会话 → 多会话全链路（9/9 通过）。

## 关键约定

- **daemon 端口 8765** loopback only（`AGENT_CONSOLE_PORT` env 覆盖）。浏览器不会得到 UI，UI 必须由 Electron 加载
- 配置存储于 `~/.agent-console/`（`config.json`、`sessions.json`）
- 详细开发约定、各 agent 适配细节与进程治理纪律见 [CLAUDE.md](./CLAUDE.md)

## 文档

- `docs/PLAN.md` — 全栈计划与里程碑（M1/M2/M3 已完成）
- `docs/FRONTEND-PLAN.md` — 前端 v2 计划、workspace IA、运维纪律
- `docs/DESKTOP-PLAN.md` / `DESKTOP-MIGRATION-PLAN.md` — 桌面壳方案与迁移落地
- `docs/DESIGN-SYSTEM.md` — 设计 token 与组件规范
- `design/preview.html` — 原型真源

## 许可证

内部项目，未开源（`private: true`）。
