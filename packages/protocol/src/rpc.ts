// WS 协议：客户端 <-> daemon
// 请求-响应（带 id）+ 服务端事件推送

import type { AgentPermissionResponse, AgentPersistenceHandle, AgentProvider, AgentRunResult, AgentStreamEvent } from "./agent-sdk-types.js";

export type ClientRequest =
  | { method: "providers.list" }
  | { method: "agent.create"; params: { provider: AgentProvider; cwd: string; model?: string; modeId?: string; systemPrompt?: string } }
  | { method: "agent.prompt"; params: { sessionId: string; prompt: string } }
  | { method: "agent.interrupt"; params: { sessionId: string } }
  | { method: "agent.close"; params: { sessionId: string } }
  | { method: "agent.modes"; params: { sessionId: string } }
  | { method: "agent.model.set"; params: { sessionId: string; modelId: string } }
  | { method: "agent.permission.respond"; params: { sessionId: string; requestId: string; behavior: "allow" | "deny"; value?: string; interrupt?: boolean } }
  | { method: "agent.models"; params: { provider: AgentProvider } }
  | { method: "sessions.list" }
  | { method: "session.resume"; params: { sessionId: string; cwd?: string } };

export interface ClientResponseOk {
  id: number;
  ok: true;
  result: unknown;
}

export interface ClientResponseError {
  id: number;
  ok: false;
  error: string;
}

export type ClientResponse = ClientResponseOk | ClientResponseError;

export type ServerPush =
  | { type: "session.ready"; sessionId: string; provider: AgentProvider }
  | { type: "agent.event"; sessionId: string; event: AgentStreamEvent }
  | { type: "agent.closed"; sessionId: string };

/** 会话摘要（sessions.list / agent.create 返回值） */
export interface SessionSummary {
  sessionId: string;
  provider: AgentProvider;
  cwd?: string;
  model?: string;
  modeId?: string;
  createdAt: number;
  lastActiveAt?: number;
  active: boolean;
  handle?: AgentPersistenceHandle;
}

export type AgentPromptResult = AgentRunResult;
