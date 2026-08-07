// ProviderPopover：新建会话（draft）时选择 agent 的 chip + popover（DESIGN.md §5.2）
// 仅 draft 模式渲染：已建会话的 provider 不可切换（切 provider = 新建会话）

import { useRef } from "react";
import { AgentControlChip } from "./AgentControlChip.js";
import { PopoverShell } from "./PopoverShell.js";
import { providerMeta } from "../theme.js";

interface ProviderPopoverProps {
  providers: string[];
  currentProvider: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (provider: string) => void;
}

export function ProviderPopover(props: ProviderPopoverProps) {
  const { providers, currentProvider, open, onOpenChange, onPick } = props;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const meta = providerMeta(currentProvider);

  return (
    <>
      <AgentControlChip
        ref={anchorRef}
        surface="toolbar"
        open={open}
        icon={<span className="dotp" style={{ background: meta.color }} />}
        label={meta.name}
        onClick={() => onOpenChange(!open)}
        aria-label="选择 agent"
        title="选择 agent"
      />
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        placement="top-start"
        minWidth={200}
        ariaLabel="agent 选择"
      >
        <div className="popover-section">
          {providers.map((id) => {
            const m = providerMeta(id);
            const isSelected = id === currentProvider;
            return (
              <button
                key={id}
                type="button"
                className="popover-row"
                data-selected={isSelected ? "true" : undefined}
                onClick={() => {
                  onPick(id);
                  onOpenChange(false);
                }}
              >
                <span className="dotp" style={{ background: m.color }} />
                <span>{m.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverShell>
    </>
  );
}
