# UI 设计输入：协议梳理

> 来源：`packages/protocol/src/agent-sdk-types.ts` + `packages/protocol/src/rpc.ts`
> 用途：作为 Web 中控台（Phase 3）的设计输入。设计时所有页面结构都应能映射回这里的类型。
> 注意：daemon 的 ws-server / agent-manager 尚未实现（Phase 2/3），本文档基于协议类型推演，标注了"设计开放点"。

---

## 1. 数据流总览

```
UI ──WS──► daemon
  │
  ├─ 请求-响应：ClientRequest (带递增 id) ──► ClientResponse { id, ok:true, result } | { id, ok:false, error }
  │
  └─ 事件推送：ServerPush（服务端主动发）
        { type: "session.ready" }         会话创建成功
        { type: "agent.event", event }    核心事件流（见 §3）
        { type: "agent.closed" }          会话关闭
```

**UI 侧核心职责**：按 `sessionId` 维护会话状态；把 `agent.event` 的 `timeline` 事件追加进该会话的 timeline；`permission_requested` 弹模态框并阻塞（等 `agent.permission.respond` 写回）。

---

## 2. 请求方法清单（ClientRequest → UI 操作）

| 方法 | 参数 | 返回 | 对应 UI 操作 |
|---|---|---|---|
| `providers.list` | — | 未定义 ⚠️ | 启动时拉取可用 agent 列表 |
| `agent.create` | `{ provider, cwd, model?, modeId?, systemPrompt? }` | 未定义 ⚠️ | "新建会话"（选 provider + cwd） |
| `agent.prompt` | `{ sessionId, prompt }` | — | composer 发送 |
| `agent.interrupt` | `{ sessionId }` | — | "停止"按钮 |
| `agent.close` | `{ sessionId }` | — | 关闭/销毁会话 |
| `agent.modes` | `{ sessionId }` | 未定义 ⚠️ | 模式选择器拉取 |
| `agent.models` | `{ provider }` | 未定义 ⚠️ | 模型选择器拉取 |
| `agent.permission.respond` | `{ sessionId, requestId, behavior, value?, interrupt? }` | — | 权限对话框提交 |

⚠️ 标注的方法，返回结构尚未在协议中定义（`result: unknown`），设计时需与 daemon 一起拍板。

---

## 3. 事件流（AgentStreamEvent → UI 行为）

| 事件 | 触发时机 | UI 行为 |
|---|---|---|
| `thread_started` | 会话建立 | 会话进入"就绪"态 |
| `turn_started` | 用户发送后 | timeline 底部出现"正在运行"占位，禁用 composer |
| `turn_completed`（含 `usage`） | 回合正常结束 | 清除运行态，更新 token 用量 |
| `turn_failed`（含 `error`） | 回合异常 | 错误提示条 |
| `turn_canceled`（含 `reason`） | 用户中断/超时 | 显示中断提示 |
| `timeline`（含 `item`） | 过程中持续推送 | **核心**：按 item 类型渲染并追加（见 §4） |
| `permission_requested` | agent 请求工具/提问/计划 | 弹权限模态框，阻塞 |
| `permission_resolved` | 用户已应答 | 关闭/更新对应权限卡片 |
| `mode_changed` | 模式切换 | 更新选择器状态 |
| `model_changed` | 模型切换 | 更新选择器状态 |

所有事件带 `provider`，多数带 `turnId`（用于 UI 把事件归组到某回合）。

---

## 4. Timeline 渲染映射（AgentTimelineItem）

| item.type | 内容 | 建议渲染 |
|---|---|---|
| `user_message` | text | 用户气泡（右对齐） |
| `assistant_message` | text | AI 气泡（markdown 渲染？— 设计决策点） |
| `reasoning` | text | 可折叠"思考过程"区 |
| `tool_call` | name + detail + status | 工具卡片：图标 + 名称 + detail 内容 + 状态角标 |
| `todo` | items[] | 任务清单（复选框样式，勾选态） |
| `error` | message | 红色错误条 |

`tool_call` 的 `detail` 是判别联合，按 `kind` 展示：

| kind | 展示内容 |
|---|---|
| `shell` | 等宽代码块：`$ command` |
| `read` / `edit` / `write` | 文件路径 + 图标 |
| `search` | 查询词 |
| `fetch` | URL |
| `plan` / `plain_text` | 文本段落 |
| `unknown` | 原始 JSON（可折叠） |

`tool_call.status`：`running`（spinner）→ `completed`（✓）/ `failed`（✗）/ `canceled`（—）。

---

## 5. 权限对话框（AgentPermissionRequest / Response）

请求（来自 `permission_requested`）：

```ts
{ id, kind: "tool" | "plan" | "question" | "other",
  description,            // 一句话描述，主文案
  detail?,                // 命令全文 / 问题原文，详情区
  raw? }                  // provider 原始数据，兜底展示
```

响应（`agent.permission.respond` 的 body）：

```ts
{ behavior: "allow" | "deny", interrupt?, value? }
```

| kind | UI 形态 |
|---|---|
| `tool` | allow / deny 两个按钮 + 命令详情（代码块） |
| `question` | 需要文本输入框（value 即答案）+ 提交 |
| `plan` | allow / deny（计划全文展示） |
| `other` | allow / deny + raw 折叠 |

---

## 6. 模型 / 模式选择器

```ts
AgentModelDefinition { id, label?, provider, isDefault?, isSelectable?, contextWindow? }
AgentMode { id, label, description? }
```

- 模型列表：`agent.models(provider)` — 按 provider 维度拉取
- 模式列表：`agent.modes(sessionId)` — 按会话维度拉取，`mode_changed` 事件实时同步
- UI 形态：composer 上方的下拉选择器（provider 之间隔离）

---

## 7. 设计开放点（需要 UI 设计反推 / 与 daemon 一起定）

1. **`providers.list` / `agent.create` / `agent.models` / `agent.modes` 的返回结构未定义** —— 建议各自返回最小可渲染结构（如 provider: `{ id, label?, available, capabilities }`）。
2. **多会话 vs 单会话**：协议里没有 `session.list`。MVP 若只支持"一个会话一张页面"则无需新增；若侧边栏会话列表，需加方法。
3. **"记住此权限选择"**：协议无 remember 字段，UI 不能做"不再询问"（可留灰置位）。
4. **消息聚合**：`timeline` 事件是流式逐条推送的，assistant 文本是否按 `messageId` 聚合增量更新，UI 侧要定策略。
5. **`AgentCapabilityFlags` 驱动 UI**：`supportsReasoningStream` → 是否显示思考区；`supportsStreaming` → 是否做流式输入动画；`supportsSessionPersistence` → 是否显示"恢复会话"入口。
6. **provider 差异**：claude 的权限请求结构（SDK）与其他 provider 不同，UI 用 `kind` + `raw` 兜底，不要绑定单一结构。
7. **`cwd` 输入**：`agent.create` 需要 cwd，UI 上要提供"工作目录"输入（默认从 daemon 侧拿？）。
