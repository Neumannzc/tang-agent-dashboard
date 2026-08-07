# 会话归档 / 还原方案（SESSION-ARCHIVE-PLAN）

状态：方案稿 v1
范围：daemon（SQLite + RPC）+ UI（sidebar 归档分区）
目标：给会话提供「归档 → 隐藏 → 还原」能力，解决会话列表无限增长、无整理手段的问题。

## 1. 背景与调研

### 1.1 现状

- 会话持久化在 `~/.agent-console/sessions.db`（`packages/daemon/src/session-store.ts`），`sessions.list` 返回**全部**会话，UI 按 cwd 聚合到 sidebar 项目树。
- 「关闭」（X / Shift+Backspace）只把会话从内存卸载（`agent-manager.closeSession`），**DB 记录不删**（`store.remove` 目前无调用方）。
- 结果：会话只增不减，列表越来越长，没有任何整理手段。

### 1.2 竞品做法（源码核实）

| 产品 | 数据模型 | UI |
|---|---|---|
| opencode | session 表 `time.archived` **时间戳**字段；`patch` API 写入；列表查询默认 `isNull(time_archived)` 过滤，显式 `input.archived` 才返回归档项 | 归档会话从主列表消失，可按需查询 |
| CodexPlusPlus | threads 表 `archived` 布尔列 | 会话卡片显示「已归档」badge，首页统计 active / archived 计数 |
| Cursor / Windsurf / Linear（行业惯例） | archive ≠ delete | 从主列表隐藏、数据保留、可搜索、可还原；删除不可逆，归档可逆 |

**共识**：归档 = 软隐藏 + 可还原。数据（含恢复句柄）不动，只改可见性与排序。

## 2. 方案

### 2.1 语义定义

- **归档（archive）**：会话从活跃列表隐藏，进入「已归档」分区。DB 记录、`handle` 恢复句柄、cwd/model 等全部保留。
- **还原（unarchive）**：会话回到原 workspace 活跃列表，可正常 resume 继续对话。
- **与删除的区别**：删除（二期再做，目前只有 close 卸载）不可逆；归档可逆。
- 归档**不改变** cwd / model / handle，纯粹是可见性标记。

### 2.2 数据层（daemon / session-store.ts）

```sql
-- schema v2：新增列（迁移：ALTER TABLE sessions ADD COLUMN archived_at INTEGER）
archived_at INTEGER  -- NULL = 未归档；时间戳 = 归档时间
```

- `StoredSession` 增加 `archivedAt?: number`。
- `SessionStore` 新增：
  - `archive(sessionId): void` — 写 `archived_at = Date.now()`
  - `unarchive(sessionId): void` — 清 `archived_at = NULL`
  - `list()` 保持返回全部（含归档），由上层/UI 过滤 —— 桌面端会话量级小，不引入服务端过滤复杂度；预留 `includeArchived` 参数给未来分页。
- `SCHEMA_VERSION` 升到 2；`init()` 里做幂等迁移（`PRAGMA table_info` 检查列是否存在，不存在则 ALTER）。
- 与旧版 `sessions.json` 迁移逻辑互不影响（新安装直接建 v2 表）。

### 2.3 协议层（protocol / rpc.ts）

```ts
// SessionSummary 增加
archivedAt?: number;

// ClientRequest 新增两个方法
| { method: "session.archive"; params: { sessionId: string } }
| { method: "session.unarchive"; params: { sessionId: string } }
```

两个方法均返回更新后的 `SessionSummary`（UI 直接落地，不用重新 list）。

### 2.4 daemon 编排（agent-manager.ts）

- `archiveSession(sessionId)`：
  1. 会话在 `running` 集合中 → 抛错「会话正在运行中，请先中断」（避免归档运行中会话导致事件流混乱）。
  2. 会话已加载（内存 map 中）→ 先 `closeSession` 卸载（复用现有逻辑，广播 `agent.closed`）。
  3. `store.archive(sessionId)` → 返回更新后的 summary。
- `unarchiveSession(sessionId)`：`store.unarchive` → 返回 summary。
- `resumeSession`：命中已归档会话时**自动 unarchive**（还原语义：能继续聊的会话就该回到活跃列表），再走现有 resume 流程。
- `listSessions`：`archivedAt` 透传到 `SessionSummary`。

### 2.5 ws-server.ts

`dispatch` 增加 `session.archive` / `session.unarchive` 两个 case，转发 manager。

### 2.6 UI 层

