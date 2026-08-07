# Tang Agent Dashboard Design System

> 取代 `docs/DESIGN-SYSTEM.md` v1。
> 本文件为单一视觉源真，UI 代码须先读此再写。Component 改动必须先回此登记。

---

## 1. Atmosphere & Identity

Tang Agent Dashboard 是统一的 AI 编码 agent 中控台（Pi / Codex / Claude Code / OpenCode）跑在 Electron 桌面壳里，不是网页、不是 TUI、不是聊天首屏，而是一个**长期挂着的工具**。用户开着它一整天，mosaic 切换，背景并行多 agent，偶尔回来读 timeline、发送/中断、回 plan 模式审改动。

**signature**：克制的桌面工具感——靠**面板浮起的层级阴影**与**暖灰背景阶梯**建立深度，而不是靠 brand 重色或大圆角。珊瑚橙 `#cd8f74` 仅作为发信号的动作口（发送按钮、选中态高亮），4 个 agent 的身份色仅在身份徽章小点与 mode 时使用，绝不装饰。

参考的视觉哲学（已核实源码）：
- **opencode 新版 UI**：composer 工具条是控制中枢，model/agent/variant 控件并列在输入卡底部一行 44px；阴影替代边框做深度；蓝 accent 单色；每个控件自带 keybind tooltip。
- **paseo**：同 toolbar 哲学；density-aware 切换（宽→文字+图标 / 窄→图标 / 超窄→聚合 sheet）；DESKTOP_SEARCH_THRESHOLD=6。
- **CodexPlusPlus manager**：shadcn + Tailwind 4 HSL token + 电光蓝 brand；layer system `bg-base/deep/layer-01..04`；motion token 150ms cubic-bezier(0.4,0,0.2,1)；service tier segmented 按钮组（Stand/Fast）。

**基调判断**：相比 opencode 的干净 web 风格，本项目保留珊瑚橙身份与暖暗背景，但**升级到 CodexPlusPlus 式的 token 阶梯**——保持品牌连续性同时获得 colder、更桌面工具化的层级感。

---

## 2. Color

### 2.1 Token 表（dark = 默认；light 暂不实现，留 §8 debt）

> 命名遵循 CodexPlusPlus 的 `surface-*` 语义层 + 既有珊瑚橙的延续。所有既有 vendor 旧名（`--bg/--card` 等）保留为别名，迁移期间同时存在，新代码用新名。

| Role | Token | Dark | 旧别名 | 用途 |
|---|---|---|---|---|
| Surface/base | `--surface-base` | `#181818` | `--bg` | App 背景 |
| Surface/deep | `--surface-deep` | `#141414` | `--bg-sunken` | 比 base 更深的浮起负空间 |
| Surface/elevated-1 | `--surface-layer-01` | `#1f1f1f` (新) | 无 | 第一层浮起：sidebar、tab 选中底 |
| Surface/elevated-2 | `--surface-layer-02` | `#212121` | `--card` | 卡片／composer 卡身 |
| Surface/elevated-3 | `--surface-layer-03` | `#262626` (新) | `--card-hover` | hover 浮起 |
| Surface/popover | `--surface-popover` | `#282828` | `--popover` | Popover 浮层 |
| Surface/sidebar | `--surface-sidebar` | `#171717` | `--sidebar` | Sidebar 面板 |
| Subtle border | `--border-subtle` | `#262626` | `--border-soft` | 软分隔 |
| Default border | `--border-base` | `#303030` | `--border` | 默认边线 |
| Border/hover | `--border-hover` | `#4a4a4a` (新) | 无 | Composer focus 边线 |
| Text/primary | `--text-primary` | `#ececec` | `--text` | 正文 |
| Text/muted | `--text-muted` | `#afafaf` | `--text-dim` | 次要 |
| Text/faint | `--text-faint` | `#6e6e6e` | `--text-faint` | 占位／时间戳 |
| Accent/primary | `--accent-primary` | `#cd8f74` | `--accent` | 珊瑚橙：CTA、选中、focus |
| Accent/hover | `--accent-hover` | `#d99c82` | `--accent-hover` | Hover |
| Accent/ink | `--accent-ink` | `#241512` | `--accent-ink` | 浅 accent 上的字 |
| Accent/soft | `--accent-soft` | `rgba(205,143,116,0.12)` | `--accent-soft` | 选中态背景柔色 |
| Status/success | `--status-success` | `#7bb892` | `--success` | 完成 |
| Status/danger | `--status-danger` | `#e06c6c` | `--danger` | 错误 |
| Status/warn | `--status-warn` | `#d9a45b` | `--warn` | 权限请求／plan |
| Status/info | `--status-info` | `#7aa2d9` | `--info` | 运行中 spinner |
| Agent identity | `--agent-pi` / `--agent-codex` / `--agent-claude` / `--agent-opencode` | `#7c5cd6` / `#4b54ff` / `#b05a48` / `#3f7f5f` | 见 theme.ts | 仅身份徽章小点 + agent mode 色 |

