import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "../src/agent/tools/types.js";
import type { CjwConfig } from "../src/config/config.js";

// vi.mock factories are hoisted above imports, so shared mutable state used inside one has to go
// through vi.hoisted — this fakes just enough of Playwright's Browser/Page surface for
// runBrowserCheck, with `evaluate` able to hang forever (as it does with no timeout of its own in
// the real tool) until the fake browser is "closed", the same way a real Playwright page's
// pending call rejects once its browser process is killed out from under it.
const { launch, closeMock, setEvaluateBehavior } = vi.hoisted(() => {
  let rejectEvaluate: ((e: unknown) => void) | null = null;
  let evaluateBehavior: "hang" | "resolve" = "hang";

  const fakePage = {
    on: () => {},
    goto: async () => undefined,
    click: async () => undefined,
    fill: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: () =>
      evaluateBehavior === "resolve"
        ? Promise.resolve(undefined)
        : new Promise((_, reject) => {
            rejectEvaluate = reject;
          }),
    title: async () => "Test Page",
    screenshot: async () => undefined,
  };

  const closeMock = vi.fn(async () => {
    if (rejectEvaluate) {
      const reject = rejectEvaluate;
      rejectEvaluate = null;
      reject(new Error("Target page, context or browser has been closed"));
    }
  });

  const fakeBrowser = { newPage: async () => fakePage, close: closeMock };
  const launch = vi.fn(async () => fakeBrowser);

  return {
    launch,
    closeMock,
    setEvaluateBehavior: (b: "hang" | "resolve") => {
      evaluateBehavior = b;
    },
  };
});

vi.mock("playwright", () => ({ chromium: { launch } }));

function makeCtx(): ToolContext {
  return {
    repoRoot: "/tmp/cjw-playwright-test",
    config: {} as CjwConfig,
    confirm: async () => true,
    log: () => {},
  };
}

describe("browser_check", () => {
  beforeEach(() => {
    closeMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-closes and reports a clear error when an action never returns", async () => {
    const { browserCheckTool } = await import("../src/agent/tools/playwright.js");
    setEvaluateBehavior("hang");
    vi.useFakeTimers();

    const runPromise = browserCheckTool.run(
      { url: "http://localhost:3000", actions: [{ type: "evaluate", script: "while(true){}" }] },
      makeCtx()
    );

    // The call is wrapped in the module's chromiumLock mutex and a dynamic import of "playwright",
    // so its body (including the watchdog's own setTimeout) only starts running several microtask
    // ticks later — drain those before advancing the fake clock, or there's no timer registered
    // yet to fire. Generous iteration count since each tick is a no-op once things settle.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }

    const assertion = expect(runPromise).rejects.toThrow(/timed out after 90s/);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;

    expect(closeMock).toHaveBeenCalled();
  }, 10_000);

  it("resolves normally, and only closes once, when nothing hangs", async () => {
    const { browserCheckTool } = await import("../src/agent/tools/playwright.js");
    setEvaluateBehavior("resolve");

    const result = await browserCheckTool.run(
      { url: "http://localhost:3000", actions: [{ type: "evaluate", script: "1+1" }], screenshot: false },
      makeCtx()
    );

    expect(typeof result === "string" ? result : result.text).toContain("Test Page");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
