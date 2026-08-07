// 回合编排：startTurn + 订阅事件 → 收集 timeline → 等终态（参考 Paseo provider-runner.ts）

import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "@agent-console/protocol";

export interface ProviderTurnRunner {
  startTurn: (prompt: AgentPromptInput, options?: AgentRunOptions) => Promise<{ turnId: string }>;
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
  getSessionId: () => string | Promise<string>;
}

export interface RunProviderTurnOptions extends ProviderTurnRunner {
  prompt: AgentPromptInput;
  runOptions?: AgentRunOptions;
}

export async function runProviderTurn({
  prompt,
  runOptions,
  startTurn,
  subscribe,
  getSessionId,
}: RunProviderTurnOptions): Promise<AgentRunResult> {
  const timeline: AgentTimelineItem[] = [];
  let finalText = "";
  let usage: AgentUsage | undefined;
  let turnId: string | null = null;
  const bufferedEvents: AgentStreamEvent[] = [];
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const processEvent = (event: AgentStreamEvent) => {
    if (settled) {
      return;
    }
    if (event.type === "timeline") {
      timeline.push(event.item);
      if (event.item.type === "assistant_message") {
        finalText = event.item.text;
      }
      return;
    }
    if (event.type === "turn_completed") {
      usage = event.usage;
      settled = true;
      resolveCompletion();
      return;
    }
    if (event.type === "turn_failed") {
      settled = true;
      rejectCompletion(new Error(event.error));
      return;
    }
    if (event.type === "turn_canceled") {
      settled = true;
      resolveCompletion();
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const unsubscribe = subscribe((event) => {
    if (!turnId) {
      bufferedEvents.push(event);
      return;
    }
    processEvent(event);
  });

  try {
    const result = await startTurn(prompt, runOptions);
    turnId = result.turnId;
    for (const event of bufferedEvents) {
      processEvent(event);
    }
    await completion;
  } finally {
    unsubscribe();
  }

  return {
    sessionId: await getSessionId(),
    finalText,
    usage,
    timeline,
  };
}
