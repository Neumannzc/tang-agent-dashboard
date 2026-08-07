# Agent Console UI 设计

> 状态：草稿 v1（待评审）
> 输入：`docs/UI-DESIGN-INPUT.md`（协议梳理）
> 技术栈：**Expo / React Native**（web 输出 = react-native-web）+ Electron 壳（桌面端复用 web build）

## 0. 技术栈变更说明（相对 PLAN.md）

PLAN.md 原定 "UI: React + Vite"，且明确排除移动端与 desktop 壳。本期调整为：

| 变更 | 说明 |
|---|---|
| 前端框架 | React + Vite → **Expo / React Native**（一套代码出 iOS / Android / Web） |
| Web 端 | react-native-web 输出，桌面浏览器 + Electron 通用 |
| 桌面端 | Electron 壳加载同一份 web build，不单独开发 |
| 架构影响 | daemon / protocol 完全不变（WS + 类型协议与平台无关）；仅 UI 包技术选型变化 |

**建议**：评审通过后同步更新 PLAN.md 的 Phase 3 技术栈与范围描述。

---

## 1. 平台与架构

```
┌─────────────────────────────────────────────────────────┐
│  UI 包 (packages/ui) — Expo SDK (monorepo workspace)     │
│                                                         │
│  ┌─────────────┐  ┌───────────────────┐  ┌───────────┐  │
│  │ iOS/Android │  │ Web (react-native- │  │ Electron  │  │
│  │  (原生 RN)  │  │ web 静态产物)       │  │  壳(加载  │  │
│  └─────────────┘  └───────────────────┘  │  web产物) │  │
│         └──────────────┬─────────────────┴───────────┘  │
│                   统一 WS (原生 WebSocket)               │
└────────────────────────┬────────────────────────────────┘
                         ▼
                 daemon (不变) — 四个 agent 子进程
```

**关键选型**：
- **WS 通信**：React Native 原生 `WebSocket`，iOS/Android/Web 三端 API 一致，无额外依赖
- **路由**：`expo-router`（文件路由，跨端统一）
- **状态**：`zustand`（~1KB，跨端轻量；PLAN 已排除重 store）
- **虚拟化列表**：`FlatList`（RN 内置，三端可用；MVP 够用，后续可换 FlashList）
- **Markdown**：封装统一 `<Markdown>` 组件，web 用 `react-markdown`，原生用 `react-native-markdown-display`（详见 §8）

---

## 2. 布局形态（响应式）

基于 `useWindowDimensions()` 宽度断点，一套组件两种布局：

```
compact (< 1024px，手机竖屏)          expanded (≥ 1024px，桌面/Electron/平板横屏)
┌─────────────────────┐              ┌──────────┬──────────────────────────────┐
│ 会话列表页 (全屏)      │              │ 侧边栏    │ 聊天页                        │
│ ┌─────────────────┐ │              │ 280px    │  timeline 滚动区               │
│ │ + 新建会话        │ │              │ 会话列表   │                              │
│ ├─────────────────┤ │              │ +新建     │                              │
│ │ 会话1 / 会话2 ... │ │              │          │ ──────────────────────────── │
│ └─────────────────┘ │              │          │  Composer (含模型/模式选择)    │
└─────────┬───────────┘              └──────────┴──────────────────────────────┘
          │ 点进会话                    顶部 = 连接状态 badge + 当前会话信息
┌─────────▼───────────┐
│ 聊天页 (全屏)         │  ← 返回按钮
│ timeline            │
│ composer            │
└─────────────────────┘
```

- **导航**：窄屏用 Stack（列表 ↔ 聊天）；宽屏用自定义分栏（侧边栏常驻）
- 权限对话框三端统一为**居中模态**（覆盖在 timeline 之上，禁止背景交互）

---

## 3. 信息架构（expo-router 路由）

```
packages/ui/app/
  _layout.tsx           Root：WS Provider + zustand Provider + 全局 PermissionDialog
  index.tsx             重定向：有会话 → 最近会话；无会话 → 引导页
  new-session.tsx       新建会话（provider 选择 + cwd 输入 + 模型/模式预选）
  sessions/
    index.tsx           会话列表页（窄屏全屏；宽屏由聊天页侧边栏复用此组件）
    [sessionId].tsx     聊天页（核心）
```

