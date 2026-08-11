// 状态模型与纯函数：workspace 聚合、timeline 追加（打字机聚合）

import type {
  AgentPermissionRequest,
  AgentStreamEvent,
  AgentTimelineItem,
  SessionSummary,
} from "@agent-console/protocol";

// ---------- workspace（项目）模型 ----------

export interface Workspace {
  /** 稳定 key = cwd */
  cwd: string;
  /** 会话 id（最近活跃在前） */
  sessionIds: string[];
}

const UNGROUPED = "(未归组)";

export { UNGROUPED };

/** 由会话列表聚合出 workspace 列表（方案 A：按 cwd 分组，协议不改） */
export function buildWorkspaces(sessions: SessionSummary[], knownCwds: string[]): Workspace[] {
  const map = new Map<string, string[]>();
  for (const session of sessions) {
    const cwd = session.cwd?.trim() || UNGROUPED;
    const list = map.get(cwd);
    if (list) {
      list.push(session.sessionId);
    } else {
      map.set(cwd, [session.sessionId]);
    }
  }
  // 用户新建过但暂无会话的 workspace 也保留（空项目）
  for (const cwd of knownCwds) {
    if (cwd && !map.has(cwd)) {
      map.set(cwd, []);
    }
  }
  return [...map.entries()]
    .map(([cwd, sessionIds]) => ({ cwd, sessionIds }))
    .sort((a, b) => {
      const lastA = a.sessionIds.length ? (sessions.find((s) => s.sessionId === a.sessionIds[0])?.lastActiveAt ?? 0) : 0;
      const lastB = b.sessionIds.length ? (sessions.find((s) => s.sessionId === b.sessionIds[0])?.lastActiveAt ?? 0) : 0;
      return lastB - lastA;
    });
}

/** 会话路径显示（cwd 或未归组） */
export function sessionCwd(session: SessionSummary): string {
  return session.cwd?.trim() || UNGROUPED;
}

// ---------- timeline 模型 ----------

export type UiItem = AgentTimelineItem & { key: string; turnId?: string };

export type UiPermissionItem = {
  key: string;
  turnId?: string;
  type: "permission";
  request: AgentPermissionRequest;
};

export type ThreadItem = UiItem | UiPermissionItem;

function newKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 追加 timeline 项；assistant 消息/reasoning 同回合流式替换（打字机效果），tool_call 按 callId 更新 */
export function appendTimelineItem(list: ThreadItem[], item: AgentTimelineItem, turnId?: string): ThreadItem[] {
  if (item.type === "assistant_message" || item.type === "reasoning") {
    const last = list[list.length - 1];
    if (last && last.type === item.type && last.turnId === turnId) {
      return [...list.slice(0, -1), { ...item, key: last.key, turnId }];
    }
    return [...list, { ...item, key: newKey(), turnId }];
  }
  if (item.type === "tool_call") {
    const existingIndex = list.findIndex((t) => t.type === "tool_call" && t.callId === item.callId);
    if (existingIndex >= 0) {
      const next = [...list];
      next[existingIndex] = { ...item, key: next[existingIndex]!.key, turnId };
      return next;
    }
    return [...list, { ...item, key: newKey(), turnId }];
  }
  return [...list, { ...item, key: newKey(), turnId }];
}

/** 权限事件 → timeline 项 */
export function appendPermission(list: ThreadItem[], request: AgentPermissionRequest, turnId?: string): ThreadItem[] {
  return [...list, { type: "permission", request, turnId, key: newKey() }];
}

/** 权限解决 → 移除对应卡片 */
export function removePermission(list: ThreadItem[], requestId: string): ThreadItem[] {
  return list.filter((item) => !(item.type === "permission" && item.request.id === requestId));
}

// ---------- 事件应用（agent.event 推送 → 状态更新） ----------

export type TimelineEvent =
  | { kind: "timeline"; item: AgentTimelineItem; turnId?: string }
  | { kind: "permission"; request: AgentPermissionRequest; turnId?: string }
  | { kind: "permission_resolved"; requestId: string };

export function applyEvent(
  list: ThreadItem[],
  event: AgentStreamEvent,
): { list: ThreadItem[]; timelineEvent?: TimelineEvent; running?: boolean } {
  switch (event.type) {
    case "turn_started":
      return { list, running: true };
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
      return { list, running: false };
    case "timeline":
      return { list: appendTimelineItem(list, event.item, event.turnId), timelineEvent: { kind: "timeline", item: event.item, turnId: event.turnId } };
    case "permission_requested":
      return { list: appendPermission(list, event.request, event.turnId), timelineEvent: { kind: "permission", request: event.request, turnId: event.turnId } };
    case "permission_resolved":
      return { list: removePermission(list, event.requestId), timelineEvent: { kind: "permission_resolved", requestId: event.requestId } };
    default:
      return { list };
  }
}
