# Agent Console 开发计划

> 目标：开发一个 **桌面端** 中控台（Electron），统一与 **Pi、Codex、Claude Code、OpenCode** 四个 agent 对话。
> 产品形态已收敛为桌面版：浏览器不再作为产品入口（详见 `docs/DESKTOP-MIGRATION-PLAN.md`）。
> 借鉴 Paseo（`/home/tang/project/ai-chat/paseo`）的 provider 抽象与进程治理思路。

---

## 1. 范围

### 要做（MVP）
- Daemon（Node + TS）：常驻进程，持有四个 agent 的子进程，暴露 WS + HTTP 接口
- Web UI（React + Vite）：聊天 timeline + 输入框 + 权限对话框 + 模型/模式选择
- 四类 provider 接入：
  - **pi**：JSONL-over-stdio RPC（`pi --mode rpc`）
  - **codex**：`codex app-server` 自定义 stdio JSON-RPC
  - **claude**：`@anthropic-ai/claude-agent-sdk` 官方 SDK
  - **opencode**：`opencode serve` 长驻 HTTP server + 官方 SDK
- 权限/审批桥接：agent 请求工具/提问 → UI 弹窗 → 用户决策 → 写回 agent
- 事件流归一化：各协议事件 → 统一 `AgentStreamEvent` → 广播给 UI
- 基础会话管理：创建、对话、中断、退出；进程治理（tree-kill）

### 不做（本期明确排除）
- 移动端 / desktop 壳（二期再说，架构上预留）
- OMP / Copilot / Cursor / ACP 等其它 provider
- 语音、STT/TTS、forge/git 远程、review、日程、浏览器自动化、云中继、多语言
- 复杂前端 store（项目注册、workspace、git diff、附件系统）

---

## 2. 架构

```
┌─────────────────────┐      WS (事件流/请求-响应)      ┌──────────────────────┐
│  Web UI (React)     │ ◄────────────────────────────► │  Daemon (Node/TS)    │
│  - timeline         │                                │  - ws-server         │
│  - composer         │                                │  - agent-manager     │
│  - permission dialog│                                │  - providers/        │
└─────────────────────┘                                │      pi/ codex/      │
                                                       │      claude/ opencode│
                                                       └──────────┬───────────┘
                                                                  │ spawn / tree-kill
                                              ┌───────────────────┼───────────────────┐
                                              │ pi --mode rpc     │ codex app-server   │
                                              │ opencode serve    │ claude (SDK)       │
                                              └───────────────────┴───────────────────┘
```

### 借鉴自 Paseo 的模块（直接抄/裁剪）

| Paseo 文件 | 用途 | 处理 |
|---|---|---|
| `agent/agent-sdk-types.ts` | `AgentClient`/`AgentSession` 接口、`AgentStreamEvent` 事件模型 | 抄接口 + 事件类型（裁剪掉用不到的事件） |
| `agent/providers/provider-runner.ts` | 回合编排：startTurn + 订阅事件 → 收集 timeline → 等终态 | 抄 |
| `agent/providers/jsonl-rpc-process.ts` | Pi/Codex 的 JSONL 子进程收发 | 抄 |
| `agent/providers/pi/` (agent/runtime/cli-runtime/rpc-types) | Pi provider | 抄，裁剪 OMP 相关 |
| `agent/providers/codex-app-server-agent.ts` + `codex/app-server-transport.ts` | Codex provider | 抄 |
| `agent/providers/claude/agent.ts` + `query.ts` | Claude provider | 抄 |
| `agent/providers/opencode-agent.ts` + `opencode/server-manager.ts` | OpenCode provider | 抄（server-manager 可简化） |
| `provider-launch-config.ts` | 二进制解析 + 命令/环境覆盖 | 抄，简化 |
| `utils/spawn.ts`、`utils/tree-kill.ts` | 进程 spawn 与优雅/强制终止 | 抄 |
| `packages/protocol/` | 客户端-服务端消息类型 | 抄思想，按需精简 |
| `client/daemon-client-websocket-transport.ts` | WS 传输 | 参考实现，可自写简化版 |

