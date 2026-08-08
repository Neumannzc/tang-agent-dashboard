// 模态：新建 workspace / 导入历史会话
// "新建会话" 已改 inline draft（NewSessionRow → Composer），不再走 Modal

import { useMemo, useState } from "react";
import type { AgentProvider, HistorySession, SessionSummary } from "@agent-console/protocol";
import { PROVIDER_META, providerMeta } from "../theme.js";
import type { DaemonClient } from "../ws.js";

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button className="btn btn-ghost" style={{ padding: 4 }} onClick={onClose}>
      ✕
    </button>
  );
}

function ProviderCards(props: {
  providers: string[];
  selected: string | null;
  onPick: (id: string) => void;
  multi?: boolean;
}) {
  const { providers, selected, onPick, multi } = props;
  return (
    <div className="provider-grid">
      {providers.map((p) => {
        const meta = PROVIDER_META[p] ?? { name: p, color: "#6e6e6e", sub: "" };
        const active = multi ? (selected ?? "").split(",").includes(p) : selected === p;
        return (
          <button
            key={p}
            className={`p-card ${active ? "active" : ""}`}
            onClick={() => onPick(p)}
            type="button"
          >
            <div className="p-logo" style={{ background: meta.color }}>
              {meta.name[0]}
            </div>
            <div>
              <div className="p-name">{meta.name}</div>
              <div className="p-sub">{meta.sub}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------- 新建 workspace ----------

export function NewWorkspaceModal(props: {
  providers: string[];
  onClose: () => void;
  onConfirm: (cwd: string, provider: AgentProvider | null) => void;
}) {
  const { providers, onClose, onConfirm } = props;
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<AgentProvider | null>(null);

  const confirm = () => {
    if (!cwd.trim()) {
      return;
    }
    onConfirm(cwd.trim(), provider);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          新建 workspace
          <CloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">项目目录</span>
            <div className="dir-row">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/home/tang/projects/my-project"
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
              <button
                className="btn"
                onClick={async () => {
                  if (window.tang) {
                    try {
                      const picked = await window.tang.openDirectory();
                      if (picked) {
                        setCwd(picked);
                      }
                    } catch (error) {
                      // 降级为提示，不阻止用户手输
                      console.warn("[ui] openDirectory 失败:", error);
                    }
                  }
                }}
              >
                浏览…
              </button>
            </div>
          </div>
          <div className="field">
            <span className="field-label">初始 agent（可选，也可稍后在项目内新建会话）</span>
            <ProviderCards providers={providers} selected={provider} onPick={(id) => setProvider(id as AgentProvider)} />
          </div>
        </div>
        <div className="modal-hint">workspace = 一个本地项目目录；会话挂在其下</div>
        <div className="modal-foot">
          <button className="btn btn-danger" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!cwd.trim()} onClick={confirm}>
            创建并打开
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 导入历史会话 ----------

const UNGROUPED = "(未归组)";
/** 预览列表单组最多渲染行数（其余仍会导入，仅显示省略提示） */
const PREVIEW_ROW_CAP = 300;

function formatImportTime(ts: number): string {
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

export function ImportModal(props: {
  providers: string[];
  client: DaemonClient;
  onClose: () => void;
  onImported: (imported: SessionSummary[]) => void;
}) {
  const { providers, client, onClose, onImported } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "preview" | "importing" | "done">("idle");
  const [results, setResults] = useState<HistorySession[] | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const toggle = (p: string) => {
    setSelected((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
    setPhase("idle");
    setResults(null);
    setError(null);
  };

  const scan = async () => {
    if (selected.length === 0) {
      return;
    }
    setPhase("scanning");
    setError(null);
    try {
      const sessions = await client.scanHistory(selected as AgentProvider[]);
      setResults(sessions);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const doImport = async () => {
    if (selected.length === 0) {
      return;
    }
    setPhase("importing");
    setError(null);
    try {
      const res = await client.importHistory(selected as AgentProvider[]);
      setImportedCount(res.imported.length);
      setSkipped(res.skipped);
      setPhase("done");
      onImported(res.imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("preview");
    }
  };

  const names = selected.map((p) => providerMeta(p).name).join("、");

  // 按项目目录归组预览
  const groups = useMemo(() => {
    if (!results) {
      return [];
    }
    const map = new Map<string, HistorySession[]>();
    for (const session of results) {
      const cwd = session.cwd?.trim() || UNGROUPED;
      const list = map.get(cwd);
      if (list) {
        list.push(session);
      } else {
        map.set(cwd, [session]);
      }
    }
    return [...map.entries()];
  }, [results]);

  const freshCount = results ? results.filter((r) => !r.imported).length : 0;
  const existingCount = results ? results.length - freshCount : 0;
  const goneCount = results ? results.filter((r) => !r.recoverable).length : 0;
  const totalRows = results?.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          导入历史会话
          <CloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">选择 Agent（可多选）</span>
            <ProviderCards providers={providers} selected={selected.join(",")} onPick={toggle} multi />
          </div>
          <div className="scan-row">
            <button
              className="btn"
              onClick={() => void scan()}
              disabled={selected.length === 0 || phase === "scanning" || phase === "importing"}
            >
              <svg className="icon" style={{ width: 13, height: 13 }} viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              扫描历史会话
            </button>
            <span className="scan-status">
              {phase === "scanning" ? (
                <>
                  <span className="spinner" />
                  正在扫描 {names} 的本地会话存储…
                </>
              ) : phase === "importing" ? (
                <>
                  <span className="spinner" />
                  正在导入…
                </>
              ) : phase === "done" ? (
                `已导入 ${importedCount} 个，跳过 ${skipped} 个（已存在）`
              ) : (
                ""
              )}
            </span>
          </div>
          {error ? (
            <div className="msg-error" style={{ margin: "0 0 10px", fontSize: 12 }}>
              {error}
            </div>
          ) : null}
          <div className="imp-toolbar">
            <span className="field-label" style={{ margin: 0 }}>
              扫描结果
              {results ? `（共 ${totalRows} 条）` : ""}
            </span>
            <button
              className="btn"
              style={{ padding: "3px 9px", fontSize: 11.5 }}
              onClick={() => void scan()}
              disabled={selected.length === 0 || phase === "scanning" || phase === "importing"}
            >
              重新扫描
            </button>
          </div>
          <div className="imp-list">
            {phase === "preview" && results && results.length === 0 ? (
              <div style={{ padding: "14px 16px", color: "var(--text-faint)", fontSize: 12.5 }}>
                未发现可导入的历史会话。
              </div>
            ) : phase === "preview" && groups.length > 0 ? (
              groups.map(([cwd, sessions]) => (
                <div key={cwd}>
                  <div
                    className="i-cwd"
                    style={{ padding: "7px 12px 3px", fontWeight: 600, color: "var(--text-dim)" }}
                  >
                    {cwd} · {sessions.length} 条
                  </div>
                  {sessions.slice(0, PREVIEW_ROW_CAP).map((session) => {
                    const meta = providerMeta(session.provider);
                    return (
                      <div key={session.id} className="imp-row">
                        <span className="dotp" style={{ background: meta.color }} />
                        <div className="i-main">
                          <div className="i-title">{session.title ?? session.cwd ?? session.id}</div>
                          <div className="i-cwd">{session.cwd ?? UNGROUPED}</div>
                        </div>
                        <div className="i-meta">
                          <span className="i-time">
                            {formatImportTime(session.lastActiveAt ?? session.createdAt)}
                          </span>
                          {session.imported ? <span className="i-badge gone">已导入</span> : null}
                          {!session.recoverable ? <span className="i-badge gone">不可恢复</span> : null}
                        </div>
                      </div>
                    );
                  })}
                  {sessions.length > PREVIEW_ROW_CAP ? (
                    <div style={{ padding: "6px 12px", color: "var(--text-faint)", fontSize: 11.5 }}>
                      … 其余 {sessions.length - PREVIEW_ROW_CAP} 条省略（仍会导入）
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div style={{ padding: "14px 16px", color: "var(--text-faint)", fontSize: 12.5 }}>
                选择 Agent 后点击「扫描历史会话」。
              </div>
            )}
          </div>
          <div className="modal-hint" style={{ padding: "10px 2px 0", display: "flex", justifyContent: "space-between" }}>
            <span>导入的会话将按项目目录自动归组到 workspace；目录不存在的会话标记为不可恢复</span>
            {phase === "preview" && results ? (
              <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>
                新导入 {freshCount} · 已存在 {existingCount} · 不可恢复 {goneCount}
              </span>
            ) : null}
          </div>
        </div>
        <div className="modal-foot">
          {phase === "preview" ? (
            <>
              <button className="btn btn-danger" onClick={onClose}>
                关闭
              </button>
              <button
                className="btn btn-primary"
                disabled={freshCount === 0}
                onClick={() => void doImport()}
              >
                导入全部（{freshCount} 个）
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onClose}>
              {phase === "done" ? "完成" : "关闭"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
