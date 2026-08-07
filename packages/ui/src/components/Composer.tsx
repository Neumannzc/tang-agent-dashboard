// Composer：输入 + 发送 / 中断

import { useState } from "react";
import type { SessionSummary } from "@agent-console/protocol";

function SendIcon() {
  return (
    <svg className="icon" style={{ width: 15, height: 15 }} viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon" style={{ width: 14, height: 14 }} viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function Composer(props: {
  session: SessionSummary | null;
  running: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const { session, running, onSend, onInterrupt } = props;
  const [text, setText] = useState("");

  const send = () => {
    if (!session || !text.trim() || running) {
      return;
    }
    onSend(text);
    setText("");
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer">
          <textarea
            rows={1}
            placeholder={session ? "描述你想让 agent 做的事…" : "先新建或选择一个会话"}
            value={text}
            disabled={!session}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-foot">
            <button className="c-icon" title="附件（本期不做）">
              <svg className="icon" viewBox="0 0 24 24">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-faint)", marginRight: 6 }}>Ctrl+Enter 发送</span>
            {running ? (
              <button className="send" title="中断" onClick={onInterrupt} style={{ background: "var(--card)", color: "var(--text-dim)" }}>
                <StopIcon />
              </button>
            ) : (
              <button className="send" title="发送" onClick={send} disabled={!session || !text.trim()}>
                <SendIcon />
              </button>
            )}
          </div>
        </div>
        <div className="hint" id="statusHint" />
      </div>
    </div>
  );
}
