/**
 * Serial async queue: runs tasks one at a time, in order.
 * Used to serialize VM command execution (v86 has one serial port).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get length(): number {
    return this.pending;
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending -= 1;
    });
  }

  async drain(): Promise<void> {
    while (this.pending > 0) {
      await this.tail;
    }
  }
}
