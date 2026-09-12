import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

interface DialogProps {
  children: ReactNode;
  label: string;
  onClose: () => void;
  opener?: HTMLElement | null;
}

const selector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
].join(",");

export function Dialog({ children, label, onClose, opener }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(selector)?.focus();
    return () => opener?.focus();
  }, [opener]);

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => !element.hidden);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div
      aria-label={label}
      aria-modal="true"
      className="overlay"
      onKeyDown={handleKeyDown}
      role="dialog"
    >
      <div className="overlay__panel" ref={panel}>
        <button
          aria-label={`Close ${label}`}
          className="icon-btn modal-close"
          onClick={onClose}
        >
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
