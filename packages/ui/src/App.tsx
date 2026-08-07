// Tang Agent Dashboard 主界面：workspace（项目）→ 会话 两级组织
// 设计：DESIGN-SYSTEM.md v1（唯一真源 design/preview.html）

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPermissionRequest, AgentProvider, SessionSummary } from "@agent-console/protocol";
import { DaemonClient, resolveDaemonWsUrl } from "./ws.js";
import { applyEvent, buildWorkspaces, sessionCwd } from "./state.js";
import type { ThreadItem } from "./state.js";
import { Sidebar } from "./components/Sidebar.js";
import { TabsRow } from "./components/TabsRow.js";
import { Topbar } from "./components/Topbar.js";
import { Timeline } from "./components/Timeline.js";
import { Composer } from "./components/Composer.js";
import { NewWorkspaceModal, NewSessionModal, ImportModal } from "./components/Modals.js";

const KNOWN_CWDS_KEY = "tang-ai-chat:knownCwds";
const ACTIVE_KEY = "tang-ai-chat:active";

function loadKnownCwds(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_CWDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function App() {
  const [client] = useState(() => new DaemonClient());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, ThreadItem[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [knownCwds, setKnownCwds] = useState<string[]>(loadKnownCwds);
  const [modal, setModal] = useState<null | "workspace" | "session" | "import">(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  const timelinesRef = useRef<Record<string, ThreadItem[]>>({});
  const sessionsRef = useRef<SessionSummary[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    timelinesRef.current = timelines;
  }, [timelines]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // ---------- 连接 daemon（含断线自动重连） ----------

  useEffect(() => {
    const client = clientRef.current;
    let cancelled = false;
    let reconnectTimer: number | undefined;

    const scheduleReconnect = () => {
      if (cancelled) {
        return;
      }
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, 2000);
    };

    const connect = async () => {
      try {
        const url = await resolveDaemonWsUrl();
        await client.connect(url);
        if (cancelled) {
          return;
        }
        setConnected(true);
        setError(null);
        const [providerList, sessionList] = await Promise.all([
          client.providersList(),
          client.sessionsList(),
        ]);
        if (cancelled) {
          return;
        }
        setProviders(providerList);
        setSessions(sessionList);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setConnected(false);
        setError(err instanceof Error ? err.message : String(err));
        scheduleReconnect();
      }
    };

    client.onPush = (push) => {
      switch (push.type) {
        case "agent.event": {
          const result = applyEvent(timelinesRef.current[push.sessionId] ?? [], push.event);
          timelinesRef.current = {
            ...timelinesRef.current,
            [push.sessionId]: result.list,
          };
          setTimelines(timelinesRef.current);
          if (result.running !== undefined) {
            setRunning((r) => ({ ...r, [push.sessionId]: result.running } as Record<string, boolean>));
          }
          break;
        }
        case "agent.closed":
          setRunning((r) => ({ ...r, [push.sessionId]: false }));
          setSessions((list) =>
            list.map((s) => (s.sessionId === push.sessionId ? { ...s, active: false } : s)),
          );
          break;
        default:
          break;
      }
    };

    client.onClose = () => {
      setConnected(false);
      scheduleReconnect();
    };

    // 桌面壳推送的 daemon 异常退出事件：立即断开 + 显示明确恢复提示
    let unsubscribeExit: (() => void) | undefined;
    if (window.tang) {
      unsubscribeExit = window.tang.onDaemonExit((info) => {
        const reason = info.signal ? `signal=${info.signal}` : `code=${info.code}`;
        setConnected(false);
        setError(`daemon 异常退出（${reason}）。请重启桌面应用。`);
      });
    }

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      unsubscribeExit?.();
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 派生状态（workspace 聚合 + 激活项一致性） ----------

  const workspaces = useMemo(() => buildWorkspaces(sessions, knownCwds), [sessions, knownCwds]);

  const activeWorkspace = useMemo(() => {
    if (activeCwd && workspaces.some((w) => w.cwd === activeCwd)) {
      return workspaces.find((w) => w.cwd === activeCwd) ?? null;
    }
    return workspaces[0] ?? null;
  }, [workspaces, activeCwd]);

  const effectiveSessionId = useMemo(() => {
    if (activeWorkspace && activeWorkspace.sessionIds.includes(activeSessionId ?? "")) {
      return activeSessionId;
    }
    return activeWorkspace?.sessionIds[0] ?? null;
  }, [activeWorkspace, activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === effectiveSessionId) ?? null,
    [sessions, effectiveSessionId],
  );

  const activeWorkspaceSessions = useMemo(
    () => (activeWorkspace ? activeWorkspace.sessionIds.map((id) => sessions.find((s) => s.sessionId === id)!).filter(Boolean) : []),
    [activeWorkspace, sessions],
  );

  const timeline = effectiveSessionId ? (timelines[effectiveSessionId] ?? []) : [];
  const isRunning = effectiveSessionId ? Boolean(running[effectiveSessionId]) : false;

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace?.cwd ?? null;
  }, [activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace) {
      localStorage.setItem(ACTIVE_KEY, activeWorkspace.cwd);
    }
  }, [activeWorkspace]);

  // ---------- 动作 ----------

  const addKnownCwd = useCallback((cwd: string) => {
    setKnownCwds((list) => {
      const next = list.includes(cwd) ? list : [...list, cwd];
      localStorage.setItem(KNOWN_CWDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handleCreated = useCallback(
    (session: SessionSummary) => {
      setSessions((list) => [session, ...list.filter((s) => s.sessionId !== session.sessionId)]);
      setActiveCwd(sessionCwd(session));
      setActiveSessionId(session.sessionId);
      addKnownCwd(sessionCwd(session));
    },
    [addKnownCwd],
  );

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      setActiveSessionId(sessionId);
      const session = sessionsRef.current.find((s) => s.sessionId === sessionId);
      if (session && !session.active) {
        try {
          const resumed = await clientRef.current.resumeSession(sessionId);
          setSessions((list) =>
            list.map((s) => (s.sessionId === sessionId ? resumed : s)),
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [],
  );

  const handleCloseSession = useCallback(
    async (sessionId: string) => {
      setSessions((list) => list.filter((s) => s.sessionId !== sessionId));
      if (activeSessionIdRef.current === sessionId) {
        setActiveSessionId(null);
      }
      try {
        await clientRef.current.closeSession(sessionId);
      } catch {
        // 本地已移除，忽略 daemon 错误
      }
    },
    [],
  );

  const handleUserMessage = useCallback((text: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    const list = timelinesRef.current[sessionId] ?? [];
    const next = [...list, { type: "user_message" as const, text, key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }];
    timelinesRef.current = { ...timelinesRef.current, [sessionId]: next };
    setTimelines(timelinesRef.current);
    clientRef.current
      .prompt(sessionId, text)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const handleInterrupt = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    clientRef.current.interrupt(sessionId).catch((err) => setError(err.message));
  }, []);

  const handleRespondPermission = useCallback(
    (request: AgentPermissionRequest, behavior: "allow" | "deny", value?: string, interrupt?: boolean) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }
      clientRef.current
        .respondPermission(sessionId, request.id, {
          behavior,
          ...(value !== undefined ? { value } : {}),
          ...(interrupt !== undefined ? { interrupt } : {}),
        })
        .catch(() => {
          // daemon 可能已超时；卡片本地已显示结果
        });
    },
    [],
  );

  const handleCreateWorkspace = useCallback(
    async (cwd: string, provider: AgentProvider | null) => {
      setModal(null);
      addKnownCwd(cwd);
      setActiveCwd(cwd);
      setActiveSessionId(null);
      if (provider) {
        try {
          const session = await clientRef.current.createSession({ provider, cwd });
          handleCreated(session);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [addKnownCwd, handleCreated],
  );

  const handleCreateSession = useCallback(
    async (provider: AgentProvider, model: string | null) => {
      const cwd = activeWorkspaceRef.current;
      if (!cwd) {
        return;
      }
      setModal(null);
      try {
        const session = await clientRef.current.createSession({
          provider,
          cwd,
          ...(model ? { model } : {}),
        });
        handleCreated(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [handleCreated],
  );

  // ---------- 渲染 ----------

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        activeCwd={activeWorkspace?.cwd ?? ""}
        connected={connected}
        error={error}
        onCreateWorkspace={() => setModal("workspace")}
        onSwitchWorkspace={(cwd) => {
          setActiveCwd(cwd);
          setActiveSessionId(null);
        }}
        onImport={() => setModal("import")}
      />
      <main className="main">
        <Topbar
          session={activeSession}
          cwd={activeWorkspace?.cwd ?? ""}
          client={client}
          onPickModel={(model) => {
            const sessionId = activeSessionIdRef.current;
            if (!sessionId) {
              return;
            }
            // 本地乐观更新 + 真实下发 daemon（agent.model.set）
            setSessions((list) =>
              list.map((s) => (s.sessionId === sessionId ? { ...s, model } : s)),
            );
            clientRef.current.setModel(sessionId, model).catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            );
          }}
        />
        <TabsRow
          sessions={activeWorkspaceSessions}
          activeSessionId={effectiveSessionId}
          onSwitch={(id) => void handleSwitchSession(id)}
          onClose={(id) => void handleCloseSession(id)}
          onNew={() => setModal("session")}
        />
        {activeSession ? (
          <Timeline
            items={timeline}
            provider={activeSession.provider}
            running={isRunning}
            onRespondPermission={handleRespondPermission}
          />
        ) : (
          <EmptyProject
            cwd={activeWorkspace?.cwd ?? ""}
            hasAny={workspaces.length > 0}
            onNewSession={() => setModal("session")}
            onNewWorkspace={() => setModal("workspace")}
          />
        )}
        <Composer
          session={activeSession}
          running={isRunning}
          onSend={handleUserMessage}
          onInterrupt={handleInterrupt}
        />
      </main>

      {modal === "workspace" ? (
        <NewWorkspaceModal
          providers={providers}
          onClose={() => setModal(null)}
          onConfirm={(cwd, provider) => void handleCreateWorkspace(cwd, provider)}
        />
      ) : null}
      {modal === "session" ? (
        <NewSessionModal
          providers={providers}
          cwd={activeWorkspace?.cwd ?? ""}
          client={client}
          onClose={() => setModal(null)}
          onConfirm={(provider, model) => void handleCreateSession(provider, model)}
        />
      ) : null}
      {modal === "import" ? (
        <ImportModal providers={providers} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}

// ---------- 空项目 / 欢迎页 ----------

function EmptyProject(props: { cwd: string; hasAny: boolean; onNewSession: () => void; onNewWorkspace: () => void }) {
  const { cwd, hasAny, onNewSession, onNewWorkspace } = props;
  return (
    <div className="thread">
      <div className="thread-inner">
        <div className="empty-project">
          {hasAny ? (
            <>
              <div className="big">{cwdName(cwd)}</div>
              <div className="sub">
                <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{cwd}</span> · 该项目下还没有会话
              </div>
              <div className="actions">
                <button className="btn btn-primary" onClick={onNewSession}>
                  新建会话
                </button>
                <button className="btn" onClick={onNewWorkspace}>
                  新建 workspace
                </button>
              </div>
            </>
          ) : (
            <>
              <img src="/logo.png" alt="" style={{ width: 88, height: 88, borderRadius: 22, margin: "0 auto 18px", display: "block" }} />
              <div className="big">Tang Agent Dashboard</div>
              <div className="sub">统一管理 Pi / Codex / Claude / OpenCode 的项目与会话</div>
              <div className="actions">
                <button className="btn btn-primary" onClick={onNewWorkspace}>
                  新建 workspace
                </button>
                <button className="btn" onClick={onNewSession} disabled>
                  导入历史会话（二期）
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function cwdName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}
