export type OutputConsumer<T> = (event: T) => Promise<void> | void;

type ConsumerState<T> = {
  consumer: OutputConsumer<T>;
  queue: T[];
  running: boolean;
  drainPromise: Promise<void> | null;
};

export class OutputQueue<T> {
  private consumers: ConsumerState<T>[] = [];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  addConsumer(consumer: OutputConsumer<T>): void {
    if (this.closed) {
      throw new Error("OutputQueue is closed");
    }
    this.consumers.push({
      consumer,
      queue: [],
      running: false,
      drainPromise: null,
    });
  }

  async put(event: T): Promise<void> {
    if (this.closed) {
      throw new Error("OutputQueue is closed");
    }

    for (const state of this.consumers) {
      state.queue.push(event);
      this.scheduleDrain(state);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = Promise.all(this.consumers.map((state) => state.drainPromise)).then(
      () => undefined,
    );
    return this.closePromise;
  }

  private scheduleDrain(state: ConsumerState<T>): void {
    if (state.running) {
      return;
    }

    state.running = true;
    state.drainPromise = this.drain(state);
  }

  private async drain(state: ConsumerState<T>): Promise<void> {
    try {
      while (state.queue.length > 0) {
        const event = state.queue.shift();
        if (event === undefined) {
          continue;
        }
        try {
          await state.consumer(event);
        } catch {
          // Consumer failures are isolated so other consumers keep draining.
        }
      }
    } finally {
      state.running = false;
      if (state.queue.length > 0 && !this.closed) {
        this.scheduleDrain(state);
      }
    }
  }
}