**引导页（无会话时）**：logo + "连接 daemon" 状态 + "新建会话" 主按钮 + 四个 provider 简介卡片。

---

## 4. 状态模型（zustand store）

```ts
// ---- 连接层 ----
type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed";

// ---- 会话层 ----
interface SessionState {
  id: string;
  provider: AgentProvider;
  cwd: string;
  status: "idle" | "running";          // 由 turn_started / turn_completed 等驱动
  turnId?: string;
  timeline: AgentTimelineItem[];
  usage?: AgentUsage;                  // turn_completed 时更新
  currentModeId?: string | null;       // mode_changed
  availableModes?: AgentMode[];
  pendingPermission?: AgentPermissionRequest;  // permission_requested
  lastError?: string;                  // turn_failed
  closed: boolean;
}

interface UIStore {
  conn: { status: ConnectionStatus; url: string; error?: string };
  sessions: Record<string, SessionState>;
  sessionOrder: string[];              // 会话列表顺序（最近活动在前）
  activeSessionId: string | null;
  providers: ProviderInfo[];           // providers.list 结果
  // actions
  connect(url: string): void;
  createSession(params): Promise<string>;   // 返回 sessionId（或从 session.ready 事件等）
  sendPrompt(sessionId: string, text: string): void;
  interrupt(sessionId: string): void;
  respondPermission(sessionId: string, reqId: string, resp: AgentPermissionResponse): void;
  applyEvent(sessionId: string, ev: AgentStreamEvent): void;   // 事件归约器（核心）
  closeSession(sessionId: string): void;
}
```

**`applyEvent` 归约逻辑**（事件 → store 变更）：

| 事件 | 变更 |
|---|---|
| `turn_started` | status=running, turnId, 清空 lastError |
| `timeline` | 追加 item（assistant_message 按 messageId 聚合，见 §6） |
| `turn_completed` | status=idle, usage 更新 |
| `turn_failed` | status=idle, lastError=error |
| `turn_canceled` | status=idle, lastError=reason |
| `permission_requested` | pendingPermission=request |
| `permission_resolved` | pendingPermission=undefined |
| `mode_changed` / `model_changed` | 更新会话元信息 |

---

## 5. 组件树与接口

```
ChatScreen
├── HeaderBar           （宽屏：会话名 + provider 徽标 + 连接状态；窄屏：+ 返回/菜单）
├── ConnectionBanner    （仅 disconnected 时显示，含重连按钮）
├── Timeline            （FlatList 虚拟化）
│   ├── UserMessageBubble
│   ├── AssistantMessageBubble   （<Markdown>）
│   ├── ReasoningBlock           （折叠）
│   ├── ToolCallCard             （按 detail.kind 分派）
│   ├── TodoList
│   ├── ErrorBanner
│   └── TurnPendingIndicator     （turn_started 后、无内容时显示 "正在运行…"）
├── TurnStatusBar       （running 时显示 spinner；idle 时显示 usage）
└── Composer
    ├── ModelModeSelector
    ├── TextInput（多行）
    └── SendButton / InterruptButton（按 status 切换）
```

### 5.1 Timeline（核心）

```ts
interface TimelineProps {
  items: AgentTimelineItem[];
  turnRunning: boolean;
  onRetry?: () => void;             // 错误重试（MVP 可无）
}

// 渲染分派：RN 不支持 JSX switch 以外的动态分发，用 Map 或函数
function renderItem(item: AgentTimelineItem): ReactElement;
```

**ToolCallCard 按 kind 分派**：

```ts
interface ToolCallCardProps {
  name: string;
  detail: ToolCallDetail;
  status: ToolCallTimelineItem["status"];
  error?: unknown;
}

// kind → 渲染
shell       → 等宽代码块 "$ command"，失败时红底
read/edit/  → 文件图标 + 路径（edit/write 可加 🔧/✏️ 区分）
write
search      → 放大镜图标 + query
fetch       → 链接图标 + url
plan/text   → 文本段落（plan 用引用样式）
unknown     → 可折叠 JSON 视图
```

