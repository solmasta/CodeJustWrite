import { describe, it, expect } from "vitest";
import { createMutex } from "../src/sandbox/mutex.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMutex", () => {
  it("runs a single task and returns its result", async () => {
    const mutex = createMutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes two overlapping tasks — the second never starts before the first finishes", async () => {
    const mutex = createMutex();
    const events: string[] = [];
    const first = deferred<void>();

    const taskA = mutex.run(async () => {
      events.push("A start");
      await first.promise;
      events.push("A end");
    });
    // Give taskA a tick to actually start before queuing B, so this isn't just testing
    // synchronous call order.
    await Promise.resolve();
    const taskB = mutex.run(async () => {
      events.push("B start");
    });

    // B must not have started yet — A is still awaiting `first`.
    expect(events).toEqual(["A start"]);

    first.resolve();
    await Promise.all([taskA, taskB]);

    expect(events).toEqual(["A start", "A end", "B start"]);
  });

  it("releases the lock for the next task even when the current one rejects", async () => {
    const mutex = createMutex();
    const failing = mutex.run(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    // If the failure didn't release the lock, this would hang forever.
    const result = await mutex.run(async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("runs many queued tasks in call order, one at a time", async () => {
    const mutex = createMutex();
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = [1, 2, 3, 4, 5].map((n) =>
      mutex.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 1));
        order.push(n);
        concurrent--;
      })
    );

    await Promise.all(tasks);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
