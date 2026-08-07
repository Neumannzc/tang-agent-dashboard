# Tang Agent Dashboard 前端开发计划 v2（桌面版）

> 独立计划：仅覆盖前端，不与 `docs/PLAN.md` 混编
> 产品名：**Tang Agent Dashboard**（棠仔开发）
> 关联文档：`UI-DESIGN.md`（功能设计）、`DESIGN-SYSTEM.md`（设计系统，**v1 已定稿**）、`DESKTOP-PLAN.md`（桌面壳方案）、`PLAN.md`（全栈计划）

---

## 0. 变更记录

| 版本 | 说明 |
|---|---|
| v1 | Expo/React Native 三端（iOS/Android/Web）+ Electron 壳 |
| **v2（当前）** | **需求收敛为桌面版**：不做 iOS/Android。技术栈改为 **Vite + React + TS + Electron 壳**（Expo 在纯桌面场景无必要，且并行进程已交付 Vite 版实现，迁移成本≈0） |

---

## 1. 产品与品牌

- 产品名：Tang Agent Dashboard；深链 scheme：`tang-ai-chat://`（已定稿，方案随产品名可再议）
- Logo：`/logo.jpg`（1254×1254，暖色系）
- **品牌色（提取自 logo）**：主 `#CD8F74`（珊瑚橙）、深 `#6E4B4A`（红棕）、浅 `#F4E0D2`（奶油）、`#DBAB9F`（玫瑰粉）
- 主题基调：暗色为主，背景带暖调（深棕黑 `#141112` 系），品牌色用于强调/选中态

---

## 2. 现状盘点（并行进程已交付，迁移基础）

| 模块 | 状态 | 位置 |
|---|---|---|
| daemon ws-server / agent-manager / session-store | ✅ 已实现 | `packages/daemon/src/` |
| daemon static-server（serve UI 静态产物） | ✅ 已实现 | `packages/daemon/src/static-server.ts` |
| protocol 扩展（`SessionSummary`、session.list、resume 等） | ✅ 已实现 | `packages/protocol/src/` |
| UI：DaemonClient（WS 客户端，`ws://127.0.0.1:8765`） | ✅ 已实现 | `packages/ui/src/ws.ts` |
| UI：timeline / composer / 权限对话框 / 会话侧边栏 | ✅ 已实现（582 行） | `packages/ui/src/App.tsx` |
| UI：打字机聚合（assistant_message 按 turnId 替换） | ✅ 已实现 | `App.tsx` `appendTimelineItem` |
| **desktop：Electron 壳**（spawn daemon → 轮询就绪 → 窗口 loadURL daemon serve 的 UI → 退出回收） | ✅ 已实现 | `packages/desktop/main.cjs` |
| 根脚本 `scripts/dev.mjs`（并行起 daemon + ui） | ✅ 已实现 | 根目录 |

**desktop 实现差异（并行进程 vs DESKTOP-PLAN）**：并行进程用「daemon 内嵌 static-server 直接 serve UI 产物，窗口 `loadURL(http://127.0.0.1:8765)`」；DESKTOP-PLAN 规划的是「自定义协议 `tang-ai-chat://` 从 resources 读静态产物」。迁移时评估：
- 并行方案更简单（单端口、无自定义协议），但 UI 依赖 daemon 存活、无深链/目录选择器/窗口持久化
- 建议保留并行方案的加载方式，按 DESKTOP-PLAN 增量补：目录选择器（preload IPC）、窗口状态持久化、深链（二期）；自定义协议方案作为生产打包时的备选

**缺口**（v2 计划要补的）：品牌/设计系统、markdown 渲染（现为纯文本）、引导页、权限"拒绝并中断"、Electron 壳、目录选择器、深链、状态管理整理、**workspace（项目）层级**（本轮设计变更，见 §5.5）

---

## 3. 目标与范围

**目标**：以现有 Vite 实现为基底，完成**桌面版**（浏览器 + Electron 壳复用同一 web 产物）的前端：品牌化设计系统、功能对齐 `UI-DESIGN.md`、落地 `DESKTOP-PLAN.md` 的 Electron 壳。

**本期不做**：iOS/Android（已确认）、附件、斜杠命令、PWA 离线、自动更新（二期）、托盘（二期）。

---

## 4. 技术栈（v2）

