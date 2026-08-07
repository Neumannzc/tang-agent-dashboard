// Composer：输入区 + 底部 ComposerToolbar（DESIGN.md §5.2）
// draft 模式（session 为 stub）：textarea 可用，发首条消息时由 App 建会话

import { useEffect, useRef, useState } from "react";
import type { AgentMode, AgentModelDefinition, SessionSummary } from "@agent-console/protocol";
import { ComposerToolbar } from "./ComposerToolbar.js";

export function Composer(props: {
  session: SessionSummary | null;
  running: boolean;
  drafting: boolean;
  providers: string[];
  models: AgentModelDefinition[];
  modes: AgentMode[];
  currentModeId: string | null;
  defaultModeId?: string | null;
  focusSignal?: number;
  onPickProvider: (provider: string) => void;
  onPickModel: (modelId: string, defaultThinkingOptionId?: string) => void;
  onPickMode: (modeId: string) => void;
  onPickThinking: (thinkingOptionId: string | null) => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const {
    session,
    running,
    drafting,
    providers,
    models,
    modes,
    currentModeId,
    defaultModeId,
    focusSignal = 0,
    onPickProvider,
    onPickModel,
    onPickMode,
    onPickThinking,
    onSend,
    onInterrupt,
  } = props;
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // NewSessionRow click → focusSignal 自增 → 聚焦 composer
  useEffect(() => {
    if (focusSignal > 0) {
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

  const send = () => {
    if (!session || !text.trim() || running) {
      return;
    }
    onSend(text);
    setText("");
  };

  const placeholder = drafting
    ? "描述你想让 agent 做的事…（将新建会话）"
    : session
      ? "描述你想让 agent 做的事…"
      : "先新建或选择一个会话";

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder}
            value={text}
            disabled={!session}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <ComposerToolbar
            session={session}
            drafting={drafting}
            providers={providers}
            models={models}
            modes={modes}
            currentModeId={currentModeId}
            defaultModeId={defaultModeId}
            running={running}
            canSend={Boolean(session && text.trim())}
            onPickProvider={onPickProvider}
            onPickModel={onPickModel}
            onPickMode={onPickMode}
            onPickThinking={onPickThinking}
            onSend={send}
            onInterrupt={onInterrupt}
          />
        </div>
        <div className="hint" id="statusHint" />
      </div>
    </div>
  );
}
