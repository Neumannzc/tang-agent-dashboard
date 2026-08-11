// Tang Agent Dashboard 主界面：workspace（项目）→ 会话 两级组织
// 设计：DESIGN.md v2（方案 A：Composer 工具条集中控制 + 单 sidebar 树 + popover 化）

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMode, AgentModelDefinition, AgentPermissionRequest, AgentProvider, SessionSummary } from "@agent-console/protocol";
import { DaemonClient, resolveDaemonWsUrl } from "./ws.js";
import { applyEvent, buildWorkspaces, sessionCwd, UNGROUPED } from "./state.js";
import type { ThreadItem } from "./state.js";
import { applyTheme, loadThemeMode, SYSTEM_THEME_ID } from "./theme.js";
import { Sidebar } from "./components/Sidebar.js";
import { Topbar } from "./components/Topbar.js";
import { Timeline } from "./components/Timeline.js";
import { Composer } from "./components/Composer.js";
import { NewWorkspaceModal, ImportModal } from "./components/Modals.js";
import { SettingsModal } from "./components/SettingsModal.js";

const KNOWN_CWDS_KEY = "tang-ai-chat:knownCwds";
const ACTIVE_KEY = "tang-ai-chat:active";

/** draft 会话 stub：未建会话前的临时 SessionSummary（sessionId 固定 "draft"） */
const DRAFT_SESSION_ID = "draft";

