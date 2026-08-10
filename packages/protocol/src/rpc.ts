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

export type RpcErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INVALID_PARAMS"
  | "UNKNOWN_METHOD"
  | "UNAUTHORIZED"
  | "INTERNAL";

export type ParseClientRequestResult =
  | { ok: true; request: ClientRequest & { id: number } }
  | { ok: false; code: RpcErrorCode; error: string; id?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "pi" || value === "codex" || value === "opencode" || value === "claude";
}

function hasOnlyProperties(params: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(params).every((key) => allowed.includes(key));
}

function optionalStringIsValid(params: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(params, key) || typeof params[key] === "string";
}

function invalidRequest(code: RpcErrorCode, error: string, id?: number): ParseClientRequestResult {
  return id === undefined ? { ok: false, code, error } : { ok: false, code, error, id };
}

function validRequest(request: ClientRequest & { id: number }): ParseClientRequestResult {
  return { ok: true, request };
}

export function parseClientRequest(raw: unknown): ParseClientRequestResult {
  if (!isRecord(raw) || typeof raw["id"] !== "number" || !Number.isFinite(raw["id"]) || typeof raw["method"] !== "string") {
    return invalidRequest("INVALID_REQUEST", "missing or invalid id or method");
  }

  const id = raw["id"];
  const params = raw["params"];
  const invalidParams = (): ParseClientRequestResult => invalidRequest("INVALID_PARAMS", "invalid request params", id);

  switch (raw["method"]) {
    case "providers.list":
    case "sessions.list":
      return params === undefined || (isRecord(params) && Object.keys(params).length === 0)
        ? validRequest({ id, method: raw["method"] })
        : invalidParams();
    case "agent.create": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["provider", "cwd", "model", "modeId", "thinkingOptionId", "systemPrompt"])) return invalidParams();
      const { provider, cwd, model, modeId, thinkingOptionId, systemPrompt } = params;
      if (!isAgentProvider(provider) || typeof cwd !== "string" || !optionalStringIsValid(params, "model") || !optionalStringIsValid(params, "modeId") || !optionalStringIsValid(params, "thinkingOptionId") || !optionalStringIsValid(params, "systemPrompt")) return invalidParams();
      return validRequest({ id, method: "agent.create", params: { provider, cwd, ...(typeof model === "string" ? { model } : {}), ...(typeof modeId === "string" ? { modeId } : {}), ...(typeof thinkingOptionId === "string" ? { thinkingOptionId } : {}), ...(typeof systemPrompt === "string" ? { systemPrompt } : {}) } });
    }
    case "agent.prompt": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "prompt"])) return invalidParams();
      const { sessionId, prompt } = params;
      return typeof sessionId === "string" && typeof prompt === "string" ? validRequest({ id, method: "agent.prompt", params: { sessionId, prompt } }) : invalidParams();
    }
    case "agent.interrupt":
    case "agent.close":
    case "agent.modes": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId"])) return invalidParams();
      const { sessionId } = params;
      return typeof sessionId === "string" ? validRequest({ id, method: raw["method"], params: { sessionId } }) : invalidParams();
    }
    case "agent.mode.set": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "modeId"])) return invalidParams();
      const { sessionId, modeId } = params;
      return typeof sessionId === "string" && typeof modeId === "string" ? validRequest({ id, method: "agent.mode.set", params: { sessionId, modeId } }) : invalidParams();
    }
    case "agent.model.set": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "modelId"])) return invalidParams();
      const { sessionId, modelId } = params;
      return typeof sessionId === "string" && typeof modelId === "string" ? validRequest({ id, method: "agent.model.set", params: { sessionId, modelId } }) : invalidParams();
    }
    case "agent.thinking.set": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "thinkingOptionId"])) return invalidParams();
      const { sessionId, thinkingOptionId } = params;
      return typeof sessionId === "string" && (typeof thinkingOptionId === "string" || thinkingOptionId === null) ? validRequest({ id, method: "agent.thinking.set", params: { sessionId, thinkingOptionId } }) : invalidParams();
    }
    case "agent.permission.respond": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "requestId", "behavior", "value", "interrupt"])) return invalidParams();
      const { sessionId, requestId, behavior, value, interrupt } = params;
      if (typeof sessionId !== "string" || typeof requestId !== "string" || (behavior !== "allow" && behavior !== "deny") || !optionalStringIsValid(params, "value") || (Object.hasOwn(params, "interrupt") && typeof interrupt !== "boolean")) return invalidParams();
      return validRequest({ id, method: "agent.permission.respond", params: { sessionId, requestId, behavior, ...(typeof value === "string" ? { value } : {}), ...(typeof interrupt === "boolean" ? { interrupt } : {}) } });
    }
    case "agent.models": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["provider"])) return invalidParams();
      const { provider } = params;
      return isAgentProvider(provider) ? validRequest({ id, method: "agent.models", params: { provider } }) : invalidParams();
    }
    case "session.resume": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["sessionId", "cwd"])) return invalidParams();
      const { sessionId, cwd } = params;
      return typeof sessionId === "string" && optionalStringIsValid(params, "cwd") ? validRequest({ id, method: "session.resume", params: { sessionId, ...(typeof cwd === "string" ? { cwd } : {}) } }) : invalidParams();
    }
    case "sessions.scanHistory":
    case "sessions.importHistory": {
      if (!isRecord(params) || !hasOnlyProperties(params, ["providers"])) return invalidParams();
      const { providers } = params;
      return Array.isArray(providers) && providers.every(isAgentProvider) ? validRequest({ id, method: raw["method"], params: { providers } }) : invalidParams();
    }
    default:
      return invalidRequest("UNKNOWN_METHOD", "unknown method", id);
  }
}

export interface ClientResponseOk {
  id: number;
  ok: true;
  result: unknown;
}

export interface ClientResponseError {
  id: number;
  ok: false;
  code: RpcErrorCode;
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
