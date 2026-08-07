// ComposerToolbar：Composer 卡内底部 40px 工具条（DESIGN.md §5.2）
// 一行承载：附件占位 + 三个互斥 popover 触发器（mode/model/thinking）+ 发送/中断
// 互斥状态由 openSelector 统一管理（对齐 paseo 模式），同一时间只开一个

import { useState } from "react";
import type {
  AgentMode,
  AgentModelDefinition,
  SessionSummary,
} from "@agent-console/protocol";
import { ModePopover } from "./ModePopover.js";
import { ModelPopover } from "./ModelPopover.js";
import { ThinkingPopover } from "./ThinkingPopover.js";

type Selector = "model" | "mode" | "thinking" | null;

function SendIcon() {
  return (
    <svg className="icon" style={{ width: 15, height: 15 }} viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon" style={{ width: 14, height: 14 }} viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

interface ComposerToolbarProps {
  /** 激活会话；draft 模式下传入 draft session stub（sessionId: "draft"） */
  session: SessionSummary | null;
  models: AgentModelDefinition[];
  modes: AgentMode[];
  currentModeId: string | null;
  defaultModeId?: string | null;
  running: boolean;
  canSend: boolean;
  onPickModel: (modelId: string, defaultThinkingOptionId?: string) => void;
  onPickMode: (modeId: string) => void;
  onPickThinking: (thinkingOptionId: string | null) => void;
  onSend: () => void;
  onInterrupt: () => void;
}

export function ComposerToolbar(props: ComposerToolbarProps) {
  const {
    session,
    models,
    modes,
    currentModeId,
    defaultModeId = null,
    running,
    canSend,
    onPickModel,
    onPickMode,
    onPickThinking,
    onSend,
    onInterrupt,
  } = props;
  const [openSelector, setOpenSelector] = useState<Selector>(null);

  const currentModel = session
    ? models.find((m) => m.id === session.model) ?? null
    : null;

  // running 时仅禁用 chips（chip:disabled 自带 opacity 0.4），中断按钮必须保持可用
  return (
    <div className="composer-toolbar">
      <button
        className="c-icon"
        title="附件（本期不做）"
        disabled={running || !session}
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <ModePopover
        session={session}
        modes={modes}
        currentModeId={currentModeId}
        defaultModeId={defaultModeId}
        open={openSelector === "mode"}
        onOpenChange={(open) => setOpenSelector(open ? "mode" : null)}
        onPick={onPickMode}
        disabled={running || !session}
      />
      <ModelPopover
        session={session}
        models={models}
        open={openSelector === "model"}
        onOpenChange={(open) => setOpenSelector(open ? "model" : null)}
        onPick={onPickModel}
        disabled={running}
      />
      <ThinkingPopover
        session={session}
        currentModel={currentModel}
        open={openSelector === "thinking"}
        onOpenChange={(open) => setOpenSelector(open ? "thinking" : null)}
        onPick={onPickThinking}
        disabled={running}
      />
      <span className="grow" />
      <span className="composer-hint">Ctrl+Enter 发送</span>
      {running ? (
        <button
          className="send"
          title="中断"
          onClick={onInterrupt}
          style={{
            background: "var(--surface-layer-02)",
            color: "var(--text-muted)",
          }}
        >
          <StopIcon />
        </button>
      ) : (
        <button
          className="send"
          title="发送"
          onClick={onSend}
          disabled={!canSend}
        >
          <SendIcon />
        </button>
      )}
    </div>
  );
}
