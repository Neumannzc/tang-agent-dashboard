// 会话持久化存储：把各 provider 的恢复句柄落到磁盘，支持 daemon 重启后恢复
// 文件位置：~/.agent-console/sessions.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  systemPrompt?: string;
  createdAt: number;
  lastActiveAt?: number;
  /** 各 provider 原生恢复句柄 */
  handle?: AgentPersistenceHandle;
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, StoredSession>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(homedir(), ".agent-console", "sessions.json");
    this.load();
  }

  list(): StoredSession[] {
    return [...this.sessions.values()].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }

  get(sessionId: string): StoredSession | undefined {
    return this.sessions.get(sessionId);
  }

  put(session: StoredSession): void {
    session.lastActiveAt = Date.now();
    this.sessions.set(session.sessionId, session);
    this.save();
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
      this.save();
    }
  }

  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.save();
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as { sessions?: StoredSession[] };
      for (const session of data.sessions ?? []) {
        if (session.sessionId) {
          this.sessions.set(session.sessionId, session);
        }
      }
    } catch {
      // 首次运行：文件不存在，忽略
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2),
        "utf8",
      );
    } catch (error) {
      console.error("[session-store] 保存失败:", error);
    }
  }
}
