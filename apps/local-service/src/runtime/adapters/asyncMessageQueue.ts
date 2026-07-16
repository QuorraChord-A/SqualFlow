export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly messages: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(message: T) {
    if (this.closed) throw new Error("Runtime input stream is closed");
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
      return;
    }
    this.messages.push(message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