### 2.2 Mode 主题色（**新增**，对齐 opencode agent solid/border/background 三色一体）

agent mode 是 codex/claude 的 plan/build/etc. 切换，每个 active mode 用专属 tint：

| Mode 通用类别 | Solid | Border `rgba` | Background `rgba` |
|---|---|---|---|
| `build` / `default`（默认全权） | `--agent-codex`（继承 provider） | `r3 alpha 0.18` | `alpha 0.10` |
| `plan`（只读） | `--status-info` `#7aa2d9` | `rgba(122,162,217,0.20)` | `rgba(122,162,217,0.10)` |
| `custom`（provider 自定义） | `--accent-hover` | `rgba(217,156,130,0.20)` | `rgba(217,156,130,0.10)` |

> provider 的 `getModeVisuals` 在 daemon 侧解析返回 `{ colorTier: "planning" | "default" | ...，icon? }`，UI 据此查表选 solid。每个 mode chip 的配色由此派生，**不再硬编码**。

### 2.3 Rules

- Accent（珊瑚橙）**仅**用于真正的发出动作（发送、激活、关注点）；非互动元素禁用。
- Agent 身份色仅出现在：① provider 徽章小点（≤6px）② mode chip 在该 mode 是当前激活时 ③ Sidebar 行的 status dot；**绝不**进入背景、container、按钮饱和填充。
- 任何新增颜色须先加进本表 §2，禁止代码内出现裸 hex。
- `--surface-layer-01..03` 通过 `var()` 引用形式使用，禁止再写 `--bg-sunken`/`--card` 的别名 —— 旧名仅作迁移兼容，新代码强行使用新名。

---

## 3. Typography

### 3.1 Scale（沿用现有 App.css，正式 tokenize）

| Level | Size | Weight | Line Height | Usage |
|---|---|---|---|---|
| Display | 14.5px | 600 | 1.5 | Composer 输入框 |
| H1 | 13.5px | 600 | 1.4 | Topbar 标题 `--tt` |
| Body | 13px | 500 | 1.55 | 默认正文 / ws-item name |
| Body/sm | 12.5px | 500 | 1.5 | 按钮、tab、Composer 提示 |
| Caption | 11.5px | 400 | 1.45 | Subtitle / Topbar cwd |
| Tiny | 11px | 500 | 1.4 | 时间、`--ts`、metric label |
| Overline | 11px | 600 | 1.35 | Section header（小写了 + letter-spacing 0.02em） |
| Mono-sm | 12px | 400 | 1.5 | 代码块、路径 |

**字段**：所有 body 不低于 11px（既有一处 dropdown 选项 12.5px / 描述 11px 未违反）。

### 3.2 Stack（保留现有，新增 JetBrains Mono 显式 bundle）

- Primary sans: `-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`
- Mono: `"JetBrains Mono", "SFMono-Regular", ui-monospace, Consolas, monospace`

新增 §8 Accepted Debt： JetBrains Mono 在打包 Linux 上需确认；目前只靠 `SFMono-Regular` fallback。

### 3.3 Rules

- 一个项目最多 2 字体族（sans + mono），无第三。
- body 永不低于 11px；超过 5 行的标题太多须 clamp。
- composer 文本固定 14.5px（与 opencode 一致），不可被输入过长内容压成小字。

---

## 4. Spacing & Layout