| 项 | 选型 | 说明 |
|---|---|---|
| 框架 | Vite 5 + React 18 + TS | 已有，保持 |
| 状态 | 现为 useState 集合；迁移时评估 zustand（可选，不强制） | 轻量优先 |
| 路由 | 现为单页无路由；多会话侧边栏下可不引入 router | 保持简单 |
| Markdown | `react-markdown`（统一，无跨端包袱） | v1 的 RonRadtke fork 不再需要 |
| WS | 原生 WebSocket（已有 DaemonClient） | 不变 |
| 桌面壳 | Electron + electron-builder（`DESKTOP-PLAN.md`） | 复用 web 产物 |
| 品牌 | 主题 token 文件 + logo 资产 | 新增 |

依赖方向不变：`ui → @agent-console/protocol`；`desktop → ui(dist) + daemon(二进制)`。

---

## 5. 里程碑（迁移导向）

| 里程碑 | 内容 | 验证标准 |
|---|---|---|
| **M0 现状确认** | 审查并行进程全部交付（daemon/protocol/ui/脚本），`npm run dev` 跑通全链路 | 浏览器完成"创建会话 → 发消息 → 看 timeline → 权限处理" |
| **M1 品牌与设计系统** | 主题 token（暖色品牌）、logo 应用（标题栏/空状态/窗口图标）、基础组件样式统一、**react-markdown 渲染消息** | 页面呈现品牌视觉；assistant 消息 markdown/代码块正确渲染 |
| **M2 功能对齐 UI-DESIGN** | 引导页（无会话时）、权限对话框补"拒绝并中断"（`interrupt: true`）、新建会话表单完善（模式选择）、状态管理整理（可选 zustand） | 各交互按设计文档走查通过 |
| **M2.5 Workspace 层级**（本轮设计变更） | 信息架构改为 **项目（workspace）→ 会话**：侧边栏改为项目列表，主区加会话 tabs 行，新建会话必须挂在当前项目下（对齐 Paseo 的 workspace 模型）。协议侧 MVP 用**方案 A**：按 `session.cwd` 前端聚合归组为 workspace（协议不改），预留方案 B（workspace 实体） | 项目切换 → tabs 跟着项目变；新建会话挂到当前项目；空项目有引导页 |
| **M3 Electron 壳** | 按 `DESKTOP-PLAN.md`：`tang-ai-chat://` 协议静态服务（SPA fallback）、daemon 自动托管（spawn/health/退出清理）、**cwd 系统目录选择器**（preload IPC 桥）、深链 `tang-ai-chat://session/<id>`、窗口状态持久化、安全基线 | 打包产物离线可跑；关窗口 daemon 进程树清理干净；目录选择/深链可用 |
| **M4 联调与收尾** | 真实四 agent 全流程回归、窗口缩放适配、打包产物（mac/win/linux）验证 | 桌面端完成完整闭环；三平台产物可安装运行 |

**依赖**：M0–M2 在 Web 端（Vite）进行，与 daemon 并行无冲突；M3 依赖 M0；M4 收尾。

---

## 6. 目录结构（迁移目标态）

```
packages/
├── ui/                        （现有 Vite 项目重构）
│   ├── index.html / vite.config.ts / tsconfig.json
│   └── src/
│       ├── main.tsx / App.tsx（或按组件拆分）
│       ├── ws.ts              （DaemonClient，已有）
│       ├── theme/ tokens.ts   （品牌色，新增）
│       ├── components/        （原子 + 业务组件拆分）
│       ├── features/          （workspaces/timeline/composer/permission/sessions/connection）
│       └── assets/logo.jpg    （新增）
└── desktop/                   （新增，DESKTOP-PLAN.md）
    ├── src/main.ts / protocol.ts / daemon-manager.ts / window-manager.ts / preload.ts
    ├── electron-builder.yml
    └── scripts/dev.sh
```

---

## 7. 迁移策略（等并行进程完成后执行）

1. **冻结并行进程**：确认其不再写 `packages/ui`、`packages/protocol`、`packages/daemon`（问用户/检查 mtime）
2. **快照**：记录当前实现行为（现有 App.tsx 的交互逻辑是迁移基线）
3. **分步迁移**：M0 跑通 → M1 品牌层叠加（不破坏现有功能）→ M2 功能补齐 → M3 Electron → M4 收尾
4. **不重写可用的**：DaemonClient、打字机聚合、会话管理逻辑保留，只做样式/品牌/能力增强

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 并行进程持续改动造成冲突 | 迁移前冻结 + 快照；只增量修改不整文件重写 |
| 单一 App.tsx 582 行膨胀 | M2 迁移时按 features 拆分组件 |
| workspace 聚合（方案 A）边界 | 同一 cwd 的会话归组为一个项目；若用户对同一目录开两个会话（不同 provider），应同组；cwd 语义以 `session.create` 的 cwd 为准 |
| markdown 引入影响打字机聚合 | react-markdown 渲染挂在聚合后的完整消息上，增量更新仍替换整条文本 |
| daemon 端口/协议细节与 Vite 版不一致 | M0 以 ws-server 实际实现为准校核协议类型 |
| Electron 壳依赖 web 产物路径 | M3 用 `expo export` 的替代：`vite build` 产物 `dist/`，electron-builder `extraResources` 打包 |

