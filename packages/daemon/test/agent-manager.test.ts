import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "@agent-console/protocol";
import { AgentManager, resolveResumeCwd } from "../src/agent-manager.js";
import { SessionStore } from "../src/session-store.js";

const capabilities: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsMcpServers: false,
  supportsToolInvocations: false,
  supportsReasoningStream: false,
  supportsDynamicModes: false,
};

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => {};
  reject: (reason: Error) => void = () => {};

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeSession implements AgentSession {
  readonly provider = "pi" as const;
  readonly id = "fake-session";
  private nextRun: () => Promise<AgentRunResult> = () => Promise.resolve(this.result());

  setNextRun(nextRun: () => Promise<AgentRunResult>): void {
    this.nextRun = nextRun;
  }

  run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.nextRun();
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, nativeHandle: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}

  result(): AgentRunResult {
    return { sessionId: this.id, finalText: "complete", timeline: [] };
  }
}

class FakeClient implements AgentClient {
  readonly provider = "pi" as const;
  readonly capabilities = capabilities;

  constructor(private readonly session: FakeSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
    return this.session;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {}
}

class CloseTrackingSession extends FakeSession {
  closed = false;

  override async close(): Promise<void> {
    this.closed = true;
  }
}

class ThrowingTouchStore extends SessionStore {
  readonly failure = new Error("touch failed");
  private throwsOnNextTouch = true;

  override touch(sessionId: string): void {
    if (this.throwsOnNextTouch) {
      this.throwsOnNextTouch = false;
      throw this.failure;
    }
    super.touch(sessionId);
  }
}

function createManager(tempDir: string, session: FakeSession): { readonly manager: AgentManager; readonly store: SessionStore } {
  const store = new SessionStore(path.join(tempDir, "sessions.db"));
  const client = new FakeClient(session);
  const manager = new AgentManager(store, {}, () => client);
  return { manager, store };
}

test("deleteProject closes loaded sessions of that cwd and removes its store rows", async (context) => {
  // Given: one loaded session in <temp>/proj/x plus another store row of the same project
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-manager-"));
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const projX = path.join(tempDir, "proj/x");
  mkdirSync(projX, { recursive: true });
  const session = new CloseTrackingSession();
  const { manager, store } = createManager(tempDir, session);
  await manager.createSession({ provider: "pi", cwd: projX });
  store.put({ sessionId: "extra", provider: "pi", cwd: projX, createdAt: 1 });
  store.put({ sessionId: "other", provider: "pi", cwd: "/proj/y", createdAt: 1 });

  // When: the project is deleted
  const { removed } = await manager.deleteProject(projX);

  // Then: the loaded session is closed, matching rows are gone, others remain
  assert.equal(session.closed, true);
  assert.equal(removed, 2);
  assert.deepEqual(
    store.list().map((s) => s.sessionId),
    ["other"],
  );
});

test("deleteProject with null cwd removes only ungrouped rows", async (context) => {
  // Given: rows with and without a cwd, none loaded in memory
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-manager-"));
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const { manager, store } = createManager(tempDir, new FakeSession());
  store.put({ sessionId: "ungrouped", provider: "pi", createdAt: 1 });
  store.put({ sessionId: "grouped", provider: "pi", cwd: "/proj/y", createdAt: 1 });

  // When: the ungrouped bucket is deleted
  const { removed } = await manager.deleteProject(null);

  // Then: only the null-cwd row disappears
  assert.equal(removed, 1);
  assert.deepEqual(
    store.list().map((s) => s.sessionId),
    ["grouped"],
  );
});

test("rejects a concurrent prompt and clears the running mark after success", async (context) => {
  // Given: a real manager session whose first run remains pending
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-manager-"));
  const session = new FakeSession();
  const deferred = new Deferred<AgentRunResult>();
  session.setNextRun(() => deferred.promise);
  const { manager, store } = createManager(tempDir, session);
  context.after(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const summary = await manager.createSession({ provider: "pi", cwd: tempDir });
  const firstPrompt = manager.prompt(summary.sessionId, "first");

  // When: another prompt targets the same session before the first settles
  await assert.rejects(manager.prompt(summary.sessionId, "second"), {
    message: "会话正在运行中，请先中断或等待完成",
  });
  deferred.resolve(session.result());
  await firstPrompt;

  // Then: the completed turn releases the session for another prompt
  await assert.doesNotReject(manager.prompt(summary.sessionId, "third"));
});

test("clears the running mark after a failed prompt", async (context) => {
  // Given: a real manager session whose first run rejects
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-manager-"));
  const session = new FakeSession();
  const failure = new Error("fake provider failure");
  let attempts = 0;
  session.setNextRun(() => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(failure) : Promise.resolve(session.result());
  });
  const { manager, store } = createManager(tempDir, session);
  context.after(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const summary = await manager.createSession({ provider: "pi", cwd: tempDir });

  // When: the first prompt fails
  await assert.rejects(manager.prompt(summary.sessionId, "first"), failure);

  // Then: the subsequent prompt is permitted
  await assert.doesNotReject(manager.prompt(summary.sessionId, "second"));
});

test("clears the running mark after touch fails", async (context) => {
  // Given: a real store that fails its first touch while preserving registration writes
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-manager-"));
  const session = new FakeSession();
  const store = new ThrowingTouchStore(path.join(tempDir, "sessions.db"));
  const client = new FakeClient(session);
  const manager = new AgentManager(store, {}, () => client);
  context.after(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const summary = await manager.createSession({ provider: "pi", cwd: tempDir });

  // When: touching the session before a prompt throws
  await assert.rejects(manager.prompt(summary.sessionId, "first"), store.failure);

  // Then: the failed touch releases the session for a later prompt
  await assert.doesNotReject(manager.prompt(summary.sessionId, "second"));
});

test("uses the requested resume cwd when it is a directory", (context) => {
  // Given: real directories plus paths that exist but are files
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-cwd-"));
  const requestedDir = path.join(tempDir, "requested");
  const storedDir = path.join(tempDir, "stored");
  const defaultDir = path.join(tempDir, "default");
  for (const dir of [requestedDir, storedDir, defaultDir]) {
    mkdirSync(dir);
  }
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));

  // When: all fallback levels are valid
  const resolved = resolveResumeCwd(storedDir, requestedDir, defaultDir);

  // Then: the explicit requested directory wins
  assert.equal(resolved, requestedDir);
});

test("uses the stored resume cwd when the requested cwd is invalid", (context) => {
  // Given: an invalid requested path and a valid stored directory
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-cwd-"));
  const storedDir = path.join(tempDir, "stored");
  const requestedFile = path.join(tempDir, "requested-file");
  mkdirSync(storedDir);
  writeFileSync(requestedFile, "file");
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));