### 4.1 Base Unit = 4px

| Token | Value | Usage |
|---|---|---|
| `--space-05` | 2px | chip 内 icon ↔ label tight |
| `--space-1` | 4px | 行内 gap、spinner 内 |
| `--space-15` | 6px | btn padding Y / sb 头尾 |
| `--space-2` | 8px | sidebar item padding / 默认 gap |
| `--space-25` | 10px | topbar / sb-foot padding |
| `--space-3` | 12px | tabs area / 思考块 padding |
| `--space-35` | 14px | modal-head padding |
| `--space-4` | 16px | composer 容器边距 |
| `--space-6` | 22px | composer 上下 padding |
| `--space-9` | 28px | composer 水平 padding |
| `--space-11` | 40px | empty-project 上下 |

### 4.2 Layout

- 视口：Electron 窗口默认 ≥1180×820，最小 960×620（对齐 desktop `electron-builder.yml` 的 minWidth/minHeight）。
- App shell（**重构**）：`Sidebar (276px) | Main (flex-1)`；Main 内部由上往下：`Topbar (40px) | Thread (flex-1) | ComposerWrap`。**移除 TabsRow**（释放约 40px 给 Thread）。
- Composer：max-width 720px 居中，水平 padding `--space-9`，上下 `--space-2/--space-6`。
- Sidebar：宽度 276px 固定（保留现有），不引入 resize（桌面单屏已够）。
- Grid：无 Tailwind；用 flex + min-width:0 满足"横向不能爆"。
- Breakpoints：当前为 Electron 桌面，不响应式；若 web port 后再做 ≥1024 默认 / <1024 折叠 sidebar 隐藏到 hamburger。

### 4.3 Rules

- spacing 必须引 token；bank 浏览器 mechanics (`min`, `max`, `minmax`, `clamp()`, `auto`, `%`) 不强行 tokenize。
- 不对称 spacing 须在此节注释（如 Composer 上下不对称：`--space-2` 上、`--space-6` 下，以视觉让 send 圆钮与输入上下等距）。

---

## 5. Components

### 5.1 Atomic primitives（**新增** / 抽离现有 inline）

#### `PopoverShell`
- **Structure**: 一次性 React portal，渲染到 `document.body`；`position: fixed`，由 anchor ref + `getBoundingClientRect()` 推算；含 backdrop clickaway
- **Variants**: `placement: "bottom-start" | "top-start" | "bottom-end"`；`minWidth:number`
- **Spacing**: 内部 padding 0（由内部内容自定），外阴影 `--elevation-floating`
- **States**: default / open-close 动画：opacity 0→1 / translate 0 4px→0 / 150ms ease-out；关闭反之
- **A11y**: focus-trap 启用、ESC 关闭、点击外部关闭
- **Layout**: 固定弹出层原语，所有 dropdown 都复用此

> 取代当前 `Topbar.tsx` 内联的 `MenuShell`。现有 `MenuShell` 函数即可不动先并行，新组件用 `PopoverShell`。

#### `AgentControlChip`
- **Structure**: `<button class="chip">[icon] [label] [caret]</button>`，28px 高、`--r-2xl` 14px 圆角
- **Variants**: `surface: "toolbar" | "ghost-muted" | "ghost-dim"`
- **Spacing**: `px --space-2`, `gap --space-1`
- **States**: default / hover(`--surface-layer-03`)/ active(`--surface-layer-02` 边框)/ focus(`--ring`)/ disabled(opacity 0.4)/ open(`--accent-soft` border `--border-hover`)
- **A11y**: 按 Esc 闭合并将焦点还原到 anchor；tooltip 显示其 keybind（依赖 §6 的 motion 信号 + aria-keyshortcuts）
- **Motion**: 150ms ease-out 背景过渡

> 共享原子，model / mode / thinking 三个 dropdown 都用此触发器。

### 5.2 Composite controls（**方案 A 变更**）