function loadKnownCwds(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_CWDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

interface DraftState {
  cwd: string;
  provider: AgentProvider;
  model: string | null;
  thinkingOptionId: string | null;
  modeId: string | null;
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
  const [modal, setModal] = useState<null | "workspace" | "import" | "settings">(null);
  const [models, setModels] = useState<AgentModelDefinition[]>([]);
  const [modesBySession, setModesBySession] = useState<Record<string, AgentMode[]>>({});
  const [currentModeIdBySession, setCurrentModeIdBySession] = useState<Record<string, string | null>>({});
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const clientRef = useRef(client);
  clientRef.current = client;
  const timelinesRef = useRef<Record<string, ThreadItem[]>>({});
  const sessionsRef = useRef<SessionSummary[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeWorkspaceRef = useRef<string | null>(null);
  const draftRef = useRef<DraftState | null>(null);
  const modesCacheRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    timelinesRef.current = timelines;
  }, [timelines]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // 启动时应用持久化主题（默认 system，跟随 OS）
  useEffect(() => {
    applyTheme(loadThemeMode());
  }, []);

  // system 模式下监听 OS 外观变化实时切换
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (loadThemeMode() === SYSTEM_THEME_ID) {
        applyTheme(SYSTEM_THEME_ID);
      }
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

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
          const event = push.event;
          // daemon 补发 mode_changed 时同步（§6 已知缺口，UI 已用乐观更新兜底）
          if (event.type === "mode_changed") {
            setCurrentModeIdBySession((m) => ({ ...m, [push.sessionId]: event.currentModeId }));
            setModesBySession((m) => ({ ...m, [push.sessionId]: event.availableModes }));
          }
          const result = applyEvent(timelinesRef.current[push.sessionId] ?? [], event);
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
    if (draft) {
      return null;
    }
    if (activeWorkspace && activeWorkspace.sessionIds.includes(activeSessionId ?? "")) {
      return activeSessionId;
    }
    return activeWorkspace?.sessionIds[0] ?? null;
  }, [activeWorkspace, activeSessionId, draft]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === effectiveSessionId) ?? null,
    [sessions, effectiveSessionId],
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

  // ---------- 模型 / 模式数据（按激活上下文拉取） ----------

  const activeProvider = draft ? draft.provider : (activeSession?.provider ?? null);

  useEffect(() => {
    if (!activeProvider) {
      setModels([]);
      return;
    }
    // 切 provider（draft 换 agent / 切换不同 provider 的会话）时先清空旧列表：
    // 新 provider 的模型加载期间（claude 最长 20s）不能残留上一个 agent 的模型
    setModels([]);
    let cancelled = false;
    clientRef.current
      .models(activeProvider)
      .then((list) => {
        if (!cancelled) {
          setModels(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProvider]);

  useEffect(() => {
    const id = effectiveSessionId;
    if (!id || modesCacheRef.current[id]) {
      return;
    }
    modesCacheRef.current = { ...modesCacheRef.current, [id]: true };
    let cancelled = false;
    clientRef.current
      .modes(id)
      .then((list) => {
        if (!cancelled) {
          setModesBySession((m) => ({ ...m, [id]: list }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModesBySession((m) => ({ ...m, [id]: [] }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveSessionId]);

  const activeModes = effectiveSessionId ? (modesBySession[effectiveSessionId] ?? []) : [];
  const effectiveModeId = effectiveSessionId
    ? (currentModeIdBySession[effectiveSessionId] ?? activeSession?.modeId ?? null)
    : null;

  // draft 会话 stub：让 ModelPopover / ThinkingPopover 在未建会话前可配置
  const draftSession = useMemo<SessionSummary | null>(() => {
    if (!draft) {
      return null;
    }
    return {
      sessionId: DRAFT_SESSION_ID,
      provider: draft.provider,
      cwd: draft.cwd,
      model: draft.model ?? undefined,
      thinkingOptionId: draft.thinkingOptionId ?? undefined,
      modeId: draft.modeId ?? undefined,
      createdAt: Date.now(),
      active: false,
    };
  }, [draft]);

  // ---------- 动作 ----------

  const addKnownCwd = useCallback((cwd: string) => {
    setKnownCwds((list) => {
      const next = list.includes(cwd) ? list : [...list, cwd];
      localStorage.setItem(KNOWN_CWDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** 导入历史会话完成后：补 workspace + 刷新会话列表 */
  const handleImported = useCallback(
    async (imported: SessionSummary[]) => {
      for (const cwd of new Set(imported.map((s) => s.cwd).filter((c): c is string => Boolean(c)))) {
        addKnownCwd(cwd);
      }
      try {
        setSessions(await clientRef.current.sessionsList());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [addKnownCwd],
  );

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

  /** 删除项目：移除 knownCwds + 本地会话列表，再通知 daemon 关闭子进程并删 store 行 */
  const handleDeleteProject = useCallback(async (cwd: string | null) => {
    const key = cwd ?? UNGROUPED;
    setKnownCwds((list) => {
      const next = list.filter((c) => c !== cwd);
      localStorage.setItem(KNOWN_CWDS_KEY, JSON.stringify(next));
      return next;
    });
    setSessions((list) =>
      list.filter((s) => (s.cwd?.trim() || UNGROUPED) !== key),
    );
    if (activeWorkspaceRef.current === key) {
      setActiveCwd(null);
      setActiveSessionId(null);
      setDraft(null);
    }
    try {
      await clientRef.current.deleteProject(cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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

  /** draft 首条消息：先建会话，再追加用户消息 + prompt */
  const handleDraftSend = useCallback(
    (text: string) => {
      const d = draftRef.current;
      if (!d || !text.trim()) {
        return;
      }
      const client = clientRef.current;
      client
        .createSession({
          provider: d.provider,
          cwd: d.cwd,
          ...(d.model ? { model: d.model } : {}),
          ...(d.thinkingOptionId ? { thinkingOptionId: d.thinkingOptionId } : {}),
          ...(d.modeId ? { modeId: d.modeId } : {}),
        })
        .then((session) => {
          handleCreated(session);
          setDraft(null);
          const list = timelinesRef.current[session.sessionId] ?? [];
          const next = [
            ...list,
            {
              type: "user_message" as const,
              text,
              key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            },
          ];
          timelinesRef.current = { ...timelinesRef.current, [session.sessionId]: next };
          setTimelines(timelinesRef.current);
          client.prompt(session.sessionId, text).catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [handleCreated],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (draftRef.current) {
        handleDraftSend(text);
      } else {
        handleUserMessage(text);
      }
    },
    [handleDraftSend, handleUserMessage],
  );

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
      setDraft(null);
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

  /** NewSessionRow → 进入 draft（再次点击同 workspace 取消） */
  const handleNewSessionDraft = useCallback(
    (cwd: string) => {
      if (!cwd) {
        return;
      }
      setActiveCwd(cwd);
      setActiveSessionId(null);
      setDraft((d) =>
        d && d.cwd === cwd
          ? null
          : { cwd, provider: (providers[0] ?? "pi") as AgentProvider, model: null, thinkingOptionId: null, modeId: null },
      );
      setFocusSignal((n) => n + 1);
    },
    [providers],
  );

  // ---------- 工具条 pick 回调（draft 写本地配置；会话走 RPC） ----------

  const handlePickModel = useCallback((modelId: string, defaultThinkingOptionId?: string) => {
    if (draftRef.current) {
      setDraft((d) => (d ? { ...d, model: modelId, thinkingOptionId: defaultThinkingOptionId ?? null } : d));
      return;
    }
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    // 本地乐观更新 + 真实下发 daemon（agent.model.set）
    setSessions((list) =>
      list.map((s) => (s.sessionId === sessionId ? { ...s, model: modelId } : s)),
    );
    clientRef.current.setModel(sessionId, modelId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    // 切模型后强度重置为新模型默认档（当前档位对新模型可能无效）
    if (defaultThinkingOptionId !== undefined) {
      setSessions((list) =>
        list.map((s) =>
          s.sessionId === sessionId ? { ...s, thinkingOptionId: defaultThinkingOptionId } : s,
        ),
      );
      clientRef.current.setThinkingOption(sessionId, defaultThinkingOptionId).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    }
  }, []);

  const handlePickThinking = useCallback((thinkingOptionId: string | null) => {
    if (draftRef.current) {
      setDraft((d) => (d ? { ...d, thinkingOptionId } : d));
      return;
    }
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    setSessions((list) =>
      list.map((s) =>
        s.sessionId === sessionId
          ? { ...s, thinkingOptionId: thinkingOptionId ?? undefined }
          : s,
      ),
    );
    clientRef.current.setThinkingOption(sessionId, thinkingOptionId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const handlePickMode = useCallback((modeId: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    // 乐观更新：daemon 未实现 agent.mode.set（HANDOFF §6），失败静默，chip 保留本地状态
    setCurrentModeIdBySession((m) => ({ ...m, [sessionId]: modeId }));
    clientRef.current.setMode(sessionId, modeId).catch(() => {
      // 静默：见 docs/UI-REDESIGN-HANDOFF.md §6
    });
  }, []);

  /** draft 模式切 agent：provider 专属的 model/thinking/mode 一并重置 */
  const handlePickProvider = useCallback((provider: string) => {
    if (!draftRef.current) {
      return;
    }
    // 同步清空模型列表：避免旧 agent 的模型在新列表加载完成前残留
    setModels([]);
    setDraft((d) =>
      d
        ? {
            ...d,
            provider: provider as AgentProvider,
            model: null,
            thinkingOptionId: null,
            modeId: null,
          }
        : d,
    );
  }, []);

  // ---------- 渲染 ----------

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        runningBySession={running}
        activeCwd={activeWorkspace?.cwd ?? ""}
        activeSessionId={effectiveSessionId}
        draftingCwd={draft?.cwd ?? null}
        connected={connected}
        error={error}
        onCreateWorkspace={() => setModal("workspace")}
        onSwitchWorkspace={(cwd) => {
          setActiveCwd(cwd);
          setActiveSessionId(null);
          setDraft(null);
        }}
        onSwitchSession={(id) => void handleSwitchSession(id)}
        onCloseSession={(id) => void handleCloseSession(id)}
        onDeleteProject={(cwd) => void handleDeleteProject(cwd)}
        onNewSession={handleNewSessionDraft}
        onImport={() => setModal("import")}
        onOpenSettings={() => setModal("settings")}
      />
      <main className="main">
        <Topbar session={activeSession} cwd={activeWorkspace?.cwd ?? ""} />
        {activeSession || draft ? (
          <Timeline
            items={timeline}
            provider={activeSession?.provider ?? draft?.provider ?? "pi"}
            running={isRunning}
            onRespondPermission={handleRespondPermission}
          />
        ) : (
          <EmptyProject
            cwd={activeWorkspace?.cwd ?? ""}
            hasAny={workspaces.length > 0}
            onNewSession={() => handleNewSessionDraft(activeWorkspace?.cwd ?? "")}
            onNewWorkspace={() => setModal("workspace")}
            onImport={() => setModal("import")}
          />
        )}
        <Composer
          session={draft ? draftSession : activeSession}
          running={isRunning}
          drafting={Boolean(draft)}
          providers={providers}
          models={models}
          modes={activeModes}
          currentModeId={effectiveModeId}
          defaultModeId={null}
          focusSignal={focusSignal}
          onPickProvider={handlePickProvider}
          onPickModel={handlePickModel}
          onPickMode={handlePickMode}
          onPickThinking={handlePickThinking}
          onSend={handleSend}
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
      {modal === "import" ? (
        <ImportModal
          providers={providers}
          client={clientRef.current}
          onClose={() => setModal(null)}
          onImported={(imported) => void handleImported(imported)}
        />
      ) : null}
      {modal === "settings" ? (
        <SettingsModal onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}

// ---------- 空项目 / 欢迎页 ----------

function EmptyProject(props: { cwd: string; hasAny: boolean; onNewSession: () => void; onNewWorkspace: () => void; onImport: () => void }) {
  const { cwd, hasAny, onNewSession, onNewWorkspace, onImport } = props;
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
                <button className="btn" onClick={onImport}>
                  导入历史会话
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
