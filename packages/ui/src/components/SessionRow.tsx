// SessionRow：sidebar 项目块下的会话行（DESIGN.md §5.3，替代 TabsRow）
// 结构：provider dot（running 时 11×11 spinner）+ 标题 + 时间 + hover 动作（close）
// 删除：Shift+Backspace 二次确认（不发 popup）

import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@agent-console/protocol";
import { providerMeta } from "../theme.js";

const CONFIRM_WINDOW_MS = 2500;

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface SessionRowProps {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

export function SessionRow(props: SessionRowProps) {
  const { session, active, running, onSwitch, onClose } = props;
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const armDelete = () => {
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    onClose(session.sessionId);
  };

  const meta = providerMeta(session.provider);
  const title = session.title ?? session.model ?? `会话 ${session.sessionId.slice(0, 6)}`;
  const time = formatTime(session.lastActiveAt ?? session.createdAt);

  return (
    <button
      type="button"
      className={`session-row${active ? " active" : ""}${confirming ? " confirming" : ""}`}
      onClick={() => onSwitch(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Backspace" && e.shiftKey) {
          e.preventDefault();
          armDelete();
        }
      }}
      aria-label={`${title} · ${meta.name}`}
      title={session.cwd ?? session.sessionId}
    >
      {running ? (
        <span className="session-spinner" aria-label="运行中" />
      ) : (
        <span className="dotp" style={{ background: meta.color }} />
      )}
      <span className="session-label">{title}</span>
      <span className="session-time">{confirming ? "再按一次删除" : time}</span>
      <span className="session-row-actions">
        <span
          className="session-action"
          role="button"
          tabIndex={-1}
          title={confirming ? "再点击一次确认关闭" : "关闭（再点击一次确认）"}
          aria-label={`关闭会话 ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            armDelete();
          }}
        >
          <svg className="icon" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      </span>
    </button>
  );
}