#### `ModelPopover`（✅ 已落地，替换 `Topbar.tsx` 中 model dropdown）
- **Structure**: `AgentControlChip + PopoverShell`；popover 内：内联搜索 input（h-28） + 分割线 + 按 vendor 分组列表
- **Variants**: chips 单选；当 vendorModels.length > 6 显示搜索框（`DESKTOP_SEARCH_THRESHOLD=6`）
- **Spacing**: 列表项 `--space-15` padding-x `--space-2`
- **States**: 选中 = `--accent-soft` 背景 + `--accent-hover` 文字；hover = `--surface-layer-03`
- **A11y**: aria-label "选择模型"，search 输入可立刻获得焦点，箭头上下走列表，Enter 选中
- **Motion**: popover entry from §5.1
- **Layout**: 284px 宽（对齐 opencode），max-h 240px 滚动；位置 `top-start` 距 chip 4px

#### `ModePopover`（✅ 已落地 — 接通 protocol `agent.modes`）
- **Structure**: `AgentControlChip + PopoverShell`；chip icon 来自 `getModeVisuals.icon`（Lucide `Shield*` family），label 为 mode label
- **Variants**: 模式 chip 配色按 §2.2 三色派生；激活态用 `border/background` 不动 solid 文字
- **Spacing**: 同上
- **States**:
  - 仅 `session.capabilities.supportsDynamicModes && modes.length > 0` 显示；否则完全隐藏（不 render 空 chip）
  - 多 mode 同步：监听 `mode_changed` 事件；选中时发出 `agent.setMode`
- **A11y**: aria-label "切换 agent 模式"，键盘 ↑↓ + Enter
- **Motion**: 默认 fade in / 模式变化时 chip 用 200ms 颜色过渡；不在 composer 失焦时变色

> 此为新功能组件，解决痛点 3。daemon 端期 6 已记录需补 `agent.modes` 服务端方法（codex provider 已实现 `getAvailableModes` 返回 `MODE_PRESETS.keys`，UI 这层调用即可；claude / opencode provider 补 modes 列表，否则 chip 不显示无影响）。

#### `ThinkingPopover`（✅ 已落地，从 Topbar 迁到 Composer 工具条）
- **Structure**: `AgentControlChip + PopoverShell`；chip icon Lucide `BrainCircuit`，label = 当前 thinking label
- **Variants**: 仅 `currentModel.thinkingOptions.length > 0` 时 render；≤1 时彻底不渲染
- **Spacing**: 同上
- **States**:
  - 选中用 `--accent-soft`；"默认"选项加 inline `默认` 灰色小标签（pass-through）
  - 当 session.thinkingOptionId 跟 currentModel.defaultThinkingOptionId 相同时，chip 文字灰色（表示"未覆盖默认"），与切过的状态视觉区分
- **A11y**: aria-label "推理强度"，热键提示
- **Motion**: popover 同上
- **Layout**: 180px 宽，`top-start`

#### `ComposerToolbar`（✅ 已落地，承载以上三个 dropdown）
- **Structure**: Composer 卡内底部 40px 一行（对齐 opencode `h-11`）：
  ```
  [+] [Mode?] [Model] [Thinking?]   [gap]   [secondary toolbar: 附件/发送]
  ```
- **Variants**: 紧凑 mode（compact）：模式/思考 chip 仅显示 icon，hover 显示文字 tooltip（基于 `Composer` width ≤ 540px）
- **Spacing**: gap `--space-1`
- **States**: running 时禁用，整个 toolbar `opacity 0.5` 且 non-interactive；空闲时正常
- **A11y**: tab 序列由左到右，Esc 还原 composer 焦点
- **Motion**: chip open animation 同上；切 mode 后 200ms chip 颜色过渡
- **Layout**: chip 高度 28px，行总高 40px；按钮组互斥的 open 状态用 React state 统一管理（同 paseo `openSelector`）

### 5.3 Sidebar & sessions（**方案 A 变更**）

#### `WorkspaceRow`（✅ 保留现状，`Sidebar.tsx` 中 ws-item 原样沿用 + `ws-block`/`ws-sessions` 包裹嵌套；token 学名化未做，class 名仍为 `ws-item`）
- **Structure**: 既有：folder icon + name + count + 路径
- **States**: default / hover / active / 空项目（count 显示"空"）
- 与现状一致，无变化，仅把 inline 颜色搬入 token

