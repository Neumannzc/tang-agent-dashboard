// 历史会话扫描 / 导入：读取 Pi / Codex / Claude Code / OpenCode 本地会话存储，
// 提取元数据（标题 / 项目路径 / 时间戳 / 恢复句柄），写入控制台 SQLite。
// 只读扫描：绝不修改 agent 的配置或存储文件；不存储会话内容。

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentPersistenceHandle, AgentProvider, HistorySession, SessionSummary } from "@agent-console/protocol";
import type { SessionStore, StoredSession } from "./session-store.js";

/** 超过该大小的会话文件跳过（本机最大 pi 会话约 22MB） */
const MAX_SESSION_FILE_SIZE = 64 * 1024 * 1024;
/** 头部读取窗口（覆盖 codex session_meta 超长首行 ~15KB） */
const HEAD_WINDOW = 256 * 1024;
/** 尾部读取窗口：claude 的 ai-title/last-prompt 周期性写盘、最新一条贴近文件尾，16KB 会漏（实测大文件需 ~32KB） */
const TAIL_WINDOW = 64 * 1024;
const TITLE_MAX_CHARS = 80;

// ---------- 内部候选结构 ----------

interface ScanCandidate {
  provider: AgentProvider;
  /** 各 provider 原生会话标识（claude/codex/opencode: 会话 id；pi: 文件绝对路径） */
  nativeHandle: string;
  /** agent 逻辑会话 id（pi 与 nativeHandle 不同：header 里的 id；其余与 nativeHandle 一致） */
  nativeId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  createdAt: number;
  lastActiveAt?: number;
}

// ---------- 共享小工具 ----------

/** 只读文件头/尾行（大文件不整读；返回 null 表示文件过大/不可读） */
async function readHeadTailLines(filePath: string): Promise<{ head: string[]; tail: string[] } | null> {
  let size: number;
  try {
    const st = await fs.stat(filePath);
    size = st.size;
  } catch {
    return null;
  }
  if (size === 0) {
    return { head: [], tail: [] };
  }
  if (size > MAX_SESSION_FILE_SIZE) {
    console.warn(
      `[history-import] 跳过超大会话文件（${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_SESSION_FILE_SIZE / 1024 / 1024}MB）: ${filePath}`,
    );
    return null;
  }
  if (size <= HEAD_WINDOW + TAIL_WINDOW) {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split("\n");
    return { head: lines.slice(0, 10), tail: lines.slice(-60) };
  }
  const fd = await fs.open(filePath, "r");
  try {
    const headBuf = Buffer.alloc(HEAD_WINDOW);
    const headRead = await fd.read(headBuf, 0, headBuf.length, 0);
    const headText = headBuf.subarray(0, headRead.bytesRead).toString("utf8");
    const headLines = headText.split("\n");
    // 丢弃末尾不完整的行（无换行结尾）
    if (!headText.endsWith("\n")) {
      headLines.pop();
    }

    const tailBuf = Buffer.alloc(TAIL_WINDOW);
    const tailRead = await fd.read(tailBuf, 0, tailBuf.length, size - tailBuf.length);
    const tailText = tailBuf.subarray(0, tailRead.bytesRead).toString("utf8");
    const tailLines = tailText.split("\n");
    // 丢弃开头可能不完整的行
    if (size > TAIL_WINDOW && tailLines.length > 0) {
      tailLines.shift();
    }
    return { head: headLines.slice(0, 10), tail: tailLines.slice(-60) };
  } finally {
    await fd.close();
  }
}

/** 逐行容错解析：损坏/空行跳过 */
function parseLines(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      // 单行损坏不影响其余行
    }
  }
  return out;
}

/** RFC3339 字符串或 epoch(ms/s) → 毫秒；无法解析返回 undefined */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function firstTimestamp(recs: Record<string, unknown>[]): number | undefined {
  for (const rec of recs) {
    const ts = parseTimestamp(rec.timestamp);
    if (ts !== undefined) {
      return ts;
    }
  }
  return undefined;
}

async function fileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}

/** 内容 → 文本（字符串或 [{type:"text",text}] 数组） */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** 注入/命令类内容（不应作为标题） */
const INJECTED_MARKERS = [
  "AGENTS.md instructions",
  "<environment_context>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<command-name>",
  "# Context from my IDE setup:",
];

