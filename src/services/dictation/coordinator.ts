export interface ProcessingSignal {
  readonly aborted: boolean;
  onAbort(callback: () => void): void;
}

interface Entry<Result> {
  controller: AbortController;
  execute: ((signal: ProcessingSignal) => Promise<Result>) | null;
  id: string;
  reject: (reason: unknown) => void;
  resolve: (result: Result) => void;
}

export interface ProcessingReservation<Result> {
  cancel(): void;
  id: string;
  submit(execute: (signal: ProcessingSignal) => Promise<Result>):
    Promise<Result>;
}

function signalFor(controller: AbortController): ProcessingSignal {
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    onAbort(callback) {
      controller.signal.addEventListener('abort', callback, { once: true });
    },
  };
}

export class DictationCoordinator<Result> {
  private active: Entry<Result> | null = null;
  private nextId = 1;
  private disposed = false;
  private readonly prefix: string;
  private readonly queue: Entry<Result>[] = [];

  constructor(
    private readonly capacity = 2,
    prefix = createRequestPrefix(),
  ) {
    this.prefix = prefix;
  }

  get admitted(): number {
    return this.queue.length;
  }

  reserve(): ProcessingReservation<Result> | null {
    if (this.disposed || this.queue.length >= this.capacity) return null;
    const controller = new AbortController();
    let entry: Entry<Result>;
    const promise = new Promise<Result>((resolve, reject) => {
      entry = {
        controller,
        execute: null,
        id: `${this.prefix}-${this.nextId++}`,
        reject,
        resolve,
      };
    });
    // Cancellation can happen before submit() exposes the promise.
    void promise.catch(() => undefined);
    this.queue.push(entry!);
    const cancel = () => this.cancel(entry!.id);
    return {
      cancel,
      id: entry!.id,
      submit: (execute) => {
        if (entry!.controller.signal.aborted) return promise;
        entry!.execute = execute;
        this.pump();
        return promise;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    // Remove queued entries first: cancelling an unsubmitted head must not
    // pump another job into execution during teardown.
    for (const entry of [...this.queue].reverse()) this.cancel(entry.id);
  }

  private cancel(id: string): void {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const entry = this.queue[index];
    entry.controller.abort();
    if (this.active === entry) {
      // Keep the active slot until teardown settles. Its finally block
      // advances FIFO only after the worker has been killed and reaped.
      return;
    }
    entry.reject(new DOMException('Dictation cancelled', 'AbortError'));
    this.queue.splice(index, 1);
    this.pump();
  }

  private pump(): void {
    const entry = this.queue[0];
    if (this.active !== null || !entry?.execute) return;
    this.active = entry;
    void entry.execute(signalFor(entry.controller))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (this.active !== entry) return;
        if (this.queue[0] === entry) this.queue.shift();
        this.active = null;
        this.pump();
      });
  }
}

let coordinatorInstance = 0;

function createRequestPrefix(): string {
  coordinatorInstance += 1;
  const instance = coordinatorInstance.toString(36);
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `dictation-${globalThis.crypto.randomUUID()}-${instance}`;
  }
  return [
    'dictation',
    Date.now().toString(36),
    instance,
  ].join('-');
}
