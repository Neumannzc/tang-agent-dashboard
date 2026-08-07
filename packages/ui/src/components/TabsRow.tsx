// 会话 tabs 行：当前项目下的会话 + 新建

import type { SessionSummary } from "@agent-console/protocol";
import { providerMeta } from "../theme.js";

function sessionTitle(session: SessionSummary): string {
  const label = providerMeta(session.provider).name;
  if (session.model) {
    return `${label} · ${session.model}`;
  }
  return `${label} · ${session.sessionId.slice(0, 8)}`;
}

export function TabsRow(props: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}) {
  const { sessions, activeSessionId, onSwitch, onClose, onNew } = props;

  return (
    <div className="tabs-row">
      {sessions.length === 0 ? (
        <div className="tabs-empty">该项目暂无会话 — 点击 + 新建</div>
      ) : (
        sessions.map((session) => {
          const meta = providerMeta(session.provider);
          return (
            <div
              key={session.sessionId}
              className={`tab ${session.sessionId === activeSessionId ? "active" : ""}`}
              onClick={() => onSwitch(session.sessionId)}
              title={session.cwd ?? session.sessionId}
            >
              <span className="dotp" style={{ background: meta.color }} />
              <span className="t-title">{sessionTitle(session)}</span>
              <span
                className="close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.sessionId);
                }}
              >
                <svg className="icon" viewBox="0 0 24 24">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </span>
            </div>
          );
        })
      )}
      <button className="tab-add" title="新建会话" onClick={onNew}>
        +
      </button>
    </div>
  );
}
