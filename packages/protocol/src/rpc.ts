// WS 协议：客户端 <-> daemon
// 请求-响应（带 id）+ 服务端事件推送

import type { AgentPersistenceHandle, AgentProvider, AgentRunResult, AgentStreamEvent } from "./agent-sdk-types.js";

export type ClientRequest =
  | { method: "providers.list" }
  | { method: "agent.create"; params: { provider: AgentProvider; cwd: string; model?: string; modeId?: string; thinkingOptionId?: string; systemPrompt?: string } }
  | { method: "agent.prompt"; params: { sessionId: string; prompt: string } }
  | { method: "agent.interrupt"; params: { sessionId: string } }
  | { method: "agent.close"; params: { sessionId: string } }
  | { method: "agent.modes"; params: { sessionId: string } }
  | { method: "agent.mode.set"; params: { sessionId: string; modeId: string } }
  | { method: "agent.model.set"; params: { sessionId: string; modelId: string } }
  | { method: "agent.thinking.set"; params: { sessionId: string; thinkingOptionId: string | null } }
  | { method: "agent.permission.respond"; params: { sessionId: string; requestId: string; behavior: "allow" | "deny"; value?: string; interrupt?: boolean } }
  | { method: "agent.models"; params: { provider: AgentProvider } }
  | { method: "sessions.list" }
  | { method: "session.resume"; params: { sessionId: string; cwd?: string } }
  | { method: "sessions.scanHistory"; params: { providers: AgentProvider[] } }
  | { method: "sessions.importHistory"; params: { providers: AgentProvider[] } };

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
  thinkingOptionId?: string;
  /** 会话标题（导入的会话来自 agent 本地历史；本软件创建的会话暂无） */
  title?: string;
  createdAt: number;
  lastActiveAt?: number;
  active: boolean;
  handle?: AgentPersistenceHandle;
}

/**
 * 历史会话（sessions.scanHistory 返回项）：agent 本地存储中的一条会话记录。
 * 只含元数据（标题/项目路径/时间戳），不含会话内容。
 */
export interface HistorySession {
  /** 扫描结果内稳定 key：`${provider}:${handle.nativeHandle}` */
  id: string;
  provider: AgentProvider;
  title?: string;
  cwd?: string;
  model?: string;
  /** agent 逻辑会话 id（claude/codex/opencode 与 handle.nativeHandle 一致；pi 为会话文件 header 的 id） */
  nativeId?: string;
  createdAt: number;
  lastActiveAt?: number;
  /** 是否已在本软件导入过（按 nativeHandle 与 store 比对） */
  imported: boolean;
  /** 项目目录当前是否存在（false 表示可浏览但可能无法恢复） */
  recoverable: boolean;
  handle: AgentPersistenceHandle;
}

export type AgentPromptResult = AgentRunResult;
