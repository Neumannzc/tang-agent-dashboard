# cc-switch 模型/供应商切换实现调研

> 调研对象：`/home/tang/project/ai-chat/cc-switch`（源码快照，2026-08-07）。本文的“模型切换”在 cc-switch 中实际表现为切换一个 Provider；Provider 内同时保存 endpoint、凭据、模型和协议字段。所有行号均对应本次读取的源码。

## 1. 总体架构

### 1.1 两种切换语义

`AppType::is_additive_mode()` 将应用分成两类：Claude、Codex、Gemini 是 switch mode，只把当前 Provider 投影到 live；OpenCode（以及 OpenClaw/Hermes）是 additive mode，多个 Provider 可以同时写入 live 文件（[src-tauri/src/app_config.rs:400-409](/home/tang/project/ai-chat/cc-switch/src-tauri/src/app_config.rs#L400-L409)）。因此 OpenCode 没有“当前供应商”概念，`ProviderService::current` 直接返回空字符串（[src-tauri/src/services/provider/mod.rs:2534-2547](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2534-L2547)）。

核心数据存储是 SQLite Provider 表（前端看到的 `Provider` 对应后端 `Provider` 结构）。字段包括 `id`、`name`、`settingsConfig`、分类、图标和 `meta`；`settingsConfig` 是应用原生配置的 JSON 片段，`meta` 只存 cc-switch 内部元数据且不写入 live（[src-tauri/src/provider.rs:9-43](/home/tang/project/ai-chat/cc-switch/src-tauri/src/provider.rs#L9-L43)）。

### 1.2 统一入口调用链

1. UI 的 `providersApi.switch(id, appId)` 调用 Tauri `switch_provider`（[src/lib/api/providers.ts:49-92](/home/tang/project/ai-chat/cc-switch/src/lib/api/providers.ts#L49-L92)）。
2. `switch_provider` 将字符串解析为 `AppType`，用 `spawn_blocking` 调用 `ProviderService::switch`，并把 Rust 错误转换为字符串（[src-tauri/src/commands/provider.rs:86-118](/home/tang/project/ai-chat/cc-switch/src-tauri/src/commands/provider.rs#L86-L118)）。
3. `ProviderService::switch` 先验证 Provider 存在；OpenCode 的 OMO/OMO Slim 走专用路径，Claude Desktop 也强制走 normal path；Claude/Codex/Gemini/GrokBuild 会按应用加 proxy switch lock（[src-tauri/src/services/provider/mod.rs:2966-3002](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2966-L3002)）。
4. 检测到代理接管（DB 有 `live_backup` 或 live 文件含代理占位符）时调用 `ProxyService::hot_switch_provider_inner`；否则调用 `switch_normal`（[src-tauri/src/services/provider/mod.rs:3004-3055](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3004-L3055)）。
5. 前端 mutation 成功后刷新 Provider、代理状态、OpenCode live ID/运行时模型、Claude Desktop 状态等 Query；失败统一提取 Tauri 字符串并 toast（[src/lib/query/mutations.ts:279-344](/home/tang/project/ai-chat/cc-switch/src/lib/query/mutations.ts#L279-L344)）。

普通切换的实际步骤在函数注释中明确列出：先把旧 live 配置回填到旧 Provider，再写本机 current、DB `is_current`、目标 live，最后只同步本应用 MCP（[src-tauri/src/services/provider/mod.rs:2954-2965](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2954-L2965)）。

## 2. 前端入口与交互

### 2.1 Provider 列表和按钮

`ProviderList` 通过 `providersApi.getOpenCodeLiveProviderIds()` 查询 OpenCode 当前已投影的 ID，并用它决定按钮是“添加到配置”还是“移除”；非 additive 应用默认认为 Provider 已在配置中（[src/components/providers/ProviderList.tsx:101-133](/home/tang/project/ai-chat/cc-switch/src/components/providers/ProviderList.tsx#L101-L133)）。

`ProviderActions` 将 OpenCode（非 OMO）归为 additive mode：主按钮在 `isInConfig` 时执行 remove，否则执行 add/switch；普通 Claude/Codex 按 `isCurrent` 显示 disabled 的“使用中”或可点击的“启用”（[src/components/providers/ProviderActions.tsx:87-119](/home/tang/project/ai-chat/cc-switch/src/components/providers/ProviderActions.tsx#L87-L119)、[src/components/providers/ProviderActions.tsx:143-218](/home/tang/project/ai-chat/cc-switch/src/components/providers/ProviderActions.tsx#L143-L218)）。

### 2.2 切换前的路由/安全提示

`useProviderActions.switchProvider` 根据 Provider 的 `apiFormat`、OAuth `providerType`、完整 URL等判断是否必须由本地代理处理，并在 takeover 下阻止不支持代理的官方 Provider；成功后对 Codex 提示重启客户端，对 OpenCode 提示“已添加到配置”（[src/hooks/useProviderActions.ts:160-287](/home/tang/project/ai-chat/cc-switch/src/hooks/useProviderActions.ts#L160-L287)、[src/hooks/useProviderActions.ts:289-329](/home/tang/project/ai-chat/cc-switch/src/hooks/useProviderActions.ts#L289-L329)）。这只是 UX/防误操作，后端仍在 `ProviderService::switch` 和 hot-switch 中再次校验官方 Provider（[src-tauri/src/services/provider/mod.rs:3018-3029](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3018-L3029)、[src-tauri/src/services/proxy.rs:2461-2473](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2461-L2473)）。

### 2.3 表单产生的模型字段

- Claude 表单管理 `ANTHROPIC_MODEL`、Haiku/Sonnet/Opus、API format 和认证字段（[src/components/providers/forms/ClaudeFormFields.tsx:126-162](/home/tang/project/ai-chat/cc-switch/src/components/providers/forms/ClaudeFormFields.tsx#L126-L162)）。
- Codex 表单管理顶层模型、wire API、reasoning、model catalog、缓存路由等；模型映射在保存前去重、去空白并规范化（[src/components/providers/forms/CodexFormFields.tsx:190-260](/home/tang/project/ai-chat/cc-switch/src/components/providers/forms/CodexFormFields.tsx#L190-L260)、[src/components/providers/forms/ProviderForm.tsx:138-179](/home/tang/project/ai-chat/cc-switch/src/components/providers/forms/ProviderForm.tsx#L138-L179)）。
- OpenCode 表单的字段直接对应 `npm`、`options.baseURL`、`options.apiKey`、headers、models 和 extra options（[src/components/providers/forms/OpenCodeFormFields.tsx:159-208](/home/tang/project/ai-chat/cc-switch/src/components/providers/forms/OpenCodeFormFields.tsx#L159-L208)）。

## 3. Claude Code

### 3.1 Live 路径与格式

默认主配置是 `~/.claude/settings.json`；若该文件不存在但旧 `claude.json` 存在则兼容读取旧名，否则新建 `settings.json`（[src-tauri/src/config.rs:186-200](/home/tang/project/ai-chat/cc-switch/src-tauri/src/config.rs#L186-L200)）。用户可以在设置中指定 `claude_config_dir` 覆盖目录；路径支持 `~` 展开（[src-tauri/src/settings.rs:880-886](/home/tang/project/ai-chat/cc-switch/src-tauri/src/settings.rs#L880-L886)、[src-tauri/src/settings.rs:708-724](/home/tang/project/ai-chat/cc-switch/src-tauri/src/settings.rs#L708-L724)）。

Provider 的典型 `settingsConfig` 形状为：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gateway.example/v1",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "claude-sonnet-4-...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "...",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "..."
  }
}
```

统一 Provider 转 Claude 的代码明确生成这些 env 键（[src-tauri/src/provider.rs:750-779](/home/tang/project/ai-chat/cc-switch/src-tauri/src/provider.rs#L750-L779)）。写入 live 前会移除内部 `apiFormat`/`openrouterCompatMode` 等字段，避免污染 Claude Code 配置（[src-tauri/src/services/provider/live.rs:166-175](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L166-L175)）。Codex OAuth 作为 Claude Provider 时还会按 GPT-5.6 模型注入上下文窗口/自动 compact 默认值，且用户显式值优先（[src-tauri/src/services/provider/live.rs:81-134](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L81-L134)）。

### 3.2 普通切换

`switch_normal` 在切换到新 Provider 前读取当前 live；如果是 exclusive 应用，则将 live 中用户直接改动的公共片段合并回旧 Provider，剥离公共配置后保存（[src-tauri/src/services/provider/mod.rs:3087-3133](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3087-L3133)）。随后写入本机 settings 的 current ID 和 DB `is_current`，调用 `write_live_with_common_config` 投影目标配置（[src-tauri/src/services/provider/mod.rs:3136-3147](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3136-L3147)）。

Claude live 写入是 JSON 原子写；MCP 投影失败只记录 warning，不把已经完成的 Provider 切换报告成失败（[src-tauri/src/services/provider/mod.rs:3226-3235](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3226-L3235)）。Claude 插件集成是前端切换成功后的附加动作，失败只 toast，不回滚 Provider（[src/hooks/useProviderActions.ts:51-76](/home/tang/project/ai-chat/cc-switch/src/hooks/useProviderActions.ts#L51-L76)）。

### 3.3 代理接管差异

普通切换会直接覆盖 `settings.json`；代理接管时 live 属于代理，切换只热更新代理目标和 restore backup，不覆盖代理 endpoint。`switch` 检测 backup/占位符后调用 `hot_switch_provider_inner` 并跳过 MCP sync（[src-tauri/src/services/provider/mod.rs:3031-3051](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3031-L3051)）。hot-switch 先重建 backup，再同步 Claude 的代理安全字段；所有可失败的 backup/live 写入完成后才提交 current ID，失败会恢复旧 backup/live（[src-tauri/src/services/proxy.rs:2481-2527](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2481-L2527)、[src-tauri/src/services/proxy.rs:2557-2603](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2557-L2603)）。

## 4. Codex

### 4.1 Live 文件和 Provider 字段

默认目录为 `~/.codex`，包含 `auth.json`、`config.toml`，另有 cc-switch 私有投影文件 `cc-switch-model-catalog.json`；三个路径均支持设置里的 `codex_config_dir` 覆盖（[src-tauri/src/codex_config.rs:169-190](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L169-L190)、[src-tauri/src/settings.rs:888-894](/home/tang/project/ai-chat/cc-switch/src-tauri/src/settings.rs#L888-L894)）。

Codex Provider 的 `settingsConfig` 不是单一 JSON 配置，而是：

```json
{
  "auth": { "OPENAI_API_KEY": "sk-..." },
  "config": "model_provider = \"custom\"\nmodel = \"gpt-...\"\n..."
}
```

统一 Provider 生成的 TOML 包含 `model_provider`、顶层 `model`、`model_reasoning_effort`、`[model_providers.custom]`、`base_url`、`wire_api` 和 `requires_openai_auth`（[src-tauri/src/provider.rs:797-844](/home/tang/project/ai-chat/cc-switch/src-tauri/src/provider.rs#L797-L844)）。API key 优先读取 `auth.OPENAI_API_KEY`，兼容从 active model provider 或顶层 `experimental_bearer_token` 读取（[src-tauri/src/codex_config.rs:334-345](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L334-L345)、[src-tauri/src/codex_config.rs:1625-1659](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L1625-L1659)）；base URL 只从 active `model_provider` 对应表读取，再 fallback 顶层，避免误读非 active 表（[src-tauri/src/codex_config.rs:347-371](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L347-L371)）。

### 4.2 原子写与模型 catalog

写 Codex 时同时处理两个 live 文件。`write_codex_live_atomic` 先校验 TOML、写 `auth.json`，再写 `config.toml`；第二步失败会恢复旧 auth 或删除新 auth（[src-tauri/src/codex_config.rs:222-270](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L222-L270)）。Provider live writer 从 `settingsConfig.auth/config` 取值，并按 `apiFormat`/`wire_api` 选择 catalog tool profile（ProxyChat、NativeResponses、Anthropic）（[src-tauri/src/services/provider/live.rs:1030-1052](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L1030-L1052)）。

`modelCatalog` 是 DB SSOT 中的 Provider 字段，不内联到 `auth.json` 或 `config.toml`；写入时生成 `cc-switch-model-catalog.json`，并在 TOML 中维护 `model_catalog_json` 指针。读取 live 时反向解析 catalog，给编辑表单补回 `modelCatalog`（[src-tauri/src/services/provider/live.rs:1310-1325](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L1310-L1325)）。恢复时通过“是否存在 inline `modelCatalog`”区分 snapshot backup 和 provider-rebuilt backup：前者保留原 TOML 指针，后者重新生成 catalog，避免恢复丢失模型映射（[src-tauri/src/codex_config.rs:1575-1608](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L1575-L1608)）。

### 4.3 普通切换、官方登录态和重启

Codex 普通切换沿用 exclusive 流程：旧 live 回填 Provider，写本机/DB current，再写新 auth/config。若从第三方切到官方，只有回填成功后才清理旧第三方 auth，避免无登录材料导致 401；清理失败降级为 warning（[src-tauri/src/services/provider/mod.rs:3148-3169](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3148-L3169)）。前端切换成功文案要求重启 Codex 客户端生效（[src/hooks/useProviderActions.ts:304-313](/home/tang/project/ai-chat/cc-switch/src/hooks/useProviderActions.ts#L304-L313)）。

`read_codex_live_settings` 允许 auth 缺失（配置-only Provider 仍可导入），但 auth/config 都缺失时才报 live missing；空 `config.toml` 也是合法状态（[src-tauri/src/codex_config.rs:1748-1771](/home/tang/project/ai-chat/cc-switch/src-tauri/src/codex_config.rs#L1748-L1771)）。切换后 MCP 只针对 Codex 重新投影，因为 `[mcp_servers]` 与 `config.toml` 同文件；其它应用的坏配置不应阻断切换（[src-tauri/src/services/provider/mod.rs:3226-3235](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3226-L3235)）。

### 4.4 代理接管和 OAuth 保护

hot-switch 更新 Codex restore backup 时会保留旧 TOML 的 `mcp_servers` 以及官方 OAuth 登录材料；代理接管期间 Codex live 仍可被刷新为代理安全配置，但停止代理后从 DB backup 恢复（[src-tauri/src/services/proxy.rs:2360-2387](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2360-L2387)）。如果接管中切换 Codex 且已有 backup 但 live 暂时没有占位符，代码会额外直接写 Codex live，并在失败时回滚该直接写入（[src-tauri/src/services/proxy.rs:2502-2551](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2502-L2551)）。

## 5. OpenCode

### 5.1 Live 路径和 JSON schema

默认配置是 `~/.config/opencode/opencode.json`，支持 `opencode_config_dir` 覆盖；OpenCode 数据库默认按 XDG 为 `~/.local/share/opencode/opencode.db`，且说明了所有平台默认遵循该路径（[src-tauri/src/opencode_config.rs:48-94](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L48-L94)）。

Provider fragment 格式：

```json
{
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "https://api.example/v1",
    "apiKey": "sk-..."
  },
  "models": {
    "gpt-4o": { "name": "GPT-4o" }
  }
}
```

结构定义和字段名（`baseURL`/`apiKey` camelCase、models map、extra flatten）见 [src-tauri/src/provider.rs:902-980](/home/tang/project/ai-chat/cc-switch/src-tauri/src/provider.rs#L902-L980)。Usage credential 也从 `options.baseURL`/`options.apiKey` 读取（[src-tauri/src/provider.rs:210-217](/home/tang/project/ai-chat/cc-switch/src-tauri/src/provider.rs#L210-L217)）。

### 5.2 Additive 写入和 UI 行为

OpenCode 的 `add` 保存 DB 后立即把 fragment 写入 `opencode.json`；`addToLive=false` 时只存 DB。新建 OMO/OMO Slim Provider 不自动启用，必须显式切换（[src-tauri/src/services/provider/mod.rs:2550-2585](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2550-L2585)）。

写入前读取整个 JSON5 文件，缺失文件创建 `$schema` 根对象；根节点不是对象时报错，避免静默重建丢失用户的 model/theme。`provider` 不是对象时只重置该投影区；写入使用进程内 Mutex 串行化（[src-tauri/src/opencode_config.rs:101-145](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L101-L145)、[src-tauri/src/opencode_config.rs:157-193](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L157-L193)）。

删除 OpenCode Provider 先从 live 移除再删 DB；“从配置移除”则只移除 live 并把 `meta.liveConfigManaged=false` 写回 DB，Provider 仍留在列表（[src-tauri/src/services/provider/mod.rs:2831-2877](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2831-L2877)、[src-tauri/src/services/provider/mod.rs:2893-2951](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2893-L2951)）。编辑 DB-only Provider 不会意外重新添加到 live；只有它已存在 live 时才重写（[src-tauri/src/services/provider/mod.rs:2690-2747](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L2690-L2747)）。

### 5.3 OpenCode 的“切换”

普通 OpenCode Provider 点击“添加”实质上调用同一 `switch_provider` 入口，但 `switch_normal` 对 additive 应用不写 `is_current`，直接把 fragment 写入 live；写入成功后将 `liveConfigManaged` 标记为 true，若 DB 标记持久化失败会删除刚写入的 fragment，防止 DB/live 不一致（[src-tauri/src/services/provider/mod.rs:3136-3147](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3136-L3147)、[src-tauri/src/services/provider/mod.rs:3191-3223](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3191-L3223)）。

全量同步时 additive 应用遍历 DB 中所有 Provider，跳过明确 `liveConfigManaged=false` 的条目；因此启动、导入、云同步恢复不会把 DB-only 条目悄悄写回（[src-tauri/src/services/provider/live.rs:1169-1199](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L1169-L1199)）。前端切换成功后刷新 `opencodeLiveProviderIds` 和 runtime models，按钮状态随文件投影同步（[src/lib/query/mutations.ts:296-310](/home/tang/project/ai-chat/cc-switch/src/lib/query/mutations.ts#L296-L310)）。

OMO/OMO Slim 是 OpenCode 上的例外：它们使用专用 current marker 和专用配置文件，两个变体互斥；切换一个会写入该变体文件并删除另一变体文件，不走 `opencode.json` provider map（[src-tauri/src/services/provider/mod.rs:3068-3085](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/mod.rs#L3068-L3085)）。

### 5.4 错误处理

OpenCode JSON5 解析失败、根节点类型错误、provider fragment 缺少 `npm`/`options` 时返回明确配置错误；fragment 反序列化失败但看起来仍像合法 fragment 时降级为 raw JSON 写入，否则拒绝（[src-tauri/src/opencode_config.rs:101-131](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L101-L131)、[src-tauri/src/services/provider/live.rs:1086-1117](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L1086-L1117)）。删除/写入使用同一 Mutex；插件移除还会检测磁盘内容是否在读取后被外部修改，发生竞争时提示 reload（[src-tauri/src/opencode_config.rs:317-349](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L317-L349)）。

## 6. 状态同步、备份与恢复

### 6.1 current 状态的双层来源

本机 current ID 写入 `~/.cc-switch/settings.json`，设备级设置不参与数据库同步；DB 的 `is_current` 作为新设备默认值。读取时先验证本机 ID 是否仍存在，不存在就清理并 fallback 到 DB（[src-tauri/src/settings.rs:956-1027](/home/tang/project/ai-chat/cc-switch/src-tauri/src/settings.rs#L956-L1027)）。这解决了云同步后本机 current 指向已删除 Provider 的问题。

### 6.2 Proxy live backup

代理启动前把 Claude、Codex、Gemini、GrokBuild 的 live 配置序列化到 DB `live_backup`；检测到代理占位符时跳过再次备份，避免把代理配置固化成“原始配置”（[src-tauri/src/services/proxy.rs:1381-1444](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L1381-L1444)）。停止代理通过 `LiveSnapshot::restore` 恢复 JSON、Codex auth/config 或 Gemini env/settings；文件原来不存在则删除恢复文件（[src-tauri/src/services/provider/live.rs:942-1012](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/provider/live.rs#L942-L1012)）。OpenCode 不参与该代理 backup，因为它是 additive 且不被代理 takeover 逻辑管理。

代理 hot-switch 先写 backup/live，之后才更新本机 current 和 DB current；任何失败会调用 rollback，保证 UI current、代理 target、restore backup 三者不会只成功一部分（[src-tauri/src/services/proxy.rs:2481-2603](/home/tang/project/ai-chat/cc-switch/src-tauri/src/services/proxy.rs#L2481-L2603)）。

### 6.3 事件与 Query 同步

UI mutation 自己 invalidate 相关 Query；托盘、故障转移和 Profile apply 还会发 `provider-switched` 事件。App 监听该事件，在当前 app 匹配时 refetch，确保外部入口切换后列表高亮更新（[src/lib/api/providers.ts:133-140](/home/tang/project/ai-chat/cc-switch/src/lib/api/providers.ts#L133-L140)、[src/App.tsx:361-389](/home/tang/project/ai-chat/cc-switch/src/App.tsx#L361-L389)）。Profile apply 只对所属分组发送统一事件 payload，然后发 `profile-applied` 刷新 MCP、skills、proxy 和 Claude Desktop 状态（[src-tauri/src/commands/profile.rs:58-93](/home/tang/project/ai-chat/cc-switch/src-tauri/src/commands/profile.rs#L58-L93)、[src/App.tsx:400-413](/home/tang/project/ai-chat/cc-switch/src/App.tsx#L400-L413)）。

## 7. 平台差异和实现启示

- 路径不要硬编码：Claude/Codex/OpenCode 都提供设置覆盖目录，并统一支持 `~` 展开（[src-tauri/src/settings.rs:880-934](/home/tang/project/ai-chat/cc-switch/src-tauri/src/settings.rs#L880-L934)）。OpenCode 数据目录明确遵循 XDG，Windows/macOS 也默认使用 `~/.local/share/opencode`（[src-tauri/src/opencode_config.rs:80-94](/home/tang/project/ai-chat/cc-switch/src-tauri/src/opencode_config.rs#L80-L94)）。
- Claude 使用 JSON，Codex 是 auth JSON + TOML 的双文件事务，OpenCode 是 JSON5 中的 provider map；不能用一个“整文件替换”策略覆盖三者。
- DB 应保存 Provider SSOT 和内部 metadata，live 文件只保留客户端能理解的字段。Codex `modelCatalog` 的独立投影、Claude `apiFormat` 清洗和 OpenCode `liveConfigManaged` 都是此边界的实例。
- 切换前回填旧 live 是保留用户手工改动的关键；切换后 MCP/skills 应按应用隔离同步，避免无关应用坏配置把已完成切换报成失败。
- 对有代理接管的客户端，需要“逻辑 current”和“实际 live owner”两个状态，并按 app 加锁；先准备 backup/live、再提交 current，并为失败路径保留可恢复快照。

## 8. 为其他项目复用的最小设计

1. 定义 `Provider { id, settings, metadata }`，DB 保存所有 Provider；每个客户端实现独立 adapter：`read_live`、`write_live`、`remove_live`、`validate`。
2. 明确 `exclusive` 与 `additive`：exclusive 维护 current 并在切换前回填；additive 维护 live membership，不要伪造 current。
3. 将多文件配置写入封装为事务（Codex 的 auth/config 模式），至少做到预校验、原子写、失败回滚。
4. 把代理接管建模为 `live_backup + proxy_target + lock`，hot-switch 不直接破坏原始 live，停止代理从 backup 恢复。
5. 前端 mutation 成功后刷新本 app 的 provider/live 状态；同时为托盘、脚本、云同步等外部入口提供统一事件 payload，避免 UI 状态陈旧。