function isInjectedText(text: string): boolean {
  return INJECTED_MARKERS.some((marker) => text.includes(marker));
}

function truncateTitle(text: string, max = TITLE_MAX_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max)}…`;
}

function basename(p: string | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  const trimmed = p.replace(/\/+$/, "");
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 递归收集 *.jsonl（目录不存在返回空数组） */
async function collectJsonlRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectJsonlRecursive(p)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

/** 扫描结果的 key：provider + nativeHandle（跨 provider 去重 + 与 store 去重的依据） */
function candidateKey(provider: AgentProvider, nativeHandle: string): string {
  return `${provider}:${nativeHandle}`;
}

// ---------- 各 provider 存储路径 ----------

function claudeProjectsDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env ? path.join(env, "projects") : path.join(homedir(), ".claude", "projects");
}

function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
}

function opencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return dataHome
    ? path.join(dataHome, "opencode", "opencode.db")
    : path.join(homedir(), ".local", "share", "opencode", "opencode.db");
}

function piSessionsDir(): string {
  return path.join(homedir(), ".pi", "agent", "sessions");
}

// ---------- claude ----------

async function scanClaudeHistory(projectsDir: string): Promise<ScanCandidate[]> {
  const candidates: ScanCandidate[] = [];
  if (!existsSync(projectsDir)) {
    return candidates;
  }
  const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const files = await fs.readdir(path.join(projectsDir, entry.name)).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(projectsDir, entry.name, file);
      const ht = await readHeadTailLines(filePath);
      if (!ht) {
        continue;
      }
      const head = parseLines(ht.head);
      const tail = parseLines(ht.tail);

      const sessionId = file.replace(/\.jsonl$/, "");
      let cwd: string | undefined;
      let createdAt = firstTimestamp(head) ?? (await fileMtimeMs(filePath));
      let customTitle: string | undefined;
      let aiTitle: string | undefined;
      let lastPrompt: string | undefined;
      let firstUserMsg: string | undefined;

      // cwd：head 优先，system/尾部记录也带（cc-switch 只在 head 找，可能漏）
      // 标题记录（custom-title/ai-title/last-prompt）claude 周期性写、最新一条通常在文件尾部，
      // 只查 head 前 10 行会漏（大文件尤其明显），故 head+tail 都查并取最后一条；
      // firstUserMsg 只取第一条非注入用户消息（head 有则 head，否则尾部补）
      for (const rec of [...head, ...tail]) {
        if (!cwd && typeof rec.cwd === "string" && rec.cwd) {
          cwd = rec.cwd;
        }
        if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
          customTitle = rec.customTitle;
        }
        if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
          aiTitle = rec.aiTitle;
        }
        if (rec.type === "last-prompt" && typeof rec.lastPrompt === "string") {
          lastPrompt = rec.lastPrompt;
        }
        if (firstUserMsg === undefined) {
          const message = rec.message;
          if (isRecord(message) && message.role === "user") {
            const text = extractText(message.content);
            if (text && !isInjectedText(text)) {
              firstUserMsg = truncateTitle(text);
            }
          }
        }
      }
      let lastActiveAt = await fileMtimeMs(filePath);
      for (let i = tail.length - 1; i >= 0; i--) {
        const ts = parseTimestamp(tail[i]?.timestamp);
        if (ts !== undefined) {
          lastActiveAt = ts;
          break;
        }
      }

      // lastPrompt 是长 prompt 原样字段，作为标题需截断
      const lastPromptTitle = lastPrompt ? truncateTitle(lastPrompt) : undefined;
      const title =
        customTitle ??
        aiTitle ??
        firstUserMsg ??
        lastPromptTitle ??
        basename(cwd) ??
        `会话 ${sessionId.slice(0, 6)}`;

      candidates.push({
        provider: "claude",
        nativeHandle: sessionId,
        title,
        ...(cwd ? { cwd } : {}),
        createdAt: createdAt ?? 0,
        ...(lastActiveAt != null ? { lastActiveAt } : {}),
      });
    }
  }
  return candidates;
}

// ---------- codex ----------

/** 从 session_index.jsonl 读取线程标题（容错：坏行跳过） */
async function loadCodexThreadTitles(root: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const indexPath = path.join(root, "session_index.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return titles;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.id === "string" && typeof rec.thread_name === "string" && rec.thread_name) {
        titles.set(rec.id, rec.thread_name);
      }
    } catch {
      // 忽略损坏行
    }
  }
  return titles;
}

async function scanCodexHistory(root: string): Promise<ScanCandidate[]> {
  const candidates: ScanCandidate[] = [];
  const sessionsDir = path.join(root, "sessions");
  const archivedDir = path.join(root, "archived_sessions");
  const files = [
    ...(await collectJsonlRecursive(sessionsDir)),
    ...(await collectJsonlRecursive(archivedDir)),
  ];
  const threadTitles = await loadCodexThreadTitles(root);

  for (const filePath of files) {
    const ht = await readHeadTailLines(filePath);
    if (!ht) {
      continue;
    }
    const head = parseLines(ht.head);
    const tail = parseLines(ht.tail);

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let createdAt: number | undefined;
    let isSubagent = false;
    for (const rec of head) {
      if (rec.type !== "session_meta") {
        continue;
      }
      const payload = rec.payload;
      if (!isRecord(payload)) {
        continue;
      }
      if (isRecord(payload.source) && "subagent" in payload.source) {
        isSubagent = true;
      }
      if (typeof payload.id === "string" && payload.id) {
        sessionId = payload.id;
      }
      if (typeof payload.cwd === "string" && payload.cwd) {
        cwd = payload.cwd;
      }
      if (createdAt === undefined) {
        createdAt = parseTimestamp(payload.timestamp) ?? firstTimestamp(head);
      }
    }
    if (!sessionId || isSubagent) {
      continue;
    }

    let firstUserMsg: string | undefined;
    for (const rec of [...head, ...tail]) {
      if (rec.type !== "response_item") {
        continue;
      }
      const payload = rec.payload;
      if (!isRecord(payload) || payload.type !== "message" || payload.role !== "user") {
        continue;
      }
      const text = extractText(payload.content);
      if (text && !isInjectedText(text)) {
        firstUserMsg = truncateTitle(text);
        break;
      }
    }

    let lastActiveAt = await fileMtimeMs(filePath);
    for (let i = tail.length - 1; i >= 0; i--) {
      const ts = parseTimestamp(tail[i]?.timestamp);
      if (ts !== undefined) {
        lastActiveAt = ts;
        break;
      }
    }

    const title =
      threadTitles.get(sessionId) ??
      firstUserMsg ??
      basename(cwd) ??
      `会话 ${sessionId.slice(0, 8)}`;

    candidates.push({
      provider: "codex",
      nativeHandle: sessionId,
      title,
      ...(cwd ? { cwd } : {}),
      createdAt: createdAt ?? 0,
      ...(lastActiveAt != null ? { lastActiveAt } : {}),
    });
  }
  return candidates;
}

// ---------- opencode（SQLite 直读） ----------

interface OpencodeSessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
}

function parseOpencodeModel(modelJson: string | null): string | undefined {
  if (!modelJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(modelJson) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

async function scanOpencodeHistory(dbPath: string): Promise<ScanCandidate[]> {
  const candidates: ScanCandidate[] = [];
  if (!existsSync(dbPath)) {
    return candidates;
  }
  // 直读 SQLite：WAL 允许与运行中的 opencode server 并发读。只读打开失败
  // （WAL -shm 需要重建）时退回读写连接 + query_only，绝不影响 agent 数据。
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = ON");
  }
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const rows = db
      .prepare(
        `SELECT id, title, directory, model, time_created, time_updated
         FROM session WHERE parent_id IS NULL`,
      )
      .all() as unknown as OpencodeSessionRow[];
    for (const row of rows) {
      const cwd = row.directory || undefined;
      const createdAt = Number(row.time_created);
      const lastActiveAt = Number(row.time_updated);
      const model = parseOpencodeModel(row.model);
      // opencode 未起名会话的占位标题 "New session - <时间>"，导入时回退到项目目录名
      const rawTitle = (row.title && row.title.trim()) || "";
      const title = /^New session - \d{4}-\d{2}-\d{2}T/.test(rawTitle) ? "" : rawTitle;
      candidates.push({
        provider: "opencode",
        nativeHandle: row.id,
        title: truncateTitle(title || basename(cwd) || `会话 ${row.id.slice(0, 6)}`),
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        ...(Number.isFinite(lastActiveAt) ? { lastActiveAt } : {}),
      });
    }
  } catch (error) {
    // opencode 升级可能改 schema；单 provider 失败不应拖垮整次 scanHistory（其它 provider 照常）
    console.warn(
      `[history-import] opencode 历史扫描失败（opencode.db schema 可能已变更）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return candidates;
  } finally {
    db.close();
  }
  return candidates;
}

