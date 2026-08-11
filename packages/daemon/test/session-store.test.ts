import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoredSession } from "../src/session-store.js";

const originalHome = process.env.HOME;
const testHome = mkdtempSync(path.join(tmpdir(), "agent-console-store-home-"));
process.env.HOME = testHome;

const { SessionStore } = await import("../src/session-store.js");

after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(testHome, { recursive: true, force: true });
});

function createTempStore(): {
  readonly dbPath: string;
  readonly directory: string;
  readonly store: InstanceType<typeof SessionStore>;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-console-store-"));
  const dbPath = path.join(directory, "sessions.db");
  return { directory, dbPath, store: new SessionStore(dbPath) };
}

function session(sessionId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    provider: "pi",
    cwd: `/workspace/${sessionId}`,
    createdAt: 1,
    ...overrides,
  };
}

function closeAndRemove(store: InstanceType<typeof SessionStore>, directory: string): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

test("isolates explicit db paths and performs CRUD, upsert, touch, and removal", (context) => {
  // Given: a store backed by a cleanup-owned database file
  const { directory, store } = createTempStore();
  context.after(() => closeAndRemove(store, directory));
  const defaultDatabase = path.join(testHome, ".agent-console", "sessions.db");
  const beforePut = Date.now();

  // When: a session is inserted, updated, touched, then removed
  store.put(session("one", { handle: { provider: "pi", nativeHandle: "native-one" } }));
  const inserted = store.get("one");
  store.put(session("one", { title: "updated" }));
  const beforeTouch = store.get("one")?.lastActiveAt ?? 0;
  store.touch("one");
  const touched = store.get("one");
  store.remove("one");

  // Then: default storage remains untouched and every CRUD contract holds
  assert.equal(existsSync(defaultDatabase), false);
  assert.ok(inserted?.lastActiveAt !== undefined && inserted.lastActiveAt >= beforePut);
  assert.deepEqual(inserted?.handle, { provider: "pi", nativeHandle: "native-one" });
  assert.equal(store.list().length, 0);
  assert.equal(touched?.title, "updated");
  assert.ok((touched?.lastActiveAt ?? 0) >= beforeTouch);
});

test("rolls back a failing putMany transaction and treats an empty batch as a no-op", (context) => {
  // Given: a valid record and a later record whose cyclic persistence metadata cannot serialize
  const { directory, store } = createTempStore();
  context.after(() => closeAndRemove(store, directory));
  const metadata: Record<string, unknown> = {};
  metadata["self"] = metadata;
  const invalid = session("invalid", { handle: { provider: "pi", metadata } });

  // When: the empty batch and then the mixed batch are written
  store.putMany([]);
  assert.throws(() => store.putMany([session("valid"), invalid]));

  // Then: the failed batch leaves no partial rows behind
  assert.deepEqual(store.list(), []);
});

test("removes every session under a cwd, including null-cwd rows", (context) => {
  // Given: sessions spread across two projects plus one without a cwd
  const { directory, store } = createTempStore();
  context.after(() => closeAndRemove(store, directory));
  store.put(session("a", { cwd: "/proj/x" }));
  store.put(session("b", { cwd: "/proj/x" }));
  store.put(session("c", { cwd: "/proj/y" }));
  store.put(session("d", { cwd: undefined }));

  // When: the project and then the ungrouped rows are removed
  const removedX = store.removeByCwd("/proj/x");
  const removedNull = store.removeByCwd(null);

  // Then: only the matching rows disappear and the count is exact
  assert.equal(removedX, 2);
  assert.equal(removedNull, 1);
  assert.deepEqual(
    store.list().map((s) => s.sessionId),
    ["c"],
  );
});

test("ignores corrupted stored handles without breaking list or get", (context) => {
  // Given: a persisted session whose handle column is no longer valid JSON
  const { dbPath, directory, store } = createTempStore();
  store.put(session("corrupted", { handle: { provider: "pi", nativeHandle: "before-corruption" } }));
  store.close();
  const database = new DatabaseSync(dbPath);
  database.prepare("UPDATE sessions SET handle = ? WHERE session_id = ?").run("{", "corrupted");
  database.close();
  const reopened = new SessionStore(dbPath);
  context.after(() => closeAndRemove(reopened, directory));

  // When: callers read the malformed persistence row
  const fromGet = reopened.get("corrupted");
  const fromList = reopened.list();

  // Then: session metadata remains readable without a handle
  assert.equal(fromGet?.sessionId, "corrupted");
  assert.equal(fromGet?.handle, undefined);
  assert.equal(fromList[0]?.sessionId, "corrupted");
  assert.equal(fromList[0]?.handle, undefined);
});

test("migrates legacy JSON only into an empty explicit database and archives the source", (context) => {
  // Given: an isolated HOME legacy file and an empty explicit SQLite target
  const legacyDirectory = path.join(testHome, ".agent-console");
  const legacyPath = path.join(legacyDirectory, "sessions.json");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    legacyPath,
    JSON.stringify({
      sessions: [session("legacy", { handle: { provider: "pi", nativeHandle: "legacy-handle" } })],
    }),
  );
  const { directory, store } = createTempStore();
  context.after(() => closeAndRemove(store, directory));

  // When: SessionStore opens the empty explicit database
  const migrated = store.get("legacy");
  const archivedFiles = readdirSync(legacyDirectory);

  // Then: it imports the row and atomically archives the one-shot source file
  assert.equal(migrated?.sessionId, "legacy");
  assert.deepEqual(migrated?.handle, { provider: "pi", nativeHandle: "legacy-handle" });
  assert.equal(existsSync(legacyPath), false);
  assert.equal(archivedFiles.filter((file) => file.startsWith("sessions.json.migrated-")).length, 1);
});

test("leaves legacy JSON untouched when the explicit database already has sessions", (context) => {
  // Given: a populated SQLite database and a later-created legacy JSON source
  const legacyDirectory = path.join(testHome, ".agent-console");
  const legacyPath = path.join(legacyDirectory, "sessions.json");
  rmSync(legacyDirectory, { recursive: true, force: true });
  const { dbPath, directory, store } = createTempStore();
  store.put(session("current"));
  store.close();
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ sessions: [session("legacy")] }));
  const reopened = new SessionStore(dbPath);
  context.after(() => closeAndRemove(reopened, directory));

  // When: the populated database is reopened
  const sessions = reopened.list();

  // Then: current SQLite data wins and the legacy source remains unmigrated
  assert.deepEqual(sessions.map((stored) => stored.sessionId), ["current"]);
  assert.equal(existsSync(legacyPath), true);
});