---

## 3. 技术栈

- **Monorepo**：npm workspaces（`daemon` / `ui` / `protocol` / `desktop` 四个包）
- **Daemon**：Node + TypeScript（>=20），仅暴露 loopback WebSocket RPC
- **UI**：React + Vite + TypeScript，原生 WS（不引重框架）；Vite 仅作 Electron 开发期 HMR 工具
- **桌面壳**：Electron（主进程拉 daemon、`tang-ai-chat://app/` 协议加载打包 UI、preload IPC 桥）
- **协议**：WS 上 JSON 请求-响应（带 requestId）+ 事件推送（`type` 区分）

---

## 4. 实施阶段

### Phase 0：项目骨架
- [x] 本文档
- [x] npm workspaces 初始化（daemon/ui/protocol 三包）
- [x] TS 配置、lint（可选）、dev 脚本（daemon + ui 并行，`npm run dev`）
- **验证**：`npm run dev` 能起 daemon 空进程 + Vite 页面 ✅

### Phase 1：Provider 层 —— 先 Pi，再 Codex/OpenCode/Claude
- [x] `protocol` 包：`AgentStreamEvent` 等共享类型
- [x] daemon：`spawn.ts` / `tree-kill.ts` / `jsonl-rpc-process.ts`
- [x] daemon：`agent-sdk-types.ts`（AgentClient/AgentSession 接口）
- [x] provider: **pi** —— spawn `pi --mode rpc`，实现 prompt/事件/中断/退出
- [x] provider: **codex** —— spawn `codex app-server`，thread/start + turn/start + 通知事件
- [x] provider: **opencode** —— spawn `opencode serve` + SDK promptAsync + SSE 事件
- [x] provider: **claude** —— SDK query + canUseTool 权限桥
- [x] `provider-registry.ts`：按 id 创建 client
- **验证**：CLI 测试入口 `npx tsx packages/daemon/src/cli-test.ts <provider> <prompt> <cwd> [model]`，四个 agent 各发一句话均正常 ✅
  - 注：opencode 默认模型可能不可用（如 htx/gpt-5.6-terra 返回 Service temporarily unavailable），可显式传 `zrocode/gpt-5.6-luna` 这类可用模型

### Phase 2：会话编排 + 权限桥接
- [x] `agent-manager.ts`：会话集合、创建/恢复/中断/销毁
- [x] `provider-runner.ts`：回合编排（抄）
- [x] 权限归一化：`AgentPermissionRequest`（tool/question/plan）+ `respondToPermission`
- **验证**：CLI 自动应答权限 + 浏览器权限对话框允许/拒绝均通过 ✅

### Phase 3：Web 中控台
- [x] daemon：`ws-server.ts`（WS 请求-响应 + 事件广播）
- [x] `protocol` 包：客户端消息类型（create agent / send prompt / respond permission / stream events）
- [x] UI：timeline 渲染（消息、工具调用、权限卡片）
- [x] UI：composer（输入、选 provider/模型/模式、发送、中断）
- [x] UI：权限对话框
- **验证**：浏览器 E2E（`node scripts/e2e-test.mjs` / `scripts/e2e-perm.mjs`）完成"选 agent → 发消息 → 看事件流 → 处理权限" ✅

### Phase 4：会话持久化与恢复
- [x] `session-store.ts`：恢复句柄落盘 `~/.agent-console/sessions.json`
- [x] pi：用 JSONL session 文件 resume（nativeHandle）
- [x] codex / opencode / claude：会话 id 恢复（`session.resume`）
- **验证**：重启 daemon 后 `sessions.list` + `session.resume` 恢复历史会话，pi 能记住上文 ✅

