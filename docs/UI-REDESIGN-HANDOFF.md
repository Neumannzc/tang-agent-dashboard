# UI 重设计实施交接文档

> 用途：把当前会话的 UI 重设计工作交接给新会话继续。
> 起点：`docs/DESIGN.md` 已定稿，部分原子组件已落地并验证通过。
> 路线：方案 A（Composer 工具条集中控制 + 单 sidebar 树 + popover 化）。

---

## 1. 上下文与决策

- **痛点**：模型切换位置远 / workspace 与会话列表双层 / plan/build 模式 UI 完全缺失 / 视觉风格偏 AI 杂烩
- **已选方案**：方案 A —— 提炼 `DESIGN.md` + 重构组件层，参考 opencode 新版 + paseo + CodexPlusPlus 的实现模式
- **核心哲学**：把 model / mode / thinking 三个 dropdown 从 Topbar 搬到 Composer 工具条（44px 一行），删除 TabsRow 释放 Thread 垂直空间，新建会话改 inline 不走 Modal
- **保留**：珊瑚橙身份色、4 agent 身份色、暗色基调；新增 CodexPlusPlus 式的 surface layer 阶梯

## 2. 关键文档

| 文件 | 状态 | 说明 |
|---|---|---|
| `docs/DESIGN.md` | ✅ 完成 | 8 sections 完整设计系统；新组件必先读 §5 primitive 定义 |
| `docs/UI-REDESIGN-HANDOFF.md` | 本文件 | 交接清单 |
| `CLAUDE.md` | 已存（项目级） | 项目约定与坑；line 114-121 列了三个参考项目本地路径 |
| `docs/FRONTEND-PLAN.md` §9.5 #4 | 已存 | 期 6 记录：`agent.modes` 的 daemon 端协议面缺口 |

## 3. 参考项目源码位置（本地）

| 路径 | 用途 |
|---|---|
| `/home/tang/project/ai-chat/opencode` | 新版 UI 全 SolidJS 重写，composer 工具条 44px 模式 |
| `/home/tang/project/ai-chat/paseo` | composer 工具条 chip + Combobox + 收藏置顶 + provider drilldown |
| `/home/tang/project/ai-chat/CodexPlusPlus` | Tauri + shadcn + Tailwind 4 桌面 UI；service tier segmented；layer token |

## 4. 已完成（验证通过）

### 4.1 设计系统
- ✅ `docs/DESIGN.md` 写完，含 8 sections + §9 implementation notes
- ✅ `packages/ui/src/App.css` 顶部 token 块扩展：
  - `--surface-base/deep/layer-01/02/03/popover/sidebar` 新 layer 阶梯
  - `--border-subtle/base/hover` + 旧名 `--border/border-soft` 为别名
  - `--text-primary/muted/faint` + 旧名 `--text/text-dim` 为别名
  - `--ring` 珊瑚橙 focus ring
  - `--elevation-floating` hairline + soft shadow 替代 popover border
  - `--space-05/1/15/2/25/3/35/4/6/9/11` 4px 基底间距
  - `--mode-{plan,default,custom}-{solid,border,background}` mode 三色一体
  - `--r-2xl: 14px` 新圆角档
- ✅ App.css 末尾追加 §5 原子的 visually-grounding CSS：`.popover-shell` / `.popover-search` / `.popover-divider` / `.popover-group-label` / `.popover-row` / `.popover-row-details` / `.popover-row-tag` / `@keyframes popover-in`；`.chip` + `.chip-surface-{toolbar,ghost-muted,ghost-dim}` + `.chip-icon/label/caret` + `.chip-active/open/disabled` + `.chip:focus-visible`；`.chip[data-mode-tint="plan|default|custom"]` 三色一体
- ✅ `lsp_diagnostics` App.css → 0 errors

### 4.2 原子组件
- ✅ `packages/ui/src/components/PopoverShell.tsx`
  - 用 `createPortal` 到 `document.body`、`position: fixed`
  - 自动 anchor 推算（基于 `getBoundingClientRect()`）
  - placement 支持 `bottom-start | top-start | bottom-end`，含 viewport 翻转
  - focus trap（Tab/Shift+Tab 循环 + 首元素自动 focus）
  - ESC 关闭
  - pointerdown clickaway（绕开 anchor 与 popover 内）
  - 焦点还原：关闭后 `requestAnimationFrame` 还原 anchor 的 caret 位置
  - `prefers-reduced-motion` → 60ms 替代 150ms
  - `lsp_diagnostics` → 0 errors
