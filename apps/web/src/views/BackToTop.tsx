import { useEffect, useRef, useState } from "react";

/**
 * Back-to-top rocket (NN/g guidelines): fixed bottom-right, appears only
 * after the page has scrolled about a screen and a half, scrolls the page
 * back to the top, hides again at the top.
 *
 * Scroll target, in order: the nearest ancestor container that can actually
 * scroll — a content-height section with `overflow-y: auto` must not hijack
 * the listener, which is exactly what broke the button on the detail page —
 * then the stage column on the sessions route (`main` is viewport-locked
 * there, so the document never scrolls and the column is the real scroller),
 * and finally the scrolling element. The component is keyed by route in App
 * so the resolution re-runs when the layout changes.
 */
const findScrollParent = (node: HTMLElement | null): HTMLElement | null => {
  let current = node?.parentElement ?? null;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    )
      return current;
    current = current.parentElement;
  }
  return null;
};

/* Matched without a scrollable check: before data arrives the stage can't
   scroll yet but is still the scroller once it fills. */
const stageScroller = () =>
  document.querySelector<HTMLElement>("main:not(.full) > section");

const resolveTarget = (node: HTMLElement | null): HTMLElement | null =>
  findScrollParent(node) ?? stageScroller();

export const BackToTop = () => {
  const ref = useRef<HTMLButtonElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const el = resolveTarget(ref.current);
      setShow(el ? el.scrollTop > 700 : window.scrollY > 700);
    };
    const el = resolveTarget(ref.current);
    if (el) {
      el.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      return () => el.removeEventListener("scroll", onScroll);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className={`back-top${show ? " show" : ""}`}
      aria-label="Back to top"
      title="Back to top"
      tabIndex={show ? 0 : -1}
      onClick={() => {
        const el = resolveTarget(ref.current);
        if (el) el.scrollTo({ top: 0, behavior: "smooth" });
        else
          document.scrollingElement?.scrollTo({ top: 0, behavior: "smooth" });
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 2.5c3.2 1.9 5 5.4 5 9.2l-2.4 2.4h-5.2L7 11.7c0-3.8 1.8-7.3 5-9.2Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M9.6 14.1 7.2 17l-2.7.6.9-2.7 2.8-2.4M14.4 14.1l2.4 2.9 2.7.6-.9-2.7-2.8-2.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle
          cx="12"
          cy="9.4"
          r="1.4"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
    </button>
  );
};