  // When: the requested cwd names a file instead of a directory
  const resolved = resolveResumeCwd(storedDir, requestedFile);

  // Then: the valid stored directory is used
  assert.equal(resolved, storedDir);
});

test("uses the configured default cwd when requested and stored cwds are invalid", (context) => {
  // Given: invalid requested and stored paths with a valid configured fallback
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-cwd-"));
  const defaultDir = path.join(tempDir, "default");
  mkdirSync(defaultDir);
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));

  // When: no higher-priority directory is usable
  const resolved = resolveResumeCwd(path.join(tempDir, "stored"), path.join(tempDir, "requested"), defaultDir);

  // Then: the configured default directory is used
  assert.equal(resolved, defaultDir);
});

test("falls back to homedir and warns only for explicit invalid cwd levels", (context) => {
  // Given: invalid paths and a captured warning sink
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-console-cwd-"));
  const invalidFile = path.join(tempDir, "not-a-directory");
  writeFileSync(invalidFile, "file");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => warnings.push(String(message));
  context.after(() => {
    console.warn = originalWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // When: every provided level is invalid, then every level is omitted
  const fromInvalidPaths = resolveResumeCwd(invalidFile, "", invalidFile);
  const fromUndefinedPaths = resolveResumeCwd(undefined);

  // Then: both calls use home, while only supplied invalid levels warn
  assert.equal(fromInvalidPaths, homedir());
  assert.equal(fromUndefinedPaths, homedir());
  assert.equal(warnings.length, 3);
});