// ---------- pi ----------

async function scanPiHistory(sessionsDir: string): Promise<ScanCandidate[]> {
  const candidates: ScanCandidate[] = [];
  if (!existsSync(sessionsDir)) {
    return candidates;
  }
  const files = await collectJsonlRecursive(sessionsDir);
  for (const filePath of files) {
    const ht = await readHeadTailLines(filePath);
    if (!ht) {
      continue;
    }
    const head = parseLines(ht.head);
    const tail = parseLines(ht.tail);

    let id: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let createdAt = await fileMtimeMs(filePath);
    let firstUserMsg: string | undefined;

    for (const rec of head) {
      // v3 头：type=session；v4 头：kind=header
      if (rec.type === "session" || rec.kind === "header") {
        if (typeof rec.id === "string" && rec.id) {
          id = rec.id;
        }
        if (typeof rec.cwd === "string" && rec.cwd) {
          cwd = rec.cwd;
        }
        const ts = parseTimestamp(rec.timestamp ?? rec.createdAt);
        if (ts !== undefined) {
          createdAt = ts;
        }
      }
      if (!model && rec.type === "model_change" && typeof rec.modelId === "string") {
        model = rec.modelId;
      }
      if (firstUserMsg === undefined && rec.type === "message") {
        const message = rec.message;
        if (isRecord(message) && message.role === "user") {
          const text = extractText(message.content);
          if (text && !isInjectedText(text)) {
            firstUserMsg = truncateTitle(text);
          }
        }
      }
    }
    // 头 10 行可能没有 user 消息，尾部补充
    if (firstUserMsg === undefined) {
      for (const rec of tail) {
        if (rec.type === "message" && isRecord(rec.message) && rec.message.role === "user") {
          const text = extractText(rec.message.content);
          if (text && !isInjectedText(text)) {
            firstUserMsg = truncateTitle(text);
            break;
          }
        }
      }
    }
    if (!id) {
      // 兼容无头文件：文件名 <ts>_<id>.jsonl
      const stem = path.basename(filePath, ".jsonl");
      id = stem.split("_").pop() ?? stem;
    }
    let lastActiveAt = await fileMtimeMs(filePath);
    for (let i = tail.length - 1; i >= 0; i--) {
      const ts = parseTimestamp(tail[i]?.timestamp);
      if (ts !== undefined) {
        lastActiveAt = ts;
        break;
      }
    }

    const title = firstUserMsg ?? basename(cwd) ?? `会话 ${id.slice(0, 6)}`;

    candidates.push({
      provider: "pi",
      // pi 恢复句柄是会话文件绝对路径（与 PiRpcAgentClient.resumeSession 一致）
      nativeHandle: filePath,
      // 逻辑会话 id = header 里的 id（resume 时 pi 返回同 id，用作 console id 避免 re-key 重复行）
      nativeId: id,
      title,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      createdAt: createdAt ?? 0,
      ...(lastActiveAt != null ? { lastActiveAt } : {}),
    });
  }
  return candidates;
}