**聚合（state.ts）**：
- `buildWorkspaces` 只聚合 `archivedAt == null` 的会话；新增 `buildArchivedSessions(sessions)` 返回归档会话（按 `archivedAt` 倒序）。
- workspace 的 `sessionIds` 与 `count` 均只含活跃会话。

**Sidebar**：
- 项目树下方新增「已归档」分区（可折叠，折叠状态用 localStorage 记住），标题行显示归档数量。
- 每个归档会话一行（复用 SessionRow 视觉：provider dot + 标题 + 归档时间），hover 动作：
  - 「还原」按钮（图标：撤销/循环箭头）
  - 点击行 = 还原 + 切换（resume 后进入该会话，与活跃会话点击行为一致）
- 搜索框命中归档项目时，项目下照常展开，归档会话行带「已归档」标记（区别于活跃行）。

**SessionRow**：
- hover 动作区新增「归档」图标（box 图标，放在关闭 X 旁边），点击直接归档（无二次确认——可逆操作；tooltip「归档」）。
- 新增 `archived` prop 控制「已归档」标记样式；`onArchive` / `onUnarchive` 回调。

**App.tsx**：
- `sessions` 状态新增 `archivedAt` 字段流转（无需额外 state，summary 自带）。
- `handleArchiveSession` / `handleUnarchiveSession` → 调 daemon RPC，成功后用返回的 summary 更新本地状态。
- 归档**当前活跃会话**：先归档（daemon 侧自动 close），UI 清空当前会话视图回到空态。
- 点击归档会话 → `resumeSession`（daemon 自动还原）→ 正常进入。

**样式**：归档行降低不透明度 + 斜体/标记徽标，与活跃行区分；「已归档」分区标题用小号弱化文字。遵循 DESIGN-SYSTEM 暗色 token，不加新颜色。

## 3. 边界与坑

1. **running 会话禁止归档**：daemon 侧 `running` 集合校验，返回明确错误信息。
2. **归档 active 会话 = 先 close 再归档**：复用 `closeSession`，保证 `agent.closed` 广播、UI 端状态一致。
3. **`touch` 不影响归档状态**：归档会话的 `last_active_at` 不再更新（prompt 入口本身就会拦——归档会话不会在活跃列表，无法 prompt；resume 时已自动还原）。
4. **归档会话的搜索**：只出现在归档分区/项目树展开中，不污染活跃计数。
5. **handle 失效**：归档会话长期不还原，provider 侧句柄可能过期——resume 失败时报现有错误信息即可，不额外处理（与当前未归档旧会话同等对待）。
6. **协议兼容**：`SessionSummary` 加可选字段、新增 RPC 方法均为向后兼容变更；旧 daemon + 新 UI 组合下 UI 需容忍 `archivedAt === undefined`（视为未归档）。

## 4. 实施清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/protocol/src/rpc.ts` | `SessionSummary.archivedAt?`；新增 2 个 RPC 方法 |
| 2 | `packages/daemon/src/session-store.ts` | schema v2 迁移、`archived_at` 列、`archive/unarchive`、rowToSession 透传 |
| 3 | `packages/daemon/src/agent-manager.ts` | `archiveSession`（running 校验 + 先 close）/ `unarchiveSession`；`resumeSession` 自动还原；`listSessions` 透传 |
| 4 | `packages/daemon/src/ws-server.ts` | dispatch 2 个 case |
| 5 | `packages/ui/src/state.ts` | `buildWorkspaces` 排除归档；`buildArchivedSessions` |
| 6 | `packages/ui/src/App.tsx` | RPC 调用、状态更新、当前会话归档清空视图 |
| 7 | `packages/ui/src/components/SessionRow.tsx` | 归档图标 + `archived` 标记 + `onArchive/onUnarchive` |
| 8 | `packages/ui/src/components/Sidebar.tsx` | 已归档折叠分区 + 还原 + 搜索展开 |
| 9 | `packages/ui/src/App.css` | 归档分区/标记样式（沿用现有 token） |

验证：`npm run build` 全绿；`npx tsx packages/daemon/src/cli-test.ts` 冒烟不受影响；手动验证 归档→隐藏→还原→resume→继续对话 全链路；`npm run e2e:desktop` 不回归。

## 5. 二期可选项（本方案不做）

- 自动归档策略：N 天未活跃自动归档（`archived_at` 时间戳已为它铺路）。
- 归档会话全文搜索 / 标题搜索。
- 批量归档（按 workspace 一键归档全部）。
- 真正的删除（purge）与「清空已归档」。
