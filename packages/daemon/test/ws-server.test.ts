import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { AgentManager } from "../src/agent-manager.js";
import { SessionStore } from "../src/session-store.js";
import { WsServer } from "../src/ws-server.js";
import WebSocket from "ws";

class FakeAgentManager extends AgentManager {
  invocationCount = 0;
  providerListInvocations = 0;

  constructor(store: SessionStore) {
    super(store);
  }

  override onEvent(): () => void {
    return () => {};
  }

  override listProviders(): string[] {
    this.invocationCount += 1;
    this.providerListInvocations += 1;
    return ["pi"];
  }

  override async prompt(): Promise<never> {
    this.invocationCount += 1;
    throw new Error("unexpected AgentManager dispatch");
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expectRejectedConnection(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve();
    });
    socket.once("error", () => resolve());
    socket.once("open", () => reject(new Error("connection unexpectedly opened")));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiveResponse(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const response: unknown = JSON.parse(data.toString());
      if (!isRecord(response)) {
        reject(new Error("response was not an object"));
        return;
      }
      resolve(response);
    });
    socket.once("error", reject);
  });
}

function assertResponseCode(response: unknown, code: string): void {
  assert.ok(isRecord(response));
  assert.equal(response["code"], code);
}

async function startServer(token?: string): Promise<{
  readonly close: () => Promise<void>;
  readonly manager: FakeAgentManager;
  readonly server: WsServer;
}> {
  const store = new SessionStore(":memory:");
  const manager = new FakeAgentManager(store);
  const options = token === undefined ? { port: 0 } : { port: 0, token };
  const server = new WsServer(manager, options);
  await server.ready();
  return {
    manager,
    server,
    async close(): Promise<void> {
      await server.close();
      store.close();
    },
  };
}

test("rejects absent and mismatched tokens before dispatch", async (context) => {
  // Given: a server requiring a websocket token
  const token = randomBytes(16).toString("hex");
  const wrongToken = randomBytes(16).toString("hex");
  const { close, manager, server } = await startServer(token);
  context.after(close);
  const baseUrl = `ws://127.0.0.1:${server.port}/`;

  // When: clients omit or mismatch the token
  await expectRejectedConnection(baseUrl);
  await expectRejectedConnection(`${baseUrl}?token=${wrongToken}`);
  await expectRejectedConnection(`${baseUrl}?token=${token}&token=${token}`);

  // Then: neither handshake can reach AgentManager
  assert.equal(manager.invocationCount, 0);
  assert.equal(manager.providerListInvocations, 0);
});

test("accepts the configured token and dispatches providers.list", async (context) => {
  // Given: a server requiring a websocket token
  const token = randomBytes(16).toString("hex");
  const { close, manager, server } = await startServer(token);
  context.after(close);
  const socket = await connect(`ws://127.0.0.1:${server.port}/?token=${token}`);
  context.after(() => socket.close());

  // When: the authorized client requests providers
  socket.send(JSON.stringify({ id: 1, method: "providers.list" }));
  const response = await receiveResponse(socket);

  // Then: the request dispatches and returns the provider list
  assert.deepEqual(response, { id: 1, ok: true, result: { providers: ["pi"] } });
  assert.equal(manager.invocationCount, 1);
  assert.equal(manager.providerListInvocations, 1);
});

test("returns coded guard failures without dispatch", async (context) => {
  // Given: an authorized socket connected to a token-protected server
  const token = randomBytes(16).toString("hex");
  const { close, manager, server } = await startServer(token);
  context.after(close);
  const socket = await connect(`ws://127.0.0.1:${server.port}/?token=${token}`);
  context.after(() => socket.close());

  // When / Then: malformed wire messages receive their protocol-defined codes
  socket.send("{");
  assertResponseCode(await receiveResponse(socket), "INVALID_JSON");

  socket.send(JSON.stringify({ id: 2, method: "agent.prompt", params: { sessionId: "session", prompt: 1 } }));
  assertResponseCode(await receiveResponse(socket), "INVALID_PARAMS");

  socket.send(JSON.stringify({ id: 3, method: "unknown.method" }));
  assertResponseCode(await receiveResponse(socket), "UNKNOWN_METHOD");
  assert.equal(manager.invocationCount, 0);
  assert.equal(manager.providerListInvocations, 0);
});

test("accepts loopback clients when no token is configured", async (context) => {
  // Given: a standalone loopback server without a configured token
  const { close, manager, server } = await startServer();
  context.after(close);
  const socket = await connect(`ws://127.0.0.1:${server.port}/`);
  context.after(() => socket.close());

  // When: a loopback client invokes a valid request
  socket.send(JSON.stringify({ id: 1, method: "providers.list" }));
  const response = await receiveResponse(socket);

  // Then: existing standalone behavior remains available
  assert.ok(isRecord(response));
  assert.equal(response["ok"], true);
  assert.equal(manager.invocationCount, 1);
  assert.equal(manager.providerListInvocations, 1);
});
