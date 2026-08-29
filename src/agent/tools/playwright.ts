import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "./types.js";

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
      "(click/fill/waitForSelector/evaluate/goto), capture console errors, and save a screenshot. " +
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
  async run(args, ctx) {
    const { chromium } = await import("playwright");
    const url = String(args.url);
    const actions = (args.actions as BrowserAction[] | undefined) ?? [];
    const takeScreenshot = args.screenshot !== false;

    const browser = await chromium.launch({ executablePath: resolveExecutablePath() });
    const consoleMessages: string[] = [];
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
      if (takeScreenshot) {
        const dir = path.join(ctx.repoRoot, ".cjw", "screenshots");
        await fs.mkdir(dir, { recursive: true });
        screenshotPath = path.join(dir, `check-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      return [
        `Loaded ${url} — title: "${title}"`,
        screenshotPath ? `Screenshot saved to ${path.relative(ctx.repoRoot, screenshotPath)}` : null,
        consoleMessages.length ? `Console errors:\n${consoleMessages.join("\n")}` : "No console errors.",
      ]
        .filter(Boolean)
        .join("\n");
    } finally {
      await browser.close();
    }
  },
};
