import { forwardRef, type ButtonHTMLAttributes } from "react";

export type AgentChipSurface = "toolbar" | "ghost-muted" | "ghost-dim";

interface AgentControlChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  surface?: AgentChipSurface;
  active?: boolean;
  open?: boolean;
  icon?: React.ReactNode;
  label?: React.ReactNode;
  caret?: boolean;
  keybindHint?: string;
}

const SURFACE_CLASS: Record<AgentChipSurface, string> = {
  toolbar: "chip-surface-toolbar",
  "ghost-muted": "chip-surface-ghost-muted",
  "ghost-dim": "chip-surface-ghost-dim",
};

export const AgentControlChip = forwardRef<
  HTMLButtonElement,
  AgentControlChipProps
>(function AgentControlChip(props, ref) {
  const {
    surface = "toolbar",
    active = false,
    open = false,
    icon,
    label,
    caret = true,
    keybindHint,
    className,
    disabled,
    children,
    ...rest
  } = props;

  const composedClass = [
    "chip",
    SURFACE_CLASS[surface],
    active ? "chip-active" : "",
    open ? "chip-open" : "",
    disabled ? "chip-disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      className={composedClass}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={keybindHint}
      title={keybindHint ? `${keybindHint}` : undefined}
      disabled={disabled}
      {...rest}
    >
      {icon ? <span className="chip-icon">{icon}</span> : null}
      {label != null ? (
        <span className="chip-label">{label}</span>
      ) : null}
      {caret ? (
        <svg
          className="icon chip-caret"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      ) : null}
      {children}
    </button>
  );
});