// ---------- 汇总 / 去重 / 导入 ----------

async function scanProviderHistory(provider: AgentProvider): Promise<ScanCandidate[]> {
  switch (provider) {
    case "claude":
      return scanClaudeHistory(claudeProjectsDir());
    case "codex":
      return scanCodexHistory(codexHomeDir());
    case "opencode":
      return scanOpencodeHistory(opencodeDbPath());
    case "pi":
      return scanPiHistory(piSessionsDir());
    default:
      return [];
  }
}

/** 扫描候选 → HistorySession（含 imported 标记与 recoverable 判定） */
function toHistorySession(candidate: ScanCandidate, known: Set<string>): HistorySession {
  const key = candidateKey(candidate.provider, candidate.nativeHandle);
  const cwd = candidate.cwd;
  return {
    id: key,
    provider: candidate.provider,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(candidate.model ? { model: candidate.model } : {}),
    ...(candidate.nativeId ? { nativeId: candidate.nativeId } : {}),
    createdAt: candidate.createdAt,
    ...(candidate.lastActiveAt != null ? { lastActiveAt: candidate.lastActiveAt } : {}),
    imported: known.has(key),
    recoverable: cwd ? existsSync(cwd) : false,
    handle: {
      provider: candidate.provider,
      nativeHandle: candidate.nativeHandle,
      ...(cwd || candidate.model ? { metadata: { ...(cwd ? { cwd } : {}), ...(candidate.model ? { model: candidate.model } : {}) } } : {}),
    },
  };
}

