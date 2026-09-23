/**
 * Global concurrency limiter for engine checks.
 *
 * The engine accepts many jobs at once, but each one is an expensive AI run;
 * this caps how many may be in flight and lets queued callers report their
 * position while they wait.
 */
export class CheckQueue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.pending = [];
    this.activeIds = new Set();
    this.seq = 0;
  }

  get active() {
    return this.activeIds.size;
  }

  get waiting() {
    return this.pending.length;
  }

  get size() {
    return this.active + this.waiting;
  }

  #emitPositions() {
    const total = this.active + this.pending.length;
    this.pending.forEach((item, index) => {
      try {
        item.onState?.({ state: 'waiting', position: this.active + index + 1, total });
      } catch {
        /* UI callbacks are best-effort */
      }
    });
  }

  /**
   * Queue `run` and return `{ id, promise }`. `onState` is called with
   * `{ state: 'waiting', position, total }` on every queue change while the
   * item waits, then once with `{ state: 'running' }` when it starts.
   */
  enqueue(run, { onState } = {}) {
    const item = { id: ++this.seq, run, onState, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    this.pending.push(item);
    this.#emitPositions();
    this.#pump();
    return { id: item.id, promise };
  }

  #pump() {
    while (this.activeIds.size < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      this.activeIds.add(item.id);
      this.#emitPositions();
      try {
        item.onState?.({ state: 'running' });
      } catch {
        /* ignore */
      }
      Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeIds.delete(item.id);
          this.#emitPositions();
          this.#pump();
        });
    }
  }
}
