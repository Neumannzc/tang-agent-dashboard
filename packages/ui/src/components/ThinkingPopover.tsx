import { useRef } from "react";
import type {
  AgentModelDefinition,
  AgentSelectOption,
  SessionSummary,
} from "@agent-console/protocol";
import { AgentControlChip } from "./AgentControlChip.js";
import { PopoverShell } from "./PopoverShell.js";

function BrainIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-3 3v3a3 3 0 0 0 3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0 3-3v-3a3 3 0 0 0-3-3 3 3 0 0 0-3-3Z" />
      <path d="M12 5v14" />
    </svg>
  );
}

interface ThinkingPopoverProps {
  session: SessionSummary | null;
  currentModel: AgentModelDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (thinkingOptionId: string | null) => void;
  disabled?: boolean;
}

export function ThinkingPopover(props: ThinkingPopoverProps) {
  const { session, currentModel, open, onOpenChange, onPick, disabled } = props;
  const anchorRef = useRef<HTMLButtonElement>(null);

  const options: AgentSelectOption[] = currentModel?.thinkingOptions ?? [];
  const defaultOptionId = currentModel?.defaultThinkingOptionId;
  const selectedId = session?.thinkingOptionId ?? defaultOptionId ?? null;

  if (options.length <= 1) {
    return null;
  }

  const selectedOption = options.find((o) => o.id === selectedId) ?? null;
  const chipLabel = selectedOption?.label ?? "强度";
  const usingDefault = selectedId === defaultOptionId;

  return (
    <>
      <AgentControlChip
        ref={anchorRef}
        surface={usingDefault ? "ghost-muted" : "toolbar"}
        open={open}
        disabled={disabled || !session}
        icon={<BrainIcon />}
        label={chipLabel}
        onClick={() => onOpenChange(!open)}
        aria-label="选择推理强度"
      />
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        placement="top-start"
        minWidth={200}
        ariaLabel="推理强度选择"
      >
        <div className="popover-section">
          {options.map((option) => {
            const isSelected = option.id === selectedId;
            const isDefault = option.id === defaultOptionId;
            return (
              <button
                key={option.id}
                type="button"
                className="popover-row"
                data-selected={isSelected ? "true" : undefined}
                onClick={() => {
                  onPick(isDefault ? null : option.id);
                  onOpenChange(false);
                }}
              >
                <div>
                  {option.label}
                  {isDefault ? (
                    <span className="popover-row-tag">默认</span>
                  ) : null}
                </div>
                {option.description ? (
                  <div className="popover-row-details">
                    {option.description}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverShell>
    </>
  );
}