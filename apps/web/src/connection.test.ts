import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnection } from "./connection.js";

// A minimal, fully scriptable stand-in for the browser's WebSocket — createConnection only ever
// touches .readyState, .send(), .close(), and the four on* handlers, so that's all this needs.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test helpers, not part of the real WebSocket API.
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("createConnection reconnect attempt numbering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it(
    // Regression test for the "six identical 'Connection lost' bubbles" bug: the UI layer needs
    // a stable, monotonically increasing attempt number it can show progress with instead of a
    // bare "disconnected" status repeated with no way to tell whether it's still trying — this
    // asserts the numbering contract createConnection promises callers, independent of any DOM.
    "reports increasing 1-indexed attempt numbers across repeated failures, then resets to 0 on success",
    async () => {
      const calls: Array<[string, number, number]> = [];
      createConnection("session-1", { token: "t", serverUrl: "http://localhost:8787" } as never, (status, attempt, max) => {
        calls.push([status, attempt, max]);
      });

      expect(calls).toEqual([["connecting", 1, 10]]);

      // First attempt fails immediately (no open ever happened).
      FakeWebSocket.instances[0].simulateClose();
      expect(calls.at(-1)).toEqual(["disconnected", 1, 10]);

      // Advance past the backoff delay for attempt #2 to actually start.
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.at(-1)).toEqual(["reconnecting", 2, 10]);

      // Attempt #2 also fails.
      FakeWebSocket.instances[1].simulateClose();
      expect(calls.at(-1)).toEqual(["disconnected", 2, 10]);

      // Attempt #3 starts and this time succeeds.
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls.at(-1)).toEqual(["reconnecting", 3, 10]);
      FakeWebSocket.instances[2].simulateOpen();
      expect(calls.at(-1)).toEqual(["connected", 0, 10]);
    }
  );

  it("gives up and reports 'failed' once the reconnectAttempts counter reaches maxAttempts", async () => {
    const calls: Array<[string, number, number]> = [];
    createConnection("session-1", { token: "t", serverUrl: "http://localhost:8787" } as never, (status, attempt, max) => {
      calls.push([status, attempt, max]);
    });

    // The maxReconnectAttempts check happens against the pre-increment counter, so the 10th
    // failure still schedules one more try (attempt 11) — only that one failing actually gives up.
    for (let i = 0; i < 11; i++) {
      FakeWebSocket.instances[i].simulateClose();
      if (i < 10) await vi.advanceTimersByTimeAsync(31000); // always past maxDelay (30s + jitter)
    }

    expect(calls.at(-1)).toEqual(["failed", 10, 10]);
    // No further connection attempt should ever have been opened after giving up.
    expect(FakeWebSocket.instances.length).toBe(11);
  });
});