### 5.2 Composer

```ts
interface ComposerProps {
  status: SessionState["status"];
  providers: ProviderInfo[];
  currentProvider: AgentProvider;
  modes: AgentMode[];           // 当前会话模式列表（agent.modes）
  currentModeId: string | null;
  onSend(text: string): void;
  onInterrupt(): void;
  onSelectModel(modelId: string): void;   // 经 daemon 设置（MVP 可只在新建时选）
  onSelectMode(modeId: string): void;
}
```

交互规则：
- `status === "running"`：输入框禁用，Send 变 Interrupt（红）
- 回车发送（桌面/Web），移动端回车换行 + 发送按钮
- 发送后立即清空输入框

### 5.3 PermissionDialog（全局模态）

```ts
interface PermissionDialogProps {
  visible: boolean;
  request?: AgentPermissionRequest;    // kind/description/detail/raw
  provider: AgentProvider;
  onRespond(resp: AgentPermissionResponse): void;
}
```

| kind | 表单 |
|---|---|
| `tool` | 详情代码块 + [允许] [拒绝] |
| `plan` | 计划全文 + [允许] [拒绝] |
| `question` | 问题原文 + 文本输入框 + [提交]（必填校验） |
| `other` | description + raw 折叠 + [允许] [拒绝] |

附加项：**"拒绝并中断回合"** 复选框（映射 `interrupt: true`，协议已支持）。不做"记住此选择"（协议无 remember 字段，UI 置灰或隐藏）。

### 5.4 会话列表 / 新建会话

```ts
interface SessionListItemProps {
  sessionId: string;
  provider: AgentProvider;
  preview: string;          // 最后一条文本（timeline 尾部取）
  status: "idle" | "running";
  timestamp: string;
  active: boolean;
}

// NewSessionScreen
provider 卡片选择（4 个，可用性用 providers.list 的 available 置灰）
cwd 输入框（默认值建议由 daemon 提供；空则用 daemon 启动目录）
模型/模式选择（可折叠高级区，MVP 可先只选 provider + cwd）
[创建并开始] → agent.create → session.ready → 进入聊天页
```

---

## 6. 关键场景数据流

**① 新建会话**
```
UI: agent.create { provider, cwd } → daemon spawn 子进程
daemon push: session.ready { sessionId, provider }
UI: sessions[sessionId] 初始化 → 跳转聊天页
```

**② 发送（核心闭环）**
```
UI: agent.prompt { sessionId, prompt }
push: turn_started            → status=running, composer 禁用
push: timeline { user_message }
push: timeline { reasoning / tool_call / assistant_message ... }  → 逐条追加渲染
push: turn_completed { usage } → status=idle, usage 上屏
```

**③ 权限桥接**
```
push: permission_requested { request } → 全局模态弹出，背景交互锁定
UI: agent.permission.respond { sessionId, requestId, behavior, value?, interrupt? }
push: permission_resolved               → 模态关闭
（tool 执行结果随后以 timeline tool_call completed 事件回来）
```

**④ 中断**：`agent.interrupt` → push `turn_canceled` → status=idle + 提示。

---

## 7. 视觉规范（建议，可调整）

- **主题**：暗色为主（coding agent 场景），可选浅色
- **主色**：中性深灰背景 `#0f1115` / 面板 `#16181d` / 边框 `#26282e` / 文本 `#e6e8ec`
- **Provider 品牌色**（徽标/高亮）：pi `#8b5cf6`、codex `#f97316`、claude `#d97757`、opencode `#22c55e`
- **状态色**：成功 `#22c55e`、失败 `#ef4444`、运行中 `#3b82f6`、已取消 `#9ca3af`
- **排版**：正文 14-15px / 代码 13px 等宽（`ui-monospace` 栈）；气泡内边距 10-14px，圆角 10px
- **布局 token**：侧边栏 280px、composer 最大宽 760px 居中、间距 8px 基准
- **移动端**：底部安全区（`SafeAreaView`）、输入框避让键盘（`KeyboardAvoidingView`）

---

## 8. 跨端兼容策略

