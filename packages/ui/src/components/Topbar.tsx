// 顶部栏：provider 胶囊 + 会话标题 + 路径 + 占位更多按钮（DESIGN.md §5.5）
// model/thinking dropdown 已迁至 ComposerToolbar（ModelPopover / ThinkingPopover）

import type { SessionSummary } from "@agent-console/protocol";
import { providerMeta } from "../theme.js";

export function Topbar(props: { session: SessionSummary | null; cwd: string }) {
  const { session, cwd } = props;
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
