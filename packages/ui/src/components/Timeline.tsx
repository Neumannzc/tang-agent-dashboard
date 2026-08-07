// 对话流：消息 / 思考 / 工具卡 / 待办 / 权限卡（timeline 内嵌）

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentPermissionRequest, ToolCallDetail } from "@agent-console/protocol";
import type { ThreadItem } from "../state.js";
import { providerMeta } from "../theme.js";
import { PermissionCard } from "./PermissionCard.js";

function ChevronIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// ---------- 各消息类型 ----------

function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg msg-user">
      <div className="body">{text}</div>
    </div>
  );
}

function AssistantMessage({ provider, text, time }: { provider: string; text: string; time?: string }) {
  const meta = providerMeta(provider);
  return (
    <div className="msg">
      <div className={`logo logo-${provider}`}>{meta.name[0]}</div>
      <div className="body">
        <div className="head">
          <span className="who">{meta.name}</span>
          {time ? <span className="when">{time}</span> : null}
        </div>
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "…"}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <ChevronIcon />
        思考过程
      </button>
      <div className="reasoning-body">{text}</div>
    </div>
  );
}

function ToolCallView({ item }: { item: { name: string; status: string; detail?: ToolCallDetail } }) {
  const running = item.status === "pending" || item.status === "running";
  return (
    <div className="tool">
      <div className="tool-head">
        <span className="name">{item.name}</span>
        <span className="st">
          {running ? (
            <>
              <span className="spinner" />
              <span className="st-run">{item.status}</span>
            </>
          ) : item.status === "failed" ? (
            <span className="st-fail">failed</span>
          ) : (
            <span className="st-ok">done</span>
          )}
        </span>
      </div>
      <ToolDetail detail={item.detail} />
    </div>
  );
}

function ToolDetail({ detail }: { detail?: ToolCallDetail }) {
  const record = (detail ?? {}) as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  let summary = "";
  if (typeof record.command === "string") summary = record.command;
  else if (typeof record.path === "string") summary = record.path;
  else if (typeof record.query === "string") summary = record.query;
  else if (typeof record.url === "string") summary = record.url;
  else if (typeof record.text === "string") summary = record.text;
  if (!summary) {
    return null;
  }
  return (
    <div className="tool-body">
      {kind ? <span style={{ opacity: 0.5 }}>{kind} </span> : null}
      {summary}
    </div>
  );
}

function TodoView({ items }: { items: { text: string; completed: boolean }[] }) {
  return (
    <div className="todo">
      {items.map((t, i) => (
        <div key={i} className={`row ${t.completed ? "done" : ""}`}>
          <span className="chk" />
          <span className="txt">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return <div className="msg-error">{message}</div>;
}

function RunningHint() {
  return (
    <div className="running-hint">
      <span className="spinner" />
      agent 正在运行…
    </div>
  );
}

// ---------- Timeline 主组件 ----------

export function Timeline(props: {
  items: ThreadItem[];
  provider: string;
  running: boolean;
  onRespondPermission: (
    request: AgentPermissionRequest,
    behavior: "allow" | "deny",
    value?: string,
    interrupt?: boolean,
  ) => void;
}) {
  const { items, provider, running, onRespondPermission } = props;
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, running]);

  return (
    <div className="thread">
      <div className="thread-inner">
        {items.map((item) => {
          switch (item.type) {
            case "user_message":
              return <UserMessage key={item.key} text={item.text} />;
            case "assistant_message":
              return <AssistantMessage key={item.key} provider={provider} text={item.text} />;
            case "reasoning":
              return <Reasoning key={item.key} text={item.text} />;
            case "tool_call":
              return <ToolCallView key={item.key} item={item} />;
            case "todo":
              return <TodoView key={item.key} items={item.items} />;
            case "error":
              return <ErrorView key={item.key} message={item.message} />;
            case "permission":
              return (
                <PermissionCard
                  key={item.key}
                  provider={provider}
                  request={item.request}
                  onRespond={onRespondPermission}
                />
              );
            default:
              return null;
          }
        })}
        {running ? <RunningHint /> : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
