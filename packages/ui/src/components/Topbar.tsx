// 顶部栏：provider 胶囊 + 会话标题 + 路径 + 模型选择 + 更多

import { useEffect, useState } from "react";
import type { SessionSummary } from "@agent-console/protocol";
import type { DaemonClient } from "../ws.js";
import { providerMeta } from "../theme.js";

function ChevronIcon() {
  return (
    <svg className="icon" style={{ width: 12, height: 12 }} viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function Topbar(props: {
  session: SessionSummary | null;
  cwd: string;
  client: DaemonClient;
  onPickModel: (model: string) => void;
}) {
  const { session, cwd, client, onPickModel } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    setMenuOpen(false);
    setModels([]);
    if (!session) {
      return;
    }
    client
      .models(session.provider)
      .then((list) => setModels(list.map((m) => m.id)))
      .catch(() => setModels([]));
  }, [session?.sessionId, client, session]);

  const meta = session ? providerMeta(session.provider) : null;

  return (
    <div className="topbar">
      {meta ? (
        <span className="prov-badge">
          <span className="dotp" style={{ background: meta.color }} />
          {meta.name}
        </span>
      ) : null}
      <div style={{ minWidth: 0 }}>
        <div className="tt">{session ? sessionTitle(session) : cwdName(cwd)}</div>
        <div className="ts">{cwd}</div>
      </div>
      <div className="grow" />
      {session ? (
        <div style={{ position: "relative" }}>
          <button className="btn" onClick={() => setMenuOpen((v) => !v)}>
            <span>{session.model ?? "默认模型"}</span>
            <ChevronIcon />
          </button>
          {menuOpen ? (
            <div
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 6px)",
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 4,
                minWidth: 200,
                boxShadow: "0 12px 32px rgba(0,0,0,.5)",
                zIndex: 50,
              }}
            >
              {models.length === 0 ? (
                <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--text-faint)" }}>暂无可选模型</div>
              ) : (
                models.map((m) => (
                  <button
                    key={m}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "5px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: m === session.model ? "var(--accent-soft)" : "transparent",
                      color: m === session.model ? "var(--accent-hover)" : "var(--text)",
                      fontSize: 12.5,
                      cursor: "pointer",
                      fontFamily: "var(--sans)",
                    }}
                    onClick={() => {
                      onPickModel(m);
                      setMenuOpen(false);
                    }}
                  >
                    {m}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <button className="btn btn-ghost" title="更多（二期）">
        <svg className="icon" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </div>
  );
}

function cwdName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function sessionTitle(session: SessionSummary): string {
  const label = providerMeta(session.provider).name;
  return session.model ? `${label} · ${session.model}` : `${label} · ${session.sessionId.slice(0, 8)}`;
}
