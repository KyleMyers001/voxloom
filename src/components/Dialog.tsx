import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";

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
    const root = document.querySelector<HTMLElement>("#root");
    const wasHidden = root?.getAttribute("aria-hidden");
    const wasInert = root?.inert ?? false;
    if (root) {
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
    }
    panel.current?.querySelector<HTMLElement>(selector)?.focus();
    return () => {
      if (root) {
        root.inert = wasInert;
        if (wasHidden === null) root.removeAttribute("aria-hidden");
        else root.setAttribute("aria-hidden", wasHidden ?? "true");
      }
      opener?.focus();
    };
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

  return createPortal(
    <div
      aria-label={label}
      aria-modal="true"
      className="overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
    >
      <div className="overlay__panel" onMouseDown={(event) =>
        event.stopPropagation()} ref={panel}>
        <button
          aria-label={`Close ${label}`}
          className="icon-btn modal-close"
          onClick={onClose}
        >
          ×
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