- ✅ `packages/ui/src/components/AgentControlChip.tsx`
  - forwardRef button，prop 涵盖 surface/active/open/icon/label/caret/keybindHint/disabled
  - aria-haspopup="dialog" / aria-expanded / aria-keyshortcuts / title
  - class 组合：`chip + chip-surface-* + chip-active/open/disabled`
  - 可附 `data-mode-tint` 用于 mode chip 三色派生
  - `lsp_diagnostics` → 0 errors（修了 forwardRef 未闭合 `)`）

### 4.3 三个 popover 包装
- ✅ `packages/ui/src/components/ModelPopover.tsx`
  - 迁自 `Topbar.tsx` 的 model dropdown，复用 `AgentControlChip + PopoverShell`
  - 按 vendor 分组 + 内联搜索（`SEARCH_THRESHOLD = 6` 超过才显示搜索框，paseo 经验值）
  - 选中状态 `data-selected="true"`，0 匹配时显示"无匹配模型"
  - `lsp_diagnostics` → 0 errors
- ✅ `packages/ui/src/components/ThinkingPopover.tsx`
  - 迁自 `Topbar.tsx` 的 thinking dropdown
  - 关键：`options.length === 0` 时 return null（不 render 空 chip）
  - 默认强度时 chip 用 `ghost-muted` surface；用户改过用 `toolbar`
  - 默认项显示 "默认" tag
  - `lsp_diagnostics` → 0 errors
- ✅ `packages/ui/src/components/ModePopover.tsx`
  - 新增，接 protocol `agent.modes` / `setMode` / `mode_changed` 事件
  - 模式 tint 分类函数 `classifyTint: "plan" | "default" | "custom"`（按 mode id 末尾 `#plan` / `-plan` 判定）
  - 三色一体派生于 `App.css` 的 `--mode-*-solid/border/background`
  - 关键：`modes.length === 0 || !session` return null（不 render 空 chip）
  - `lsp_diagnostics` → 0 errors

### 4.4 协议面补全
- ✅ `packages/protocol/src/rpc.ts` 新增 `ClientRequest` 一项：`{ method: "agent.mode.set"; params: { sessionId; modeId } }`
- ✅ `packages/ui/src/ws.ts` DaemonClient 补两个方法：
  - `modes(sessionId): Promise<AgentMode[]>` ← 调 `agent.modes`
  - `setMode(sessionId, modeId): Promise<void>` ← 调 `agent.mode.set`
- ✅ import 新增 `AgentMode` 类型
- ✅ `lsp_diagnostics` 全部通过

### 4.5 验证
- 所有新文件 `lsp_diagnostics` 通过
- `App.css` token + 样式通过诊断
- protocol + ws.ts 通过诊断

## 5. 剩余 TODO（按优先级）

### 5.1 高优先级（必须接力的下一步）

- [ ] **写 `packages/ui/src/components/ComposerToolbar.tsx`**
  - 装载 `ModelPopover + ModePopover + ThinkingPopover` + 附件占位
  - 用 React state `openSelector: "model" | "mode" | "thinking" | null` 做三 popover 互斥（同一时间只一个打开，对齐 paseo 模式）
  - 渲染顺序：`[附件+] [ModePopover?] [ModelPopover] [ThinkingPopover?]  [grow]  [发送/中断]`
  - 接收 props：`session / models / modes / currentModeId / defaultModeId / running / onPickModel / onPickMode / onPickThinking`
  - 拉模式的 hook：会话切换时 `client.modes(sessionId)`，监听 `mode_changed` 事件更新 modes / currentModeId（原本 `useEffect` 监听 session.sessionId 重新拉）

- [ ] **写 `packages/ui/src/components/SessionRow.tsx`**
  - 替换 TabsRow 的会话 tab
  - 行结构：`provider dot + 标题 + 时间 + 行尾 hover 动作（close/更多）`
  - active 状态：左缘 2px 珊瑚橙边条 + `--surface-layer-01` 背景
  - running 状态：provider dot 替换为 11×11 spinner
  - 删除用 `Shift+Backspace` 二次确认（不发 popup）
  - 嵌套 sidebar 项目块下

- [ ] **写 `packages/ui/src/components/NewSessionRow.tsx`**
  - persist 在每个 Workspace 顶部
  - 编辑 icon + "新会话 · {workspace name}"
  - click → 高亮 + focus 跳 Composer
  - 发首条消息时建会话（draft 模式）；选不下的新 session 配置从工具条 chips 在激活前完成

### 5.2 改造既有文件

