// 模态：新建 workspace / 新建会话 / 导入历史会话（二期占位）

import { useEffect, useState } from "react";
import type { AgentProvider } from "@agent-console/protocol";
import type { DaemonClient } from "../ws.js";
import { PROVIDER_META, providerMeta } from "../theme.js";

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
              <button className="btn" onClick={() => alert("桌面端：系统目录选择器（preload IPC，M3）")}>
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

// ---------- 新建会话（当前项目下） ----------

export function NewSessionModal(props: {
  providers: string[];
  cwd: string;
  client: DaemonClient;
  onClose: () => void;
  onConfirm: (provider: AgentProvider, model: string | null) => void;
}) {
  const { providers, cwd, client, onClose, onConfirm } = props;
  const [provider, setProvider] = useState<AgentProvider>("pi");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");

  useEffect(() => {
    setModels([]);
    setModel("");
    client
      .models(provider)
      .then((list) => setModels(list.map((m) => m.id)))
      .catch(() => setModels([]));
  }, [provider, client]);

  const confirm = () => {
    if (!providers.includes(provider)) {
      return;
    }
    onConfirm(provider, model.trim() || null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          在「{cwdName(cwd)}」下新建会话
          <CloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">Agent</span>
            <ProviderCards providers={providers} selected={provider} onPick={(id) => setProvider(id as AgentProvider)} />
          </div>
          <div className="field">
            <span className="field-label">模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">默认</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="modal-hint">
          会话将挂载到当前 workspace：
          <span style={{ fontFamily: "var(--mono)" }}>{cwd}</span>
        </div>
        <div className="modal-foot">
          <button className="btn btn-danger" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={confirm}>
            创建会话
          </button>
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

// ---------- 导入历史会话（UI 定稿；扫描数据源二期实现） ----------

export function ImportModal(props: { providers: string[]; onClose: () => void }) {
  const { providers, onClose } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "done">("idle");

  const toggle = (p: string) => {
    setSelected((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
    setPhase("idle");
  };

  const scan = () => {
    if (selected.length === 0) {
      return;
    }
    setPhase("scanning");
    window.setTimeout(() => setPhase("done"), 900);
  };

  const names = selected.map((p) => providerMeta(p).name).join("、");

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
            <button className="btn" onClick={scan} disabled={selected.length === 0 || phase === "scanning"}>
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
              ) : phase === "done" ? (
                "扫描完成"
              ) : (
                ""
              )}
            </span>
          </div>
          <div className="imp-toolbar">
            <span className="field-label" style={{ margin: 0 }}>
              扫描结果
            </span>
            <button
              className="btn"
              style={{ padding: "3px 9px", fontSize: 11.5 }}
              onClick={() => setPhase("idle")}
              disabled={phase !== "done"}
            >
              重新扫描
            </button>
          </div>
          <div className="imp-list" style={{ padding: "14px 16px", color: "var(--text-faint)", fontSize: 12.5 }}>
            历史会话扫描与导入（按项目目录自动归组）将在二期版本提供。
          </div>
          <div className="modal-hint" style={{ padding: "10px 2px 0" }}>
            导入的会话将按项目目录自动归组到 workspace；目录不存在的会话标记为不可恢复
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-danger" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