### Phase 5：收尾
- [x] 模型/模式目录（`agent.models` / `agent.modes`；opencode 从用户 `~/.config/opencode/opencode.json` 解析）
- [x] 配置文件 `~/.agent-console/config.json`（provider 启用开关、命令覆盖、WS 端口）
- [x] MCP 注入（pi `--mcp-config`：写 per-agent 文件并叠加原 mcp.json）
- [x] desktop 封装（Electron 壳包 daemon + UI：`packages/desktop`，主进程拉起 daemon → 等待就绪 → 加载本地 UI；daemon 同端口提供 HTTP(静态 UI) + WS）

---

## 5. 风险与注意事项（源自 Paseo 踩坑注释）

1. **opencode serve cwd**：必须用中性 home 目录启动，否则 opencode 把用户家目录当 workspace 索引（`~/.agent-console/opencode-home`）
2. **pi 系统提示词注入**：用动态生成的 extension 文件（`--extension`），不要用 `--append-system-prompt`（该 flag 会替换 Pi 自己的 APPEND_SYSTEM.md）
3. **pi MCP 注入**：写 per-agent `--mcp-config` 文件并保留原 `mcp.json` 再叠加（`providers/pi/mcp.ts`）
4. **codex 取消语义**：`session.abort` 取消整个会话而非单轮；stop 边界要在 provider 会话内处理
5. **codex `turn/start` 超时**：有 TURN_START_TIMEOUT_MS 限制，注意慢模型场景（当前 90s）
6. **pi 文本模型不支持图片**：只有 model.input 含 "image" 才能发 images，否则会被拒并污染历史
7. **opencode 用户消息 id**：由 opencode 自己生成（msg*），不要传自己的 id
8. **Windows**：`.cmd` 二进制需解析到真实 exe（claude/codex/opencode 均有对应处理），MVP 可先忽略
9. **opencode 模型目录**：server 用中性 home 启动导致 v2 model list 为空，需从用户 opencode.json 解析

---

## 6. 里程碑

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| M1 | Phase 0-1 完成 | CLI 可与四个 agent 对话 | ✅ 已完成（`cli-test.ts`） |
| M2 | Phase 2-3 完成 | 浏览器可用中控台，含权限处理 | ✅ 已完成（E2E 验证） |
| M3 | Phase 4-5 按需 | 会话恢复 + desktop 壳（二期） | ✅ 已完成（会话恢复 + Electron 壳） |

---

## 7. 使用方式

```bash
npm install
npm run dev          # Vite(HMR) + Electron；Electron 自动拉起 daemon，加载 Vite URL
npm run build        # 构建 protocol + daemon + ui + desktop
npm run desktop      # 构建后运行桌面壳（dev 场景，tang-ai-chat:// 加载 ui/dist）

# CLI 冒烟测试（Phase 1 验证）
npx tsx packages/daemon/src/cli-test.ts pi "你好" /tmp/test-cwd
npx tsx packages/daemon/src/cli-test.ts opencode "你好" /tmp/test-cwd "zrocode/gpt-5.6-luna"

# 桌面 E2E（Electron 窗口内完整流程）
npm run e2e:desktop
# 对打包产物验证：
# E2E_EXECUTABLE=packages/desktop/dist-app/linux-unpacked/@agent-consoledesktop npm run e2e:desktop

# 打包（Linux）
cd packages/desktop && npm run package   # 产出 dist-app/*.AppImage / *.deb
```

**桌面版是唯一入口**：UI 由 Electron 壳通过 `tang-ai-chat://app/` 协议加载（生产）或 Vite（开发 HMR）；daemon 由壳自动拉起并持有，退出时清理 agent 子进程树。daemon 端口仅回环监听，浏览器打开 daemon 端口不会得到 UI。

## 8. 完成情况

| 里程碑 | 验收 | 状态 |
|---|---|---|
| M1 | CLI 与四个 agent 对话 | ✅ |
| M2 | 浏览器可用中控台，含权限处理 | ✅ |
| M3 | 会话恢复 + desktop 壳 | ✅ |
