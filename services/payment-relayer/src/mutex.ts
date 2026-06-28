/**
 * FIFO async mutex. `run(fn)` executes the provided async functions one at a
 * time, in the order run() was called. The lock is released whether fn resolves
 * or rejects, so a failure never blocks the queue; the real result/error of each
 * fn still propagates to its own caller.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Advance the chain; swallow errors here so one failure doesn't poison the queue.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