#### `SessionRow`（✅ 已落地，替换 `TabsRow`）
- **Structure**: `<button>dot(provider识别色) + label + 时间 + 行尾 hover 动作</button>`
- **Variants**: 普通 / pinned / running（pulse dot）
- **Spacing**: 左缘 `--space-2` 内 padding，hover 动作区宽 `--space-8` 占位
- **States**:
  - active: 左缘 2px 珊瑚橙边条 + `--surface-layer-01` 背景
  - hover: `--surface-layer-01` 背景 + 行尾出现 close/hover-more button
  - running: provider dot 替换为 11×11 spinner（颜色 `--status-info`）
- **A11y**: aria-label 选中 = 当前会话标题 + provider 名；delete 用 `Shift+Backspace` 二次确认（不发 popup）
- **Motion**: spinner `find-in` 800ms rotate / hang pulse 1s loop, prefers-reduced-motion 时 spinner 替为 `⋯` 静态
- **Layout**: 嵌套 sidebar 项目下；hover reveal 动作按钮（CodexPlusPlus 模式）

#### `NewSessionRow`（✅ 已落地，persist 在每个 Workspace 顶部）
- **Structure**: 编辑 icon + 文字"新会话 · {workspace name}"
- **States**: click → 高亮 + focus 跳到 Composer；发首条消息时建会话（draft 模式）；选不下的新 session 配置从工具条 chips 在激活前完成；不会显 modal
- **A11y**: aria-label "新建会话 in {workspace}"

### 5.4 既有保留

- ✅ `Composer` textarea（保留）；附件按钮已迁入 ComposerToolbar 作占位（本期不做）
- `Sidebar` 头部 New-workspace button / score search / footer（保留；行为不变）
- `PermissionCard` 内嵌卡片（保留，方案 A 范围外）
- `Timeline` / `ReasoningBlock` / `ToolCallCard` / `TodoList`（保留）
- `Modal`（保留；仅"新建 Workspace"与"导入历史会话"仍用；**"新建会话"不再用 Modal**）

### 5.5 已登计组件（implementing 期 append）
- ✅ `Topbar` 简化（已实施）：移除 model/thinking 两个 menu 后，仅保留 `prov-badge + 标题 + 路径 + placeholder 更多按钮`；model/thinking 下拉迁至 `ComposerToolbar`（`ModelPopover` / `ThinkingPopover`），models 拉取逻辑从 Topbar 上移至 `App.tsx`（按激活上下文 provider 拉取）。

---

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---|---|---|
| Micro | 120-150ms | cubic-bezier(0.4,0,0.2,1) | chip hover、btn hover |
| Standard | 200-250ms | cubic-bezier(0.4,0,0.2,1) | popover open/close、tab 切换、mode chip 颜色 |
| Spinner | 800ms | linear | running pulse |
| Permission 弹出 | 250ms | cubic-bezier(0.16,1,0.3,1) | permission card entry（保留既有） |

### Rules
- 仅 animate `transform` / `opacity` / `background-color` / `border-color` / `color`；禁止 layout 动画（width/height/top/left）。
- 每个交互元素 hover / focus / active / disabled 都需 §5 中定义。
- Scroll-triggered 暂无需求。
- `prefers-reduced-motion: reduce` → popover 仍 opacity transition（60ms），spinner 替 `⋯` 静态，permission card 立即出现（无 transform）。
- 不为装饰加动画（slop forbidden）。Motion 只服务于状态变化信号。

---

## 7. Depth & Surface

### Strategy: tonal-shift + 阴影边界（mixed，偏 tonal 主调）

- 常规面板分层（sidebar / topbar / thread / composer）用 §2.1 的 `--surface-*` 阶梯色做面分离，**不画边**。
- popover / modal / permission card 用阴影做边界（不画 1px 边线），对齐 opencode v2 设计语言。

| Level | Box-shadow value | Usage |
|---|---|---|
| Default | `0 2px 8px rgba(0,0,0,0.18)` | composer 在 thread 上浮（保留既有）。 |
| Floating | `0 8px 16px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(255,255,255,0.04)` | popover / menu shell。`0 0 0 0.5px` hairline 替 border。 |
| Prominent | `0 24px 64px rgba(0,0,0,0.55)` | Modal backdrop；保留既有 |

