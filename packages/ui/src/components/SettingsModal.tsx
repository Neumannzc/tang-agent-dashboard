// 设置（v1：主题切换；后续可扩展到快捷键、agent 命令覆盖等）
// 主题来源：themeCatalog（在 theme.ts 集中声明）；新增主题只改目录 + CSS token。
// "跟随系统" 是独立开关，不是 themeCatalog 里的一项。

import { useEffect, useState } from "react";
import {
  applyTheme,
  loadThemeMode,
  persistThemeMode,
  SYSTEM_THEME_ID,
  themeCatalog,
  type ThemeMode,
} from "../theme.js";

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button className="btn btn-ghost" style={{ padding: 4 }} onClick={onClose}>
      ✕
    </button>
  );
}

function ThemeOption(props: {
  value: ThemeMode;
  selected: ThemeMode;
  label: string;
  hint: string;
  onPick: (value: ThemeMode) => void;
}) {
  const { value, selected, label, hint, onPick } = props;
  return (
    <button
      type="button"
      className={`p-card ${selected === value ? "active" : ""}`}
      onClick={() => onPick(value)}
      style={{ alignItems: "flex-start", padding: "10px 12px" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="p-name">{label}</div>
        <div className="p-sub">{hint}</div>
      </div>
    </button>
  );
}

export function SettingsModal(props: { onClose: () => void }) {
  const { onClose } = props;
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());

  useEffect(() => {
    // 切完模式立即写盘 + 应用
    persistThemeMode(themeMode);
    applyTheme(themeMode);
  }, [themeMode]);

  // 跟随系统：监听系统主题变化实时更新
  useEffect(() => {
    if (themeMode !== SYSTEM_THEME_ID) {
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      applyTheme(SYSTEM_THEME_ID);
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [themeMode]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          设置
          <CloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">外观</span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${themeCatalog.length + 1}, 1fr)`,
                gap: 8,
              }}
            >
              {themeCatalog.map((t) => (
                <ThemeOption
                  key={t.id}
                  value={t.id}
                  selected={themeMode}
                  label={t.label}
                  hint={t.hint}
                  onPick={setThemeMode}
                />
              ))}
              <ThemeOption
                value={SYSTEM_THEME_ID}
                selected={themeMode}
                label="跟随系统"
                hint="匹配系统外观设置"
                onPick={setThemeMode}
              />
            </div>
          </div>
        </div>
        <div className="modal-hint">更多设置（快捷键、agent 命令覆盖等）将在后续版本提供</div>
        <div className="modal-foot">
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}