- [ ] **`packages/ui/src/components/Composer.tsx`** — 嵌入 ComposerToolbar
  - 现状：`composer-foot` 行内含附件按钮 + keybind 提示 + 发送/中断
  - 改造：把附件按钮搬进 ComposerToolbar 左侧，`composer-foot` 仅保留 hint + send
  - 或者更彻底：把 composer-foot 整行替换为 ComposerToolbar，附件按钮归 ComposerToolbar 管

- [ ] **`packages/ui/src/components/Sidebar.tsx`** — 重构列表为 WorkspaceTree
  - 现状：项目列表（`ws-item` button），无嵌套会话
  - 改造：项目块下嵌 `SessionRow` 列表 + 顶部 `NewSessionRow`
  - 保留 New Workspace 按钮在头部；保留 footer
  - Sessions 数据来源：从 `App.tsx` 的 `sessions` state filter 按 cwd 分组（`App.tsx::sessionCwd`）

- [ ] **`packages/ui/src/components/Topbar.tsx`** — 简化
  - 删除 model dropdown（保留 `groupModelsByVendor` 函数可搬到 ModelPopover 或 hooks）
  - 删除 thinking dropdown
  - 仅保留 `prov-badge + 标题 + 路径 + placeholder 更多按钮`
  - 删除不再用的 imports（`AgentModelDefinition` 或可去；`useEffect/useMemo/useState` 部分迁走）

- [ ] **`packages/ui/src/App.tsx`** — 移除 TabsRow 路由 + 新建会话改 inline
  - 删除 `<TabsRow .../>` 调用
  - 改造 `modal === "session"` 路径：不走 Modal，改 sidebar NewSessionRow → 待 draft composer 输入
  - 新增 state：`modesBySession: Record<string, AgentMode[]>`、`currentModeIdBySession: Record<string, string | null>`
  - 注册 `mode_changed` 事件 listener：更新对应 session 的 currentModeId
  - `onPickMode` 实现：调 `client.setMode(sessionId, modeId)`
  - 三个 popover 的 onPickModel / onPickMode / onPickThinking 接到现有 RPC

- [ ] **`packages/ui/src/components/Composer.tsx`** — 适配 Props
  - 新增 props：`onPickModel / onPickMode / onPickThinking / models / modes / currentModeId`
  - 把这些 forward 给 ComposerToolbar

### 5.3 清理 + 样式补齐

- [ ] **删除 `packages/ui/src/components/TabsRow.tsx`**
  - 行 1-60；改了 App.tsx 不再 import 后即可删

- [ ] **`packages/ui/src/App.css`** 加 `SessionRow` / `NewSessionRow` / `ComposerToolbar` 样式
  - `.session-row` + `.session-row.active / hover / running` + `.session-row-actions`（hover reveal）
  - `.new-session-row` + active state
  - `.composer-toolbar` flex 容器 + 内部 gap
  - `.session-spinner` 11×11 + `@keyframes spin`（已有，复用即可）

### 5.4 验证

- [ ] `lsp_diagnostics` 全部新文件 + 改造文件无 error
- [ ] `npm run build -w @agent-console/ui` 通过
- [ ] `npm run dev:ui` 起来手动走查：3 个 popover 键盘可达 + Esc 还原 + focus 还原
- [ ] 改造后跑 `npm run e2e:desktop`（注意：UI 流变了，9 用例里"新建会话"那条会失败，需要改 e2e 脚本配合；可暂时跳过或更新 `scripts/e2e-desktop.mjs`）
- [ ] 视觉验证 3 个 viewport：1366×768 / 1920×1080 / 2560×1440
- [ ] 模式切换切 mode 时 chip 颜色按 §2.2 tint 完成
- [ ] provider 不支持 thinking / mode 时 chip 隐藏（codex 切到 mode popover 一次验证，claude/opencode 期望隐藏）

## 6. 已知 daemon 端缺口（不阻塞 UI 实施但需后续补）

| 缺口 | 位置 | 影响 | 兜底 |
|---|---|---|---|
| `agent.mode.set` 服务端未实现 | `packages/daemon/src/ws-server.ts` 未 route 此方法 | UI 能调但报"未知方法" | UI 端 try/catch 失败时静默；保留 chip 但 mode 切换 success 后 fallback 到本地状态 |
| `agent.modes` 服务端实现但仅 codex 返回非空 | `packages/daemon/src/providers/{claude,opencode}/agent.ts::getAvailableModes` 未实现 | claude / opencode ModePopover 不显示 | UI 端 `modes.length === 0` 即不 render，无副作用 |
| `mode_changed` 事件未在 daemon 端发射 | `packages/daemon/src/providers/codex/agent.ts` 无 `emit({ type: "mode_changed" ...})` | 切 mode 后 UI 状态依赖本地乐观更新 | UI 端 onPick 成功后本地更新 currentModeId，不依赖事件回流 |