### Rules
- 卡片 hover 阴影不变（保留既有 `--card-hover` 通过 §1 surface-layer-03）。
- Popover 必须用 `--elevation-floating` 定义的 hairline + soft shadow 合一，而非 `border + shadow`。
- Thread / sidebar / topbar 之间的分隔允许保留 1px `--border-subtle`（不计层级）。

---

## 8. Accessibility Constraints & Accepted Debt

### Constraints（目标）
- WCAG 2.1 AA：contrast 4.5:1 正文 / 3:1 大字与图标，推 §2 token 是否满足（既有 `--text-muted #afafaf` on `--bg #181818`：约 8.8:1 ✓；`--text-faint #6e6e6e` on `--bg #181818`：约 4.2:1 ✗ 用于 caption 仅，须限制用法）
- 所有新 popover 焦点 trap；现有 Modal 已含 backdrop click-away，需补 focus trap
- 键盘可达：mode/model/thinking popover 必须可用 Tab/箭头/Enter/Esc 完成与取消
- `prefers-reduced-motion` 已在 §6 覆盖
- aria-keyshortcuts：在 model/mode/thinking chip 上加内联 keybind hint，对齐 opencode 经验

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Light theme 未实现 | `App.css` 仅 dark | 桌面工具暗色优先；用户明确未要求 light | 后续做 light 时新加 `:root[data-color-scheme=light]` 覆盖块 |
| `--text-faint` 对比 4.2:1 | `App.css` --text-faint | 用于次要时间戳与占位，不到正文 | 未来切 OKLCH 渐进 ramp 时统一升 contrast |
| `--text-faint` 在 popover 描述处（如 model description） | `ModelPopover.tsx` 的 `.popover-row-details` | 当前一个 mode 下，属低优先级可读性 | redesign 时新选 accent-soft 浮 / minor 类型 |
| claude / opencode provider 的 `getAvailableModes` 未实现 | `packages/daemon/src/providers/{claude,opencode}/agent.ts` | `agent.modes` 已 route（`ws-server.ts` → `manager.getModes`），仅 codex 返回非空 | UI 端 `modes.length === 0` 即不 render ModePopover，无副作用 |
| daemon 未发射 `mode_changed` 事件 | `packages/daemon/src/providers/codex/agent.ts` 无 emit | UI 已监听 `agent.event` 的 `mode_changed` + 乐观更新兜底 | daemon 补发后 UI 自动同步，不冲突 |
| JetBrains Mono 字体在打包 Linux 上是否合法打包还需核 | `electron-builder` packaging | 仅在 macOS 自带 SF Mono；Linux 用户大半 fallback Consolas | 测试打包产物跨平台渲染后 |
| 现 e2e `scripts/e2e-desktop.mjs` 9 用例覆盖既有路径；coverture 增设新会话/切模式测试 | e2e:desktop | 新加 UI 需 e2e 增益 | redesign 完成后补 +5 件 e2e（新建会话 inline、切换 mode、thinking popover、switch model 列表交互、模式 hint tooltip） |
| WorkspaceTree 二层 UI（项目 → 会话）现以 `sessionCwd` 前端聚合 | `App.tsx::sessionCwd` | 当前方案 A，collocate 同 cwd 会话；不引入 `workspace` 后端实体（clauded PLAN's 方案 B 预留） | 若用户并发多 cwd 跨带切换，迁后端 workspace 实体 |
| "Settings/footer 设置"仍为占位 | `Sidebar.tsx` 的 `GearIcon btn` + `Topbar.tsx` 更多按钮 | 二期处理，含健康检查（c.f. CodexPlusPlus health-grid） | 二期 |
| `ModePopover` 与 daemon `mode_changed` 事件：UI 已对接，daemon 未补发 | `packages/daemon/src/providers/codex/agent.ts` | UI 已监听 `mode_changed` + 乐观更新（`App.tsx::handlePickMode`），事件回流仅作冗余同步 | daemon 补发即收敛 |

### Debt-discipline
新接受 debt 须在实施期现地登入此表 — 不允许默认。
任何收敛 entry（修复即移除）须注明 fixed commit。

---

## 9. Implementation Notes（项目专用，非 architecture 强制 section）

