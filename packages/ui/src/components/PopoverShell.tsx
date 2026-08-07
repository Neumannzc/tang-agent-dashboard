import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type PopoverPlacement = "bottom-start" | "top-start" | "bottom-end";

interface PopoverShellProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  onOpenChange: (open: boolean) => void;
  placement?: PopoverPlacement;
  minWidth?: number;
  ariaLabel?: string;
  children: ReactNode;
}

interface AnchoredRect {
  top: number;
  left: number;
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function reduceMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function computeRect(
  anchor: DOMRect,
  placement: PopoverPlacement,
  popoverHeight: number,
): AnchoredRect {
  const gap = 4;
  if (placement === "top-start") {
    return { top: anchor.top - popoverHeight - gap, left: anchor.left };
  }
  if (placement === "bottom-end") {
    return { top: anchor.bottom + gap, left: anchor.right - anchor.width };
  }
  return { top: anchor.bottom + gap, left: anchor.left };
}

export function PopoverShell(props: PopoverShellProps) {
  const {
    open,
    anchorRef,
    onOpenChange,
    placement = "bottom-start",
    minWidth = 200,
    ariaLabel,
    children,
  } = props;

  const popoverRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    popover.style.minWidth = `${Math.max(minWidth, anchorRect.width)}px`;
    popover.style.visibility = "hidden";
    popover.style.display = "block";
    const popoverHeight = popover.offsetHeight;
    popover.style.visibility = "";
    popover.style.display = "";

    const rect = computeRect(anchorRect, placement, popoverHeight);
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const popoverW = popover.offsetWidth;

    let top = rect.top;
    let left = rect.left;
    if (left + popoverW > viewportW - 8) {
      left = Math.max(8, viewportW - popoverW - 8);
    }
    if (left < 8) {
      left = 8;
    }
    if (placement === "top-start" && top < 8) {
      top = anchorRect.bottom + 4;
    }
    if (placement === "bottom-start" && top + popoverHeight > viewportH - 8) {
      const flippedTop = anchorRect.top - popoverHeight - 4;
      if (flippedTop >= 8) {
        top = flippedTop;
      }
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }, [open, anchorRef, placement, minWidth]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (previouslyFocused && previouslyFocused !== anchorRef.current) {
      restoreFocusRef.current = previouslyFocused;
    }
    const popover = popoverRef.current;
    if (popover) {
      const first = popover.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
      if (first) {
        first.focus();
      } else {
        popover.focus();
      }
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onOpenChange(false);
        return;
      }
      if (event.key === "Tab" && popover) {
        const focusable = Array.from(
          popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
        ).filter((el) => el.offsetParent !== null);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey) {
          if (active === first || !popover.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !popover.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => {
      document.removeEventListener("keydown", onKeydown, true);
      const restore = restoreFocusRef.current;
      if (restore && document.body.contains(restore)) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (restore.contains(range.commonAncestorContainer)) {
            requestAnimationFrame(() => {
              try {
                restore.focus();
              } catch {
                void 0;
              }
            });
            return;
          }
        }
        try {
          restore.focus();
        } catch {
          void 0;
        }
      }
      restoreFocusRef.current = null;
    };
  }, [open, onOpenChange, anchorRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let dismissed = false;
    const onPointerDown = (event: MouseEvent) => {
      if (dismissed) {
        return;
      }
      const popover = popoverRef.current;
      const anchor = anchorRef.current;
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (popover && popover.contains(target)) {
        return;
      }
      if (anchor && anchor.contains(target)) {
        return;
      }
      dismissed = true;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onOpenChange, anchorRef]);

  if (!open) {
    return null;
  }

  const motionDuration = reduceMotion() ? "60ms" : "150ms";

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="popover-shell"
      style={{
        position: "fixed",
        zIndex: 200,
        animation: `popover-in ${motionDuration} cubic-bezier(0.4, 0, 0.2, 1)`,
        outline: "none",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}