| 能力 | Web | iOS/Android | 处理 |
|---|---|---|---|
| Markdown | `react-markdown` | `RonRadtke/react-native-markdown-display`（活跃维护 fork） | 封装 `<Markdown>` 统一接口，平台分支实现；原生端遇兼容问题可降级纯文本+代码块等宽 |
| 文本选择/复制 | 内置 | 长按 | 组件层抽象 `CopyableText` |
| 虚拟化列表 | FlatList（可用） | FlatList（原生） | 三端统一 FlatList，性能问题再换 FlashList |
| 键盘 | — | KeyboardAvoidingView | 平台条件渲染 |
| 滚动到底 | 容器 scroll | FlatList | `scrollToEnd` 统一封装 |
| 文件路径显示 | 中文字体 | 等宽字体 | 统一等宽栈 |

**原则**：业务组件零平台分支，只有原子组件（Markdown / 键盘 / 复制）内部做分支。

---

## 9. Desktop 壳（Electron）

**以 `docs/DESKTOP-PLAN.md` 为准**（含调研结论与完整方案）。核心要点：

- 加载 `packages/ui` 的 Expo web 产物（`expo export --platform web`），dev 连 Metro、prod 走 `agent-console://` 自定义协议静态服务（SPA fallback）
- 主进程内置 daemon 托管：自动 spawn / health check / 退出清理（复用 `tree-kill`），用户无感
- 传输：renderer 直连 `ws://127.0.0.1:<daemon端口>`，同一套协议，不做 local-transport 抽象
- 桌面特有：cwd 用系统目录选择器（preload IPC 桥）、深链 `agent-console://session/<id>`、窗口状态持久化
- 安全：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 打包：electron-builder（mac dmg/zip、win nsis/zip、linux AppImage/deb）

---

## 10. 开放点决策与实现顺序

### 决策（建议，待你确认）
1. **`providers.list` / `agent.models` / `agent.modes` / `agent.create` 返回结构** → 建议 daemon 补：`providers.list → { providers: [{ id, label?, available, capabilities }] }`；`agent.create → { sessionId }`
2. **多会话**（✅ 已确认保留）：协议需补 `session.list`（返回 `{ sessionId, provider, updatedAt }[]`），Phase 2 实现 agent-manager 时补，UI 侧边栏列出历史会话。
3. **assistant 消息聚合**（✅ 已确认打字机）：`timeline` 事件流式到达，按 `messageId` 聚合增量更新（改状态而非追加新 item），流式打字机效果。
4. **Markdown**（✅ 推荐方案）：Web 端 `react-markdown`（成熟稳定）；原生端用 `RonRadtke/react-native-markdown-display`（原版 iamacup 的活跃维护 fork，2026 年仍在更新）。统一 `<Markdown>` 包装组件，平台分支内部实现；原生端遇兼容问题可降级为纯文本 + 代码块等宽渲染。

### 实现顺序（Phase 3 拆解）

```
3.1 脚手架：packages/ui 初始化（Expo + monorepo 配置 + expo-router）
    → 验证：web build 跑通、WS 连到 mock daemon
3.2 连接层 + zustand store + applyEvent 归约器
    → 验证：mock 事件流驱动 store 状态正确
3.3 ChatScreen + Timeline 组件族（§5.1）
3.4 Composer + 模型/模式选择（§5.2）
3.5 PermissionDialog（§5.3）
3.6 会话列表 + 新建会话（§5.4）
3.7 Electron 壳（§9）
3.8 联调真实 daemon（此时 daemon 需已完成 Phase 2 的 ws-server）
```

---

## 附：与协议的对账（设计未覆盖协议能力 → 需补类型）

- `AgentCapabilityFlags` 用于 provider 卡片与功能显隐（如 `supportsStreaming` 才做打字机效果）→ `providers.list` 返回结构需包含
- `AgentSlashCommand`（`listCommands?`）本期 UI 不做斜杠命令面板，**降级**：composer 输入以 `/` 开头时原样发给 agent，不做本地补全
- `AgentPersistenceHandle` / `resumeSession`（Phase 4）本期 UI 无恢复入口，架构上预留（Session 增加 `persistenceHandle?` 字段）
