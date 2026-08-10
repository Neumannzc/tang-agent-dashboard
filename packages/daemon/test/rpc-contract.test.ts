import assert from "node:assert/strict";
import test from "node:test";
import { parseClientRequest } from "@agent-console/protocol";

function assertAccepted(raw: unknown): void {
  const result = parseClientRequest(raw);
  assert.equal(result.ok, true);
}

function assertRejected(raw: unknown, code: string): void {
  const result = parseClientRequest(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, code);
  }
}

test("accepts every RPC method with its required parameter shape", () => {
  // Given: one valid request for every declared ClientRequest variant
  const requests = [
    { id: 1, method: "providers.list" },
    { id: 2, method: "agent.create", params: { provider: "pi", cwd: "/tmp" } },
    { id: 3, method: "agent.prompt", params: { sessionId: "session", prompt: "hello" } },
    { id: 4, method: "agent.interrupt", params: { sessionId: "session" } },
    { id: 5, method: "agent.close", params: { sessionId: "session" } },
    { id: 6, method: "agent.modes", params: { sessionId: "session" } },
    { id: 7, method: "agent.mode.set", params: { sessionId: "session", modeId: "mode" } },
    { id: 8, method: "agent.model.set", params: { sessionId: "session", modelId: "model" } },
    { id: 9, method: "agent.thinking.set", params: { sessionId: "session", thinkingOptionId: null } },
    { id: 10, method: "agent.permission.respond", params: { sessionId: "session", requestId: "request", behavior: "allow" } },
    { id: 11, method: "agent.models", params: { provider: "codex" } },
    { id: 12, method: "sessions.list", params: {} },
    { id: 13, method: "session.resume", params: { sessionId: "session" } },
    { id: 14, method: "sessions.scanHistory", params: { providers: ["pi", "codex"] } },
    { id: 15, method: "sessions.importHistory", params: { providers: ["opencode", "claude"] } },
  ];

  // When / Then: every valid wire shape is accepted
  for (const request of requests) {
    assertAccepted(request);
  }
});

test("rejects malformed RPC request ids and unknown methods with distinct codes", () => {
  // Given / When / Then: identity and routing failures remain distinguishable
  assertRejected({ id: Number.NaN, method: "providers.list" }, "INVALID_REQUEST");
  assertRejected({ id: Infinity, method: "providers.list" }, "INVALID_REQUEST");
  assertRejected({ id: "1", method: "providers.list" }, "INVALID_REQUEST");
  assertRejected({ id: 1, method: "does.not.exist" }, "UNKNOWN_METHOD");
});

test("rejects malformed RPC params while allowing optional fields and unknown top-level keys", () => {
  // Given / When / Then: params are validated per method without rejecting protocol extensions
  assertRejected({ id: 1, method: "agent.prompt" }, "INVALID_PARAMS");
  assertRejected({ id: 1, method: "agent.prompt", params: { sessionId: "session", prompt: 1 } }, "INVALID_PARAMS");
  assertRejected({ id: 1, method: "agent.thinking.set", params: { sessionId: "session", thinkingOptionId: 5 } }, "INVALID_PARAMS");
  assertRejected({ id: 1, method: "agent.permission.respond", params: { sessionId: "session", requestId: "request", behavior: "maybe" } }, "INVALID_PARAMS");
  assertRejected({ id: 1, method: "sessions.scanHistory", params: { providers: ["pi", "nope"] } }, "INVALID_PARAMS");
  assertRejected({ id: 1, method: "agent.create", params: { provider: "pi", cwd: 42 } }, "INVALID_PARAMS");
  assertAccepted({ id: 1, method: "agent.permission.respond", params: { sessionId: "session", requestId: "request", behavior: "deny", value: "reason", interrupt: false } });
  assertAccepted({ id: 1, method: "session.resume", params: { sessionId: "session" }, extension: true });
});
