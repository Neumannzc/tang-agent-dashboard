// 侧边栏：项目（workspace）树 + 项目下嵌套会话行 + 新建/导入/账户区
// 仅激活 workspace 展开嵌套（NewSessionRow + SessionRow 列表）

import { useState } from "react";
import type { SessionSummary } from "@agent-console/protocol";
import type { Workspace } from "../state.js";
import { SessionRow } from "./SessionRow.js";
import { NewSessionRow } from "./NewSessionRow.js";

function FolderIcon() {
  return (
    <svg className="icon ficon" viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function projectName(cwd: string): string {
  if (cwd === "(未归组)") {
    return cwd;
  }
  const trimmed = cwd.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

export function Sidebar(props: {
  workspaces: Workspace[];
  sessions: SessionSummary[];
  runningBySession: Record<string, boolean>;
  activeCwd: string;
  activeSessionId: string | null;
  draftingCwd: string | null;
  connected: boolean;
  error: string | null;
  onCreateWorkspace: () => void;
  onSwitchWorkspace: (cwd: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: (cwd: string) => void;
  onImport: () => void;
}) {
  const {
    workspaces,
    sessions,
    runningBySession,
    activeCwd,
    activeSessionId,
    draftingCwd,
    connected,
    error,
    onCreateWorkspace,
    onSwitchWorkspace,
    onSwitchSession,
    onCloseSession,
    onNewSession,
    onImport,
  } = props;
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? workspaces.filter((w) => w.cwd.includes(query.trim()) || projectName(w.cwd).includes(query.trim()))
    : workspaces;

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <button className="btn-new" onClick={onCreateWorkspace}>
          <svg className="icon" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New workspace
        </button>
        <div className="search-wrap">
          <SearchIcon />
          <input
            className="search"
            type="text"
            placeholder="搜索项目…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="sb-scroll">
        <div className="sec">项目</div>
        {filtered.length === 0 ? <div className="sec" style={{ paddingTop: 8 }}>暂无项目</div> : null}
        {filtered.map((w) => {
          const isActive = w.cwd === activeCwd;
          return (
            <div key={w.cwd} className="ws-block">
              <button
                className={`ws-item ${isActive ? "active" : ""}`}
                onClick={() => onSwitchWorkspace(w.cwd)}
              >
                <div className="row">
                  <FolderIcon />
                  <span className="name">{projectName(w.cwd)}</span>
                  <span className="count">{w.sessionIds.length ? `${w.sessionIds.length} 会话` : "空"}</span>
                </div>
                <div className="path">{w.cwd}</div>
              </button>
              {isActive ? (
                <div className="ws-sessions">
                  <NewSessionRow
                    workspaceName={projectName(w.cwd)}
                    active={draftingCwd === w.cwd}
                    onNew={() => onNewSession(w.cwd)}
                  />
                  {w.sessionIds.map((id) => {
                    const session = sessions.find((s) => s.sessionId === id);
                    if (!session) {
                      return null;
                    }
                    return (
                      <SessionRow
                        key={id}
                        session={session}
                        active={activeSessionId === id}
                        running={Boolean(runningBySession[id])}
                        onSwitch={onSwitchSession}
                        onClose={onCloseSession}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <div className="msg-error" style={{ margin: "0 10px 8px", fontSize: 12 }}>
          {error}
        </div>
      ) : null}
      <button className="btn-import" onClick={onImport} title="扫描 agent 本地历史会话并导入（二期）">
        <ImportIcon />
        导入历史会话
      </button>
      <div className="sb-foot">
        <div className="avatar">棠</div>
        <div className="foot-meta">
          <div className="foot-name">tang</div>
          <div className="foot-sub">
            <span className={`dot ${connected ? "" : "bad"}`} />
            {connected ? "daemon 已连接" : "daemon 未连接"}
          </div>
        </div>
        <button className="btn btn-ghost" style={{ padding: 5 }} title="设置（二期）">
          <GearIcon />
        </button>
      </div>
    </aside>
  );
}
