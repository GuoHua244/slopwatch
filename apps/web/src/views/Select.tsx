import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption = { value: string; label: string };

type SelectProps = {
  /** The controlled selection ("" is a legal value — the unassigned bucket). */
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Accessible name wired through trigger and popup. */
  label: string;
  className?: string;
};

/**
 * The themed dropdown. Native <select> popups render in OS chrome that
 * nothing in the dark theme can reach, so the trigger is a button and the
 * option list is a portalled listbox pinned to it — outside click, Escape,
 * scroll, and resize all dismiss it, arrows walk the options, and the
 * whole thing stays inside the app's visual language.
 */
export const Select = ({
  value,
  onChange,
  options,
  label,
  className,
}: SelectProps) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    minWidth: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-listbox`;

  const selected = options.findIndex((o) => o.value === value);
  const currentLabel = selected >= 0 ? options[selected]!.label : "—";

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const flip = below < 140 && r.top - 8 > below;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
      minWidth: r.width,
      maxHeight: Math.min(300, flip ? r.top - 12 : below),
      ...(flip
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    });
  };

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const openPopup = () => {
    setActive(selected >= 0 ? selected : 0);
    place();
    setOpen(true);
  };

  // Fresh geometry + popup focus on open; Escape and outside clicks dismiss.
  // Scroll/resize re-anchor the popup to the trigger instead of closing —
  // embedded browsers fire same-size resizes on their own, and a menu that
  // vanishes on those reads as broken. Only the trigger leaving the viewport
  // (its column scrolled away) closes it.
  useLayoutEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      )
        close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onMove = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) close();
      else place();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  // The window-level Escape handler above runs while open; this one keeps
  // the trigger keyboard-driven (Enter/Space/Arrows open like a select).
  const triggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      openPopup();
    }
  };

  const popKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + delta + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[active];
      if (option) {
        onChange(option.value);
        close(true);
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  const pick = (option: SelectOption) => {
    onChange(option.value);
    close(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : openPopup())}
        onKeyDown={triggerKeyDown}
      >
        <span>{currentLabel}</span>
        <svg
          className="caret"
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          aria-hidden
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${id}-opt-${active}`}
            className="select-pop"
            style={{
              left: pos?.left,
              minWidth: pos?.minWidth,
              maxHeight: pos?.maxHeight,
              top: pos?.top,
              bottom: pos?.bottom,
            }}
            tabIndex={-1}
            onKeyDown={popKeyDown}
          >
            {options.map((option, i) => (
              <div
                key={option.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === selected}
                className={`select-opt${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(option)}
              >
                <svg
                  className="check"
                  width="10"
                  height="10"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M2 6.5 4.8 9 10 3.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {option.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
};
