import { useEffect, useRef, useState } from "react";

/**
 * Back-to-top rocket (NN/g guidelines): fixed bottom-right, appears only
 * after the page has scrolled about a screen and a half, scrolls the page
 * back to the top, hides again at the top.
 *
 * Most pages scroll the document itself (#root is min-height, nothing
 * viewport-locks), so the default target is the scrolling element. An
 * internal scroll container wins only when it can actually scroll — a
 * content-height section with `overflow-y: auto` must not hijack the
 * listener, which is exactly what broke the button on the detail page.
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

export const BackToTop = () => {
  const ref = useRef<HTMLButtonElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const container = findScrollParent(ref.current);
    const onScroll = () =>
      setShow(container ? container.scrollTop > 700 : window.scrollY > 700);
    if (container) {
      container.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      return () => container.removeEventListener("scroll", onScroll);
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
        const container = findScrollParent(ref.current);
        if (container) container.scrollTo({ top: 0, behavior: "smooth" });
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
