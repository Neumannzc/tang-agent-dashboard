// 会话持久化存储：把各 provider 的恢复句柄落到 SQLite，支持 daemon 重启后恢复
// 数据库位置：~/.agent-console/sessions.db（WAL 模式）
// 首次运行时自动从旧版 sessions.json 迁移（成功后归档旧文件）

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentPersistenceHandle } from "@agent-console/protocol";

export interface StoredSession {
  /** 控制台侧会话 id（即 AgentSession.id） */
  sessionId: string;
  provider: string;
  cwd?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
  createdAt: number;
  lastActiveAt?: number;
  /** 各 provider 原生恢复句柄 */
  handle?: AgentPersistenceHandle;
}

/** DB 行（handle 为 JSON 文本列） */
interface SessionRow {
  session_id: string;
  provider: string;
  cwd: string | null;
  model: string | null;
  mode_id: string | null;
  thinking_option_id: string | null;
  system_prompt: string | null;
  created_at: number;
  last_active_at: number | null;
  handle: string | null;
}

const SCHEMA_VERSION = 1;

const INSERT_SQL = `
  INSERT INTO sessions (
    session_id, provider, cwd, model, mode_id, thinking_option_id, system_prompt,
    created_at, last_active_at, handle
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    provider = excluded.provider,
    cwd = excluded.cwd,
    model = excluded.model,
    mode_id = excluded.mode_id,
    thinking_option_id = excluded.thinking_option_id,
    system_prompt = excluded.system_prompt,
    created_at = excluded.created_at,
    last_active_at = excluded.last_active_at,
    handle = excluded.handle
`;

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath?: string) {
    const filePath = dbPath ?? path.join(homedir(), ".agent-console", "sessions.db");
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.init();
    this.migrateFromLegacyJson(path.join(homedir(), ".agent-console", "sessions.json"));
  }

  close(): void {
    this.db.close();
  }

  list(): StoredSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY last_active_at DESC")
      .all() as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  get(sessionId: string): StoredSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  put(session: StoredSession): void {
    const now = Date.now();
    this.db
      .prepare(INSERT_SQL)
      .run(
        session.sessionId,
        session.provider,
        session.cwd ?? null,
        session.model ?? null,
        session.modeId ?? null,
        session.thinkingOptionId ?? null,
        session.systemPrompt ?? null,
        session.createdAt,
        session.lastActiveAt ?? now,
        session.handle ? JSON.stringify(session.handle) : null,
      );
  }

  touch(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE session_id = ?").run(Date.now(), sessionId);
  }

  remove(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cwd TEXT,
        model TEXT,
        mode_id TEXT,
        thinking_option_id TEXT,
        system_prompt TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER,
        handle TEXT
      )
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** 旧版 JSON 一次性迁移：DB 为空且 sessions.json 存在时导入，成功后归档旧文件 */
  private migrateFromLegacyJson(jsonPath: string): void {
    const { c } = this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    if (c > 0) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(jsonPath, "utf8");
    } catch {
      return; // 无旧 JSON（全新安装）
    }
    try {
      const data = JSON.parse(raw) as { sessions?: StoredSession[] };
      const sessions = data.sessions ?? [];
      if (sessions.length === 0) {
        return;
      }
      const insert = this.db.prepare(INSERT_SQL);
      this.db.exec("BEGIN");
      try {
        for (const s of sessions) {
          if (!s.sessionId || !s.provider) {
            continue;
          }
          insert.run(
            s.sessionId,
            s.provider,
            s.cwd ?? null,
            s.model ?? null,
            s.modeId ?? null,
            s.thinkingOptionId ?? null,
            s.systemPrompt ?? null,
            s.createdAt,
            s.lastActiveAt ?? null,
            s.handle ? JSON.stringify(s.handle) : null,
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      renameSync(jsonPath, `${jsonPath}.migrated-${Date.now()}`);
      console.log(`[session-store] 已从 sessions.json 迁移 ${sessions.length} 条会话到 SQLite`);
    } catch (error) {
      console.error("[session-store] 迁移旧 sessions.json 失败:", error);
    }
  }
}

function rowToSession(row: SessionRow): StoredSession {
  let handle: AgentPersistenceHandle | undefined;
  if (row.handle) {
    try {
      handle = JSON.parse(row.handle) as AgentPersistenceHandle;
    } catch {
      // handle 损坏时忽略（会话仍可列出，只是无法恢复）
    }
  }
  return {
    sessionId: row.session_id,
    provider: row.provider,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.thinking_option_id ? { thinkingOptionId: row.thinking_option_id } : {}),
    ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
    createdAt: row.created_at,
    ...(row.last_active_at != null ? { lastActiveAt: row.last_active_at } : {}),
    ...(handle ? { handle } : {}),
  };
}
