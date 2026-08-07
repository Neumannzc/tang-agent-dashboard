// 主题常量：provider 身份色（DESIGN-SYSTEM.md §4：品牌色与 agent 身份分离）
// + 亮/暗主题切换（data-theme 属性）

import type { AgentProvider } from "@agent-console/protocol";

export const PROVIDER_META: Record<string, { name: string; color: string; sub: string; models: string[] }> = {
  pi: { name: "Pi", color: "#7c5cd6", sub: "JSONL over stdio", models: [] },
  codex: { name: "Codex", color: "#4b54ff", sub: "app-server", models: [] },
  claude: { name: "Claude", color: "#b05a48", sub: "Agent SDK", models: [] },
  opencode: { name: "OpenCode", color: "#3f7f5f", sub: "serve + SDK", models: [] },
};

export function providerMeta(provider: string) {
  return PROVIDER_META[provider] ?? { name: provider, color: "#6e6e6e", sub: "", models: [] };
}

export function providerLabel(provider: AgentProvider | string): string {
  return providerMeta(provider).name;
}

/* ============ 主题切换 ============ */

/**
 * 单个主题的声明。
 * 新增主题只需：
 *   1. 在 themeCatalog 加一项
 *   2. 在 App.css 加一组 [data-theme="<id>"] { ... } 重写 token
 */
export interface ThemeDefinition {
  /** 持久化 key；同时映射到 html[data-theme] 属性值 */
  id: string;
  /** 设置面板显示名（i18n 由上层传入，这里只放兜底中文） */
  label: string;
  /** 一行说明 */
  hint: string;
}

/** 已知主题目录。顺序即设置面板的展示顺序。 */
export const themeCatalog: ThemeDefinition[] = [
  { id: "dark", label: "深色", hint: "始终使用深色主题" },
  { id: "light", label: "浅色", hint: "始终使用浅色主题" },
];

/** 是否已知主题 id（用于 localStorage 校验；未知值当作 system 处理） */
export function isKnownThemeId(id: string): boolean {
  return themeCatalog.some((t) => t.id === id);
}

export const SYSTEM_THEME_ID = "system" as const;

/** 用户选择："system" 或任意已声明主题 id */
export type ThemeMode = typeof SYSTEM_THEME_ID | string;

/** 实际落到 html[data-theme] 的值：必须是 themeCatalog 里某项的 id */
export type ResolvedTheme = string;

const THEME_STORAGE_KEY = "tang-ai-chat:theme";

export function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === SYSTEM_THEME_ID) {
      return SYSTEM_THEME_ID;
    }
    if (raw && isKnownThemeId(raw)) {
      return raw;
    }
  } catch {
    // localStorage 不可用时降级
  }
  return SYSTEM_THEME_ID;
}

/** 把 mode 折成实际要应用的 theme id。system 时跟随系统外观 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== SYSTEM_THEME_ID && isKnownThemeId(mode)) {
    return mode;
  }
  // 系统跟随：取首个主题作为 fallback（理论上 catalog 第一项就是 dark）
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return themeCatalog[0]?.id ?? "dark";
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  return resolved;
}

export function persistThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}