## 7. 新会话接力指引

### 起手命令（供新会话开场用）
```
继续 docs/UI-REDESIGN-HANDOFF.md 的实施。先做 §5.1 三个剩余新文件
（ComposerToolbar / SessionRow / NewSessionRow），然后做 §5.2 改造既有文件。
验证标准见 §5.4。所有新组件必须先读 docs/DESIGN.md §5 primitive 定义。
```

### 验证清单（每完成一步跑）
1. `lsp_diagnostics` 当前文件无 error
2. 验证组件 import 路径用 `.js` 后缀（项目 module: NodeNext 要求）
3. 颜色用新 token (`--surface-*`, `--text-*`, `--border-*`)，旧别名尽量不出现
4. 间距用 `var(--space-N*)`
5. Mode/Vendor chip 触发器用 `AgentControlChip`，不另写 `<button>`
6. popover 用 `PopoverShell`，不另写 portal

### 关键约定
- TypeScript strict 全开 + `noUncheckedIndexedAccess: true` → 所有数组下标访问必须处理 `undefined`
- import 用 `.js` 后缀（ESM through NodeNext，源是 .tsx 但 import 写 .js）
- 不引入新依赖（当前 React 18 + react-markdown；不需要 react-popper / @floating-ui）
- 所有 comment 必要性要求高（避免冗余，但 §token 引用与"复杂算法/边界掩码"等必要注释保留）

### 已写入文件清单（可以直接打开 review）
- `docs/DESIGN.md`
- `docs/UI-REDESIGN-HANDOFF.md`（本文件）
- `packages/ui/src/App.css`（top token 块 + bottom primitive 样式块）
- `packages/ui/src/components/PopoverShell.tsx`
- `packages/ui/src/components/AgentControlChip.tsx`
- `packages/ui/src/components/ModelPopover.tsx`
- `packages/ui/src/components/ThinkingPopover.tsx`
- `packages/ui/src/components/ModePopover.tsx`
- `packages/protocol/src/rpc.ts` (新增 `agent.mode.set`)
- `packages/ui/src/ws.ts` (新增 `modes` / `setMode` 方法 + `AgentMode` import)

### 未触碰过（保持原样）的待改文件清单
- `packages/ui/src/components/Composer.tsx`
- `packages/ui/src/components/Sidebar.tsx`
- `packages/ui/src/components/Topbar.tsx`
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/TabsRow.tsx`（待删）

## 8. 风险与注意

1. **新建会话改 inline 不走 Modal** 会影响 e2e 9 用例中"建会话"用例；实施后期 e2e 必须更新（不在本交接范围追加，留给验证 phase）
2. **`mode_changed` 事件** 当前 daemon 不发，UI 用乐观更新兜底；后续若 daemon 端补发，UI 端 listener 也已能收到不会冲突
3. **claude / opencode provider 无 modes** ModePopover 自动隐藏，无 fallback UI；二期才能上 plan/build（DESIGN.md §8 已记账）
4. **`--surface-layer-01` 为 `#1f1f1f`** 比 `--card` `#212121` 浅 1 度而不是深；如果视觉巡检觉得违和可调任意一侧
5. **`App.css` 中既有别名兼容**：旧 `--bg-sunken / --card / --card-hover / --popover / --border / --border-soft / --text / --text-dim` 全部仍能用，但新代码用新名
6. **`AgentControlChip` 的 `data-mode-tint`** 仅 ModePopover 用；其他 chip 不传即不应用三色一体

## 9. 验收标准

实施完成时以下必须都为真：

- [ ] `npm run build` 通
- [ ] `npm run e2e:desktop` 跑过（允许更新脚本）
- [ ] 三 popover 在 Composer 工具条上从左到右排列正确
- [ ] 同一时间只一个 popover 打开（互斥）
- [ ] Esc 关闭 popover + 焦点还原到 composer
- [ ] 切换 mode 时 chip 配色按 tint 变化
- [ ] 切换 model 时 thinking popover 选项随模型变化（无 thinkingOptions 模型时 chip 隐藏）
- [ ] TabsRow 已删除，会话列表在 Sidebar 内
- [ ] Sidebar 顶部 NewSessionRow，点击跳 Composer 焦点
- [ ] Topbar 仅 prov-badge + 标题 + 路径 + 更多按钮
- [ ] 视觉巡检三 viewport 通过