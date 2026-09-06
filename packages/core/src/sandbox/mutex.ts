/**
 * A single-slot async mutex — at most one holder of `run` executes at a time, process-wide;
 * everyone else queues in call order. Used to cap headless-Chromium concurrency (see
 * browserCheckTool): each launch needs 150-300MB that Node's own memory accounting never sees
 * (it's a separate OS process), and with multiple concurrent PWA sessions there's otherwise no
 * limit on how many could pile up at once on a memory-constrained container. `isolatedResource`
 * already caps concurrency to one per *batch* within a single session's own turn — this caps it
 * to one *server-wide*, across every session.
 */
export function createMutex(): { run: <T>(fn: () => Promise<T>) => Promise<T> } {
  let queue: Promise<void> = Promise.resolve();

  function run<T>(fn: () => Promise<T>): Promise<T> {
    const acquired = queue.then(fn, fn);
    // Chain the next waiter off this call's settlement, not its result — a rejected fn() must
    // still release the lock for whoever's next, rather than leaving the queue stuck forever.
    queue = acquired.then(
      () => undefined,
      () => undefined
    );
    return acquired;
  }

  return { run };
}
