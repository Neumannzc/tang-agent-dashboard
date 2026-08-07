import { useRef } from "react";
import type { AgentMode, SessionSummary } from "@agent-console/protocol";
import { AgentControlChip } from "./AgentControlChip.js";
import { PopoverShell } from "./PopoverShell.js";

type ModeTint = "plan" | "default" | "custom";

interface ModePopoverProps {
  session: SessionSummary | null;
  modes: AgentMode[];
  currentModeId: string | null;
  defaultModeId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (modeId: string) => void;
  disabled?: boolean;
}

function classifyTint(modeId: string | null): ModeTint {
  if (!modeId) {
    return "default";
  }
  if (
    modeId === "plan" ||
    modeId.endsWith("#plan") ||
    modeId.endsWith("-plan")
  ) {
    return "plan";
  }
  if (
    modeId === "build" ||
    modeId === "default" ||
    modeId === "normal"
  ) {
    return "default";
  }
  return "custom";
}

function modeIcon(tint: ModeTint) {
  if (tint === "plan") {
    return (
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    );
  }
  if (tint === "custom") {
    return (
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      </svg>
    );
  }
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m4.5 12.5 3 3 12-12" />
    </svg>
  );
}

export function ModePopover(props: ModePopoverProps) {
  const {
    session,
    modes,
    currentModeId,
    defaultModeId,
    open,
    onOpenChange,
    onPick,
    disabled,
  } = props;
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (modes.length === 0 || !session) {
    return null;
  }

  const activeId = currentModeId ?? defaultModeId ?? null;
  const tint = classifyTint(activeId);
  const activeMode = modes.find((m) => m.id === activeId) ?? null;
  const chipLabel = activeMode?.label ?? "模式";

  return (
    <>
      <AgentControlChip
        ref={anchorRef}
        surface="toolbar"
        open={open}
        disabled={disabled}
        icon={modeIcon(tint)}
        label={chipLabel}
        onClick={() => onOpenChange(!open)}
        aria-label="切换 agent 模式"
        data-mode-tint={tint}
      />
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        placement="top-start"
        minWidth={220}
        ariaLabel="agent 模式选择"
      >
        <div className="popover-section">
          {modes.map((mode) => {
            const isSelected = mode.id === activeId;
            const isDefault = mode.id === defaultModeId;
            return (
              <button
                key={mode.id}
                type="button"
                className="popover-row"
                data-selected={isSelected ? "true" : undefined}
                onClick={() => {
                  onPick(mode.id);
                  onOpenChange(false);
                }}
              >
                <div>
                  {mode.label}
                  {isDefault ? (
                    <span className="popover-row-tag">默认</span>
                  ) : null}
                </div>
                {mode.description ? (
                  <div className="popover-row-details">{mode.description}</div>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverShell>
    </>
  );
}