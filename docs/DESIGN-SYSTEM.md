# Tang Agent Dashboard 设计系统

> 状态：**v1 定稿**（2026-08-06，用户确认"第一版就这样"）
> 唯一真源：`design/preview.html`（v4 原型：workspace 层级 + 导入历史会话）——本文件是其规范提取
> 背景：仿 Codex/ChatGPT Desktop 克制风格 + CodexPlusPlus 的 shadcn 灰阶体系；品牌色取自 `logo.jpg`
> 已定稿页面：侧边栏（项目列表）、主区（topbar + 会话 tabs + 对话流 + composer）、新建 workspace、新建会话、导入历史会话、权限卡片、打字机效果

---

## 1. 设计原则

1. **克制**：中性灰阶为主，零装饰、零 emoji；品牌色只出现在关键交互点（发送按钮、选中态、完成强调）
2. **深色优先**：`#181818` 系背景，暖调留白（品牌色仅作点缀）
3. **信息分层**：文本 → 卡片 → 深底代码区，靠灰阶区分而非彩色
4. **图标统一**：lucide 风格线条 SVG（16px，`stroke-width: 2`，`currentColor`），禁止 emoji 图标

---

## 2. 色彩 token

```css
:root {
  /* 背景层级 */
  --bg: #181818;            /* 主背景（shadcn background 0 0% 9.4%） */
  --bg-sunken: #141414;     /* 下沉区：代码块/工具卡/思考块 */
  --sidebar: #171717;       /* 侧边栏 */
  --card: #212121;          /* 卡片/hover（shadcn card 0 0% 12.9%） */
  --card-hover: #2a2a2a;
  --popover: #282828;       /* 下拉/弹层 */

  /* 描边 */
  --border: #303030;
  --border-soft: #262626;

  /* 文本 */
  --text: #ececec;
  --text-dim: #afafaf;      /* 次要（shadcn muted-foreground 68.6%） */
  --text-faint: #6e6e6e;    /* 弱化：时间戳/提示 */

  /* 品牌（logo 提取，仅点缀） */
  --accent: #cd8f74;        /* 珊瑚橙：发送按钮/选中 */
  --accent-hover: #d99c82;
  --accent-ink: #241512;    /* accent 上的文字色 */
  --accent-soft: rgba(205,143,116,.12);  /* 选中背景 */

  /* 语义色（克制使用） */
  --success: #7bb892;
  --danger: #e06c6c;
  --warn: #d9a45b;          /* 权限 kind 标签 */
  --info: #7aa2d9;          /* running 指示 */
}
```

**使用纪律**：语义色只用于状态指示（done/running/error/权限类型），不用于装饰。

---

## 3. 字体 / 间距 / 圆角

```css
--sans: -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
--mono: "SFMono-Regular", ui-monospace, "JetBrains Mono", Consolas, monospace;

/* 字号：正文 14px / 次要 12.5px / 弱化 11px / 侧边栏标题 13px */
/* 圆角：sm 8px（控件）/ 12px（卡片）/ 24px（composer 输入框） */
/* 间距基准：8px；对话流 gap 16px；内边距 卡片 11px 14px */
```

---

## 4. 多 Agent 标识规范（中控台身份）

本项目是 **Pi / Codex / Claude Code / OpenCode 四 agent 的统一中控台**，不是单一 agent 客户端。标识原则：**产品品牌与 agent 身份分离**。

| 用途 | 归属 | 色值 | 出现位置 |
|---|---|---|---|
| 珊瑚橙 `#cd8f74` | **产品自身**（Tang Agent Dashboard） | 品牌 | 发送按钮 / 选中态 / New chat |
| Pi 紫 `#7c5cd6` | agent 身份 | 官方语义色 | 头像徽标 / 会话色点 / topbar 标签 |
| Codex 蓝 `#4b54ff` | agent 身份 | 官方语义色 | 同上 |
| Claude 红棕 `#b05a48` | agent 身份 | 官方语义色 | 同上 |
| OpenCode 绿 `#3f7f5f` | agent 身份 | 官方语义色 | 同上 |

**规范**：
1. agent 色只用于**身份识别**（区分正在跟谁对话），禁止用于装饰/按钮/强调；品牌色只用于产品交互点
2. 身份标识三处配套出现：侧边栏会话色点 → topbar 标签（`● Pi` 胶囊）→ assistant 头像徽标（圆形 + 首字母）
3. 每处消息/权限卡都要带 agent 身份（如权限卡 "Pi 请求运行命令"、composer placeholder "描述你想让 Pi 做的事…"），避免上下文丢失
4. 四色并存时克制呈现：小尺寸（6px 色点 / 26px 徽标）、不发光不渐变

---

## 5. 信息架构与布局（Workspace 层级，借鉴 Paseo）

