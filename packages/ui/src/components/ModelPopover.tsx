import { useMemo, useRef, useState } from "react";
import type { AgentModelDefinition, SessionSummary } from "@agent-console/protocol";
import { AgentControlChip } from "./AgentControlChip.js";
import { PopoverShell } from "./PopoverShell.js";

const SEARCH_THRESHOLD = 6;

interface VendorGroup {
  vendor: string;
  models: AgentModelDefinition[];
}

function groupByVendor(models: AgentModelDefinition[]): VendorGroup[] {
  const byVendor = new Map<string, AgentModelDefinition[]>();
  for (const model of models) {
    const vendor = model.vendor ?? model.provider;
    const list = byVendor.get(vendor);
    if (list) {
      list.push(model);
    } else {
      byVendor.set(vendor, [model]);
    }
  }
  return [...byVendor.entries()]
    .map(([vendor, list]) => ({
      vendor,
      models: list
        .slice()
        .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id)),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

function matchQuery(model: AgentModelDefinition, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const label = (model.label ?? model.id).toLowerCase();
  const vendor = (model.vendor ?? model.provider).toLowerCase();
  const id = model.id.toLowerCase();
  const description = (model.description ?? "").toLowerCase();
  return (
    label.includes(q) ||
    vendor.includes(q) ||
    id.includes(q) ||
    description.includes(q)
  );
}

function SearchIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

interface ModelPopoverProps {
  session: SessionSummary | null;
  models: AgentModelDefinition[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (modelId: string, defaultThinkingOptionId?: string) => void;
  disabled?: boolean;
}

export function ModelPopover(props: ModelPopoverProps) {
  const { session, models, open, onOpenChange, onPick, disabled } = props;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => groupByVendor(models), [models]);
  const showSearch = models.length > SEARCH_THRESHOLD;

  const currentModel = session
    ? models.find((m) => m.id === session.model) ?? null
    : null;
  const chipLabel = currentModel
    ? currentModel.label ?? currentModel.id
    : session?.model ?? "默认模型";

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return grouped;
    }
    return grouped
      .map((group) => ({
        ...group,
        models: group.models.filter((m) => matchQuery(m, query)),
      }))
      .filter((group) => group.models.length > 0);
  }, [grouped, query]);

  return (
    <>
      <AgentControlChip
        ref={anchorRef}
        surface="toolbar"
        open={open}
        disabled={disabled || !session}
        label={chipLabel}
        onClick={() => {
          setQuery("");
          onOpenChange(!open);
        }}
        aria-label="选择模型"
      />
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        placement="top-start"
        minWidth={284}
        ariaLabel="模型选择"
      >
        {showSearch ? (
          <div className="popover-search">
            <SearchIcon />
            <input
              type="text"
              value={query}
              placeholder="搜索模型…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索模型"
            />
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <div
            className="popover-row"
            style={{
              color: "var(--text-faint)",
              cursor: "default",
              pointerEvents: "none",
            }}
          >
            {models.length === 0 ? "暂无可选模型" : "无匹配模型"}
          </div>
        ) : (
          filtered.map((group) => (
            <div key={group.vendor} className="popover-section">
              <div className="popover-group-label">{group.vendor}</div>
              {group.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="popover-row"
                  data-selected={m.id === session?.model ? "true" : undefined}
                  onClick={() => {
                    onPick(m.id, m.defaultThinkingOptionId);
                    onOpenChange(false);
                  }}
                >
                  <div>{m.label ?? m.id}</div>
                  {m.description ? (
                    <div className="popover-row-details">{m.description}</div>
                  ) : null}
                </button>
              ))}
            </div>
          ))
        )}
      </PopoverShell>
    </>
  );
}