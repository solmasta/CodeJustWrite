import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createMutex } from "../../sandbox/mutex.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

// One headless Chromium at a time, server-wide — every PWA session shares this one process, and
// each launch needs 150-300MB that Node's own memory accounting never sees (a separate OS
// process). `isolatedResource` below already caps concurrency to one per batch within a single
// turn, but says nothing about two different sessions each calling this around the same time;
// without a process-wide cap, those launches can stack and push a memory-constrained container
// over its limit even though each individual instance closes cleanly on its own.
const chromiumLock = createMutex();

// Above this, skip attaching the screenshot as an image (still saved to disk) rather than risk
// a request a vision model's own size limit would reject outright.
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

// page.goto and click/fill/waitForSelector each have their own timeout below, but page.evaluate
// does not — an `evaluate` script that hangs (or a page with a runaway memory leak an action just
// sits and waits on) can hold this open indefinitely. Since the whole call runs inside
// chromiumLock, that also wedges every other session's browser_check behind it, and the leaking
// Chromium process's memory (invisible to Node's own accounting, same as the mutex's own
// reasoning) climbs until the container gets OOM-killed — taking down every active session, not
// just this one. This is a hard ceiling on the entire call so one bad page can't do that.
const OVERALL_TIMEOUT_MS = 90_000;

/**
 * Some pre-provisioned sandboxes ship a browser build pinned to a different
 * Playwright version than this project depends on, exposed via a stable
 * `$PLAYWRIGHT_BROWSERS_PATH/chromium` symlink. Prefer that when present so
 * launches don't fail on a version mismatch; otherwise let Playwright
 * resolve (and, on a normal machine, download) its own managed browser.
 */
function resolveExecutablePath(): string | undefined {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) return undefined;
  const candidate = path.join(browsersPath, "chromium");
  return existsSync(candidate) ? candidate : undefined;
}

interface BrowserAction {
  type: "click" | "fill" | "waitForSelector" | "evaluate" | "goto";
  selector?: string;
  value?: string;
  script?: string;
}

export const browserCheckTool: ToolDefinition = {
  spec: {
    name: "browser_check",
    description:
      "Drive a headless Chromium browser (via Playwright) to a URL, optionally perform a sequence of actions " +
      "(click/fill/waitForSelector/evaluate/goto), capture console errors, and save a screenshot. The " +
      "screenshot is also shown to you directly (vision-capable models only) so you can actually see " +
      "layout/styling bugs a console-error check alone would miss — not just its file path. " +
      "Use this to visually verify a web UI change actually works, e.g. against a locally running dev server.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to load first, e.g. http://localhost:3000." },
        actions: {
          type: "array",
          description: "Ordered actions to perform after loading the page.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["click", "fill", "waitForSelector", "evaluate", "goto"] },
              selector: { type: "string", description: "CSS selector, for click/fill/waitForSelector." },
              value: { type: "string", description: "Text to type, for fill. Or URL, for goto." },
              script: { type: "string", description: "JS expression to evaluate in the page, for evaluate." },
            },
            required: ["type"],
          },
        },
        screenshot: { type: "boolean", description: "Capture a final screenshot. Defaults to true." },
      },
      required: ["url"],
    },
  },
  requiresConfirmation: false,
  isolatedResource: true,
  run(args, ctx) {
    return chromiumLock.run(() => runBrowserCheck(args, ctx));
  },
};

async function runBrowserCheck(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolResult> {
  const { chromium } = await import("playwright");
  const url = String(args.url);
  const actions = (args.actions as BrowserAction[] | undefined) ?? [];
  const takeScreenshot = args.screenshot !== false;

  const browser = await chromium.launch({ executablePath: resolveExecutablePath() });
  const consoleMessages: string[] = [];

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, OVERALL_TIMEOUT_MS);

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleMessages.push(`[console.error] ${msg.text()}`);
    });
    page.on("pageerror", (err) => consoleMessages.push(`[pageerror] ${err.message}`));

    await page.goto(url, { waitUntil: "load", timeout: 30_000 });

    for (const action of actions) {
      switch (action.type) {
        case "goto":
          await page.goto(String(action.value), { waitUntil: "load", timeout: 30_000 });
          break;
        case "click":
          await page.click(String(action.selector), { timeout: 10_000 });
          break;
        case "fill":
          await page.fill(String(action.selector), String(action.value ?? ""), { timeout: 10_000 });
          break;
        case "waitForSelector":
          await page.waitForSelector(String(action.selector), { timeout: 10_000 });
          break;
        case "evaluate":
          await page.evaluate(String(action.script));
          break;
      }
    }

    const title = await page.title();
    let screenshotPath: string | null = null;
    let imageDataUrl: string | null = null;
    if (takeScreenshot) {
      const dir = path.join(ctx.repoRoot, ".cjw", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      screenshotPath = path.join(dir, `check-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const bytes = await fs.readFile(screenshotPath);
      if (bytes.byteLength <= MAX_SCREENSHOT_BYTES) {
        imageDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
      }
    }

    const text = [
      `Loaded ${url} — title: "${title}"`,
      screenshotPath ? `Screenshot saved to ${path.relative(ctx.repoRoot, screenshotPath)}` : null,
      consoleMessages.length ? `Console errors:\n${consoleMessages.join("\n")}` : "No console errors.",
      takeScreenshot && !imageDataUrl
        ? "(Screenshot too large to show directly — inspect the saved file instead.)"
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const result: ToolResult = { text };
    if (imageDataUrl) result.images = [imageDataUrl];
    return result;
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `browser_check timed out after ${OVERALL_TIMEOUT_MS / 1000}s (an action — most likely "evaluate" — never returned) and was force-closed.`
      );
    }
    throw err;
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }
}