**IA：项目（workspace）→ 会话（session），会话严格挂在项目下**（先选项目，再在项目内新建/切换会话）。

```
window 1280×820（可缩放，min 900×600）
├── sidebar 276px                #171717
│   ├── New workspace 按钮（选项目目录）
│   ├── 搜索项目框
│   ├── 项目列表：每行 = 文件夹图标 + 项目名 + 会话数徽标 + mono 路径
│   │   └── 选中态：#212121 圆角；徽标变品牌色
│   └── 底部：账户头像 + daemon 状态 + 设置
├── main (main-surface)
│   ├── topbar 40px：provider 胶囊 + 会话标题 + 路径 + 模型选择器 + 更多
│   ├── tabs 行（当前项目下的会话）：
│   │   ├── tab = provider 色点 + 标题 + 关闭 ×；选中 = 深底 + 上边框
│   │   ├── [+] 新建会话（在当前项目下，弹 provider 选择）
│   │   └── 无会话时显示空态提示
│   ├── thread (thread-scroll-container) max-width 720px 居中
│   │   └── 项目无会话时：空态页（项目名/路径 + 新建会话/新建项目按钮）
│   └── composer (composer-surface-chrome) max-width 720px
└── 模态：新建 workspace（目录选择 + 可选初始 agent）/ 新建会话（agent + 模型）
```

**关键交互**：
1. 新建 workspace = 选项目目录（桌面端系统对话框）→ 空项目页
2. 新建会话永远在当前项目下发起（tabs `+` 或空态页按钮）
3. 切换项目 → 显示该项目自己的 tabs + 对话流
4. 会话关闭/新建不离开项目上下文

---

## 5. 组件规范

## 5.1 消息
- **user**：右对齐，无头像，灰卡 `#212121`，`border-top-right-radius: 4px`（对话气泡感），max-width 78%
- **assistant**：左对齐，26px 圆形徽标（**provider 官方色 + 首字母**，见 §4），head 行 = provider 名称 + 时间
- 消息体支持 markdown（正式版 `react-markdown`）：h3/ul/code/strong；`code` 深底 `#141414` 珊瑚色文字；`pre` 深底代码块

### 5.2 思考块（reasoning）
- `#141414` 底 + `#262626` 边框，头部"思考过程"可折叠（chevron 旋转 90°），正文 mono、`--text-dim`

### 5.3 工具调用卡（tool_call）
- `#141414` 底 + 边框，头部 = 名称（mono）+ 右侧状态（`done`=success 绿 / `running`=spinner+info 蓝）
- 正文 mono 12px，路径/命令前加 `→` 弱化前缀

### 5.4 待办（todo）
- `#141414` 底，行 = 复选框（方形 14px）+ 文本；完成态 = success 底色 + 白色对勾 + 删除线 + faint 文字

## 5.5 权限卡（permission_requested，内嵌 thread）
- `#212121` 底 + `#303030` 边框
- kind 标签：warn 色文字 + 淡黄底 + 细描边（`tool · shell` / `question` / `plan`）
- 描述带 agent 身份（"Pi 请求运行命令"）
- 命令详情：深底 mono；question 形态：内嵌 textarea（value 即答案）
- 按钮：**允许/提交** = 品牌色实心（accent-ink 文字）/ **拒绝** = 灰描边透明底
- 响应后原地替换为结果文本（success 绿 / danger 红）

### 5.6 按钮
- 默认：`#212121` 底 + `#303030` 边框，hover `#2a2a2a`
- 主操作（primary）：品牌色实心
- ghost：透明，hover 浅灰
- 图标按钮：30×30，圆角 8，hover 微亮

### 5.7 错误条 / running 提示
- 错误：`rgba(224,108,108,.07)` 底 + `.35` 边框 + `#e8a4a4` 文字
- running：spinner + 文字，`--text-faint`，缩进对齐消息列（`padding-left: 38px`）

---

## 6. 图标清单（lucide 风格，内联 SVG）

| 用途 | 图标 |
|---|---|
| 新建会话 | plus |
| 搜索 | search（circle + handle） |
| 设置 | settings-gear |
| 更多 | more-horizontal（3 点） |
| 发送 | arrow-up |
| 附件 | paperclip |
| 折叠 | chevron-right（旋转展开） |
| 模型下拉 | chevron-down |
| agent 徽标 | 圆形 + 首字母（provider 色，非 SVG logo） |

---

## 7. 与实现的关系

- 迁移时 CSS 作为独立 `theme.css` + 组件级 class（BEM 或 CSS Modules），token 用原生 CSS 变量（不做 Tailwind 依赖，Vite 项目保持轻量）
- `design/preview.html` 保持为可运行的 style guide 真源，后续新增组件先在原型里验证
- 正式版差异点：emoji 全替换为 SVG；四 agent 身份标识按 §4 执行（含新建会话面板的 provider 选择卡）
