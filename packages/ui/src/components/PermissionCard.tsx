// 权限卡（timeline 内嵌，仿 Codex tool approval）：tool / question 两种形态 + 拒绝并中断

import { useState } from "react";
import type { AgentPermissionRequest } from "@agent-console/protocol";
import { providerMeta } from "../theme.js";

export function PermissionCard(props: {
  provider: string;
  request: AgentPermissionRequest;
  onRespond: (
    request: AgentPermissionRequest,
    behavior: "allow" | "deny",
    value?: string,
    interrupt?: boolean,
  ) => void;
}) {
  const { provider, request, onRespond } = props;
  const [value, setValue] = useState("");
  const [resolved, setResolved] = useState<{ behavior: "allow" | "deny"; interrupt: boolean } | null>(null);
  const meta = providerMeta(provider);

  const respond = (behavior: "allow" | "deny", interrupt?: boolean) => {
    setResolved({ behavior, interrupt: Boolean(interrupt) });
    onRespond(request, behavior, behavior === "allow" && value.trim() ? value : undefined, interrupt);
  };

  if (resolved) {
    const interrupted = resolved.behavior === "deny" && resolved.interrupt;
    return (
      <div className="perm">
        <div className="desc">
          {resolved.behavior === "allow" ? (
            <span className="resolved" style={{ color: "var(--success)" }}>✓ 已允许{request.kind === "question" ? "，已提交回答" : ""}</span>
          ) : (
            <span className="resolved" style={{ color: "var(--danger)" }}>✕ 已拒绝{interrupted ? "，回合已中断" : ""}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="perm">
      <div className="kind">
        {request.kind === "question" ? "question" : `tool · ${request.kind}`}
      </div>
      <div className="desc">{meta.name} 请求{request.kind === "question" ? "回答" : "执行操作"}</div>
      {request.detail ? (
        <div className="detail">
          {request.kind === "question" ? request.description : request.detail}
        </div>
      ) : null}
      {request.kind === "question" ? (
        <textarea
          className="question-input"
          rows={2}
          placeholder="输入回答…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : null}
      <div className="actions">
        <button className="btn btn-danger" onClick={() => respond("deny")}>
          拒绝
        </button>
        <button
          className="btn btn-danger"
          style={{ borderColor: "rgba(224,108,108,.4)", color: "var(--danger)" }}
          onClick={() => respond("deny", true)}
        >
          拒绝并中断
        </button>
        <button className="btn btn-primary" onClick={() => respond("allow")} disabled={request.kind === "question" && !value.trim()}>
          允许
        </button>
      </div>
    </div>
  );
}