### 9.1 文件改动清单（方案 A 增量）— 全部 ✅ 已完成

新增文件：
- ✅ `packages/ui/src/components/PopoverShell.tsx` — 统一 popover 原子，含 focus trap
- ✅ `packages/ui/src/components/AgentControlChip.tsx` — 工具条 chip 原子
- ✅ `packages/ui/src/components/ModelPopover.tsx` — 迁自 Topbar 的下拉
- ✅ `packages/ui/src/components/ModePopover.tsx` — 新增
- ✅ `packages/ui/src/components/ThinkingPopover.tsx` — 迁自 Topbar 的 thinking 下拉
- ✅ `packages/ui/src/components/ComposerToolbar.tsx` — 装载上述三 dropdown + 附件 + 发送/中断
- ✅ `packages/ui/src/components/SessionRow.tsx` — 替换 TabsRow（Shift+Backspace 二次确认删除）
- ✅ `packages/ui/src/components/NewSessionRow.tsx` — sidebar 顶部持久行（click → draft + 跳 Composer）

修改文件：
- ✅ `packages/ui/src/components/Composer.tsx` — composer-foot 整行替换为 ComposerToolbar；附件/发送归工具条；新增 draft 模式 + focusSignal
- ✅ `packages/ui/src/components/Sidebar.tsx` — ws-item 块下嵌 SessionRow 列表 + 顶部 NewSessionRow（仅激活 workspace 展开）
- ✅ `packages/ui/src/components/Topbar.tsx` — 删除 model/thinking menu，仅留 prov-badge + 标题 + 更多
- ✅ `packages/ui/src/App.tsx` — 移除 TabsRow；新建会话改 draft（不再走 modal）；mode state 接 `agent.modes` / `mode_changed` / 乐观更新
- ✅ `packages/ui/src/App.css` — 新 token + primitive 样式；新增 `.session-row` / `.new-session-row` / `.composer-toolbar` / `.session-spinner`；删除 `.tabs-row` 死代码
- ✅ `packages/ui/src/components/Modals.tsx` — 删除孤儿 `NewSessionModal`（新建会话改 inline draft）
- `packages/ui/src/theme.ts` — 未改动；mode tint 三色派生在 `ModePopover.tsx` 内部 `classifyTint` 实现（未抽 `MODE_TINTS` 常量）

删除文件：
- ✅ `packages/ui/src/components/TabsRow.tsx` — 移除，SessionRow 替代

### 9.2 协议 / daemon 改动

- ✅ `packages/protocol/src/rpc.ts` — 新增 `agent.mode.set`（`ClientRequest` 一项）
- ✅ `packages/ui/src/ws.ts` — `DaemonClient` 补 `modes(sessionId)` / `setMode(sessionId, modeId)` + `AgentMode` import
- ✅ daemon `ws-server.ts` — `agent.modes` 已 route（→ `manager.getModes` → `session.getAvailableModes?.() ?? []`）
- ⛔ `agent.mode.set` 服务端未 route（HANDOFF §6 已知缺口）— UI 乐观更新 + 静默 catch 兜底
- ⛔ claude / opencode 的 `getAvailableModes` 未实现 — UI `modes.length === 0` 不 render，无副作用

### 9.3 验证清单（与 §8 e2e 增加）

实施期间每个 primitive 完成 → `lsp_diagnostics` + 视觉手动 1 屏巡检；redesign 收口 → 全 e2e 跑过 + `visual-qa` 三个 viewport（虽桌面无 web breakpoint，仍强制执行最小桌内 / 超 / HD 检视）：
- [ ] 1366×768 最小桌面 / 1920×1080 标准 / 2560×1440 高分屏
- [ ] 切 mode 时 chip 配色按 §2.2 tint 完成
- [ ] popover 内部键盘往返 + Esc 关闭 + 焦点还原到 composer
- [ ] 新建会话 inline 路径完成发首条消息
- [ ] provider 不支持 thinking / mode 时 chip 隐藏（不出现空 popover）

---

## 文档读者

新加 UI 源文件须在 PR 描述里 link 到本 §5 的哪个 primitive；如未登入 §5 ，先本文件 +PR 再改源。