---

## 9. 当前动作

1. ✅ 本计划定稿
2. ✅ **M0 完成**（2026-08-06 夜）：`npm run dev` 全链路跑通；WS 冒烟（providers.list / sessions.list / agent.create+close / agent.prompt 真实 pi 回合）；确认 SessionStore 磁盘持久化（`~/.agent-console/sessions.json`）、`sessions.list` 带 cwd（workspace 方案 A 可行）
3. ✅ **M1 + M2.5 完成**：设计系统 CSS（App.css 全量重写）、workspace 重构（App.tsx 按 features 拆分：theme/state/Sidebar/TabsRow/Topbar/Timeline/Composer/PermissionCard/Modals）、react-markdown 渲染、权限内嵌卡 + “拒绝并中断”、新建 workspace/会话模态、导入历史会话 UI（数据源二期）、欢迎页/空项目页
4. ✅ UI 自动化验证：playwright-core + 系统 chrome 全流程 9/9 通过（欢迎页 → 建 workspace → 建会话 → 发消息 → markdown → 关会话 → 多会话）
5. ⏳ **待办**：M2 剩余（模型切换仅 UI 层，daemon 无切换方法）；M3 Electron 增强（cwd 目录选择器 preload、窗口持久化、深链）；M4 四 agent 联调 + 打包

## 9.5 问题清单（2026-08-06 记录，不阻塞进度）

| # | 问题 | 状态 | 备注 |
|---|---|---|---|
| 1 | dev/desktop 环境 PATH 缺 agent 二进制目录（nvm bin）→ spawn ENOENT | ✅ 已修 | `scripts/dev.mjs` 用 `path.dirname(process.execPath)` 补 PATH；desktop main.cjs 二期同样处理 |
| 2 | daemon 对不存在 cwd 报 `spawn pi ENOENT`（误导） | 📝 待改 | 应改为清晰错误“cwd 不存在”；新建 workspace 时前端应校验目录存在 |
| 3 | `agent.close` 只对已加载（active）会话生效，未加载会话 close 无效 | 📝 待改 | daemon agent-manager 二期处理 |
| 4 | 模型切换仅 UI 层（改 SessionSummary.model），daemon 无切换方法 | 📝 待补协议 | 二期：agent 侧重启会话换模型 |
| 5 | 会话标题固定为 provider·model，无用户命名 | 📝 二期 | 与 session rename 一起做 |
| 6 | 导入历史会话：UI 已定稿，扫描/导入数据源二期（CodexPlusPlus 已验证 codex 侧可读） | ⏳ 二期 | `sessions.scanHistory` / `sessions.importHistory` |
| 7 | 侧边栏“更多/设置”按钮为占位 | ⏳ 二期 | 健康检查卡片设计（借鉴 CodexPlusPlus health-grid）|
| 8 | Electron 窗口图标未接（logo.png 已备于 ui/public） | ⏳ M3 | BrowserWindow icon + electron-builder 应用图标 |

## 10. 运维纪律（事故教训，2026-08-06）

- **事故**：清理残留 dev 进程时 `kill -9 1210`（未确认身份，疑为桌面会话进程）+ `pkill -9 -f "npm run dev"`，导致用户图形会话崩溃重启。系统未重启（uptime 正常），桌面会话重启。
- **纪律**：
  1. 杀进程前必须 `ps -p <pid> -o comm,args` 确认身份；只杀自己启动的进程
  2. 禁用 `kill -9` 与宽泛 `pkill -f`；优先 `kill <pid>`（TERM），确认无效再考虑强杀
  3. 端口占用排查用 `ss -tlnp`（不要依赖 lsof），TIME_WAIT 残留会自释，等 60s 即可
  4. 环境变更（启停 dev/daemon）前告知用户；用户在场时不做批量清理