/**
 * 扫描指定 provider 的历史会话。
 * - 与 store 比对标记 imported（含本软件内创建的会话）
 * - 同一 nativeHandle 在扫描内出现多次时保留最近一条（如 codex 同时在 sessions/ 与 archived_sessions/）
 */
export async function scanHistory(providers: AgentProvider[], store: SessionStore): Promise<HistorySession[]> {
  const known = new Set<string>();
  for (const stored of store.list()) {
    const handle = stored.handle;
    if (handle?.nativeHandle) {
      known.add(candidateKey(stored.provider as AgentProvider, handle.nativeHandle));
    }
  }

  const byId = new Map<string, HistorySession>();
  for (const provider of providers) {
    const candidates = await scanProviderHistory(provider);
    for (const candidate of candidates) {
      const key = candidateKey(provider, candidate.nativeHandle);
      const existing = byId.get(key);
      if (!existing || (candidate.lastActiveAt ?? 0) > (existing.lastActiveAt ?? 0)) {
        byId.set(key, toHistorySession(candidate, known));
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt),
  );
}

/**
 * 导入指定 provider 的全部历史会话（未导入过的）。
 * 幂等：已导入的（含本软件内创建的）计入 skipped，重复执行是 no-op。
 */
export async function importHistory(
  providers: AgentProvider[],
  store: SessionStore,
): Promise<{ imported: SessionSummary[]; skipped: number }> {
  const scanned = await scanHistory(providers, store);
  const fresh = scanned.filter((session) => !session.imported);

  const rows: StoredSession[] = fresh.map((session) => {
    const baseMetadata: Record<string, unknown> = {
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
    };
    // console 侧会话 id = agent 原生会话 id（导入会话记录 agent 自己的 sessionId，不由本软件生成）：
    // - claude/codex/opencode：nativeHandle 即会话 id（claude 文件 UUID / codex thread id / opencode ses_）
    // - pi：nativeHandle 是会话文件路径，nativeId 才是 header 里的会话 id
    // 用原生 id 的额外好处：resume 时 agent 返回同 id，register() 落库不产生新行，不会重复
    // （claude 经 handle.metadata.consoleSessionId 保持 id 稳定；nativeHandle 类型可空，兜底生成）
    const sessionId = session.nativeId ?? session.handle.nativeHandle ?? randomUUID();
    const handle: AgentPersistenceHandle = {
      provider: session.provider,
      nativeHandle: session.handle.nativeHandle,
      metadata: baseMetadata,
    };
    if (session.provider === "claude") {
      handle.metadata = { ...baseMetadata, consoleSessionId: sessionId };
    }
    return {
      sessionId,
      provider: session.provider,
      ...(session.title ? { title: session.title } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      createdAt: session.createdAt,
      ...(session.lastActiveAt != null ? { lastActiveAt: session.lastActiveAt } : {}),
      handle,
    };
  });

  store.putMany(rows);

  const imported: SessionSummary[] = rows.map((row) => ({
    sessionId: row.sessionId,
    provider: row.provider as AgentProvider,
    ...(row.title ? { title: row.title } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.createdAt,
    ...(row.lastActiveAt != null ? { lastActiveAt: row.lastActiveAt } : {}),
    active: false,
    handle: row.handle,
  }));

  return { imported, skipped: scanned.length - fresh.length };
}
