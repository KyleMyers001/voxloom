type Listener = () => void;

const listeners = new Set<Listener>();
let openCount = 0;

export function beginModal(): () => void {
  openCount += 1;
  notify();
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    openCount = Math.max(0, openCount - 1);
    notify();
  };
}

export function hasOpenModal(): boolean {
  return openCount > 0;
}

export function subscribeModal(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => listener());
}
