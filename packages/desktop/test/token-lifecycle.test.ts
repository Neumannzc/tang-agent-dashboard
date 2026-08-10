import assert from "node:assert/strict";
import test from "node:test";

import { buildChildEnv, buildDesktopConfig, createDaemonToken } from "../src/config.js";
import { appendTokenToWsUrl } from "../../ui/src/ws.js";

test("createDaemonToken creates a distinct 64-character hexadecimal token per launch", () => {
  // Given: two independently started desktop processes
  // When: each creates its daemon token
  const firstToken = createDaemonToken();
  const secondToken = createDaemonToken();

  // Then: both tokens are opaque 32-byte values and do not repeat
  assert.match(firstToken, /^[0-9a-f]{64}$/);
  assert.match(secondToken, /^[0-9a-f]{64}$/);
  assert.notEqual(firstToken, secondToken);
});

test("buildChildEnv passes the daemon token through the child environment", () => {
  // Given: a desktop launch token
  const token = "a".repeat(64);

  // When: preparing the daemon environment
  const environment = buildChildEnv({ AGENT_CONSOLE_WS_TOKEN: token });

  // Then: the daemon receives exactly that token via environment only
  assert.equal(environment.AGENT_CONSOLE_WS_TOKEN, token);
});

test("buildDesktopConfig exposes the daemon token through the isolated bridge config", () => {
  // Given: daemon connection details and a launch token
  const token = "b".repeat(64);

  // When: building the response for tang:get-config
  const config = buildDesktopConfig({
    wsUrl: "ws://127.0.0.1:8765",
    token,
    platform: "linux",
    version: "0.1.0",
  });

  // Then: the bridge config preserves its existing values and includes the token
  assert.deepEqual(config, {
    wsUrl: "ws://127.0.0.1:8765",
    token,
    platform: "linux",
    version: "0.1.0",
    mode: "desktop",
  });
});

test("appendTokenToWsUrl replaces an existing token query parameter once", () => {
  // Given: a desktop WebSocket URL with an unrelated and stale query value
  const wsUrl = "ws://127.0.0.1:8765/?existing=value&token=stale";

  // When: applying the launch token
  const resolvedUrl = appendTokenToWsUrl(wsUrl, "c".repeat(64));
  const resolved = new URL(resolvedUrl);

  // Then: exactly one current token exists and unrelated query values remain
  assert.equal(resolved.searchParams.get("token"), "c".repeat(64));
  assert.deepEqual(resolved.searchParams.getAll("token"), ["c".repeat(64)]);
  assert.equal(resolved.searchParams.get("existing"), "value");
});

test("appendTokenToWsUrl leaves a tokenless standalone daemon URL unchanged", () => {
  // Given: a standalone daemon URL without desktop configuration
  const wsUrl = "ws://127.0.0.1:8765/?existing=value";

  // When: no token is provided
  const resolvedUrl = appendTokenToWsUrl(wsUrl, undefined);

  // Then: the exact input survives without token=undefined
  assert.equal(resolvedUrl, wsUrl);
});
