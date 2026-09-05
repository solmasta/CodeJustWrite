import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderGetServiceTool,
  renderListDeploysTool,
  renderUpdateEnvVarTool,
  renderTriggerDeployTool,
} from "../src/agent/tools/render.js";
import { makeCtx } from "./testUtils.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Render tools — missing configuration", () => {
  it("fails clearly when RENDER_API_KEY isn't configured", async () => {
    const ctx = makeCtx("/tmp", { config: { ...makeCtx("/tmp").config, renderServiceId: "srv-1" } });
    await expect(renderGetServiceTool.run({}, ctx)).rejects.toThrow(/RENDER_API_KEY/);
  });

  it("fails clearly when no serviceId is given or configured", async () => {
    const ctx = makeCtx("/tmp", { config: { ...makeCtx("/tmp").config, renderApiKey: "rnd_test" } });
    await expect(renderGetServiceTool.run({}, ctx)).rejects.toThrow(/CJW_RENDER_SERVICE_ID/);
  });
});

describe("Render tools — requests", () => {
  function configuredCtx() {
    return makeCtx("/tmp", {
      config: { ...makeCtx("/tmp").config, renderApiKey: "rnd_test", renderServiceId: "srv-default" },
    });
  }

  it("uses the configured serviceId and sends the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "srv-default", name: "my-app" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderGetServiceTool.run({}, configuredCtx());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.render.com/v1/services/srv-default",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer rnd_test" }) })
    );
    expect(result).toContain("my-app");
  });

  it("lets an explicit serviceId argument override the configured default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "srv-other" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderGetServiceTool.run({ serviceId: "srv-other" }, configuredCtx());

    expect(fetchMock).toHaveBeenCalledWith("https://api.render.com/v1/services/srv-other", expect.anything());
  });

  it("surfaces the API's error message and status code on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "service not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renderGetServiceTool.run({}, configuredCtx())).rejects.toThrow(/404.*service not found/);
  });

  it("summarizes a deploy list whether entries are wrapped in { deploy: ... } or not", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { deploy: { id: "dep-1", status: "live", createdAt: "2026-01-01T00:00:00Z" } },
        { id: "dep-2", status: "build_failed", createdAt: "2026-01-02T00:00:00Z" },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderListDeploysTool.run({}, configuredCtx());

    expect(result).toContain("dep-1 — live");
    expect(result).toContain("dep-2 — build_failed");
  });

  it("reports an empty deploy list clearly instead of an empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const result = await renderListDeploysTool.run({}, configuredCtx());
    expect(result).toMatch(/no deploys/i);
  });

  it("PUTs a URL-encoded key and JSON value for render_update_env_var", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: "MY VAR", value: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderUpdateEnvVarTool.run({ key: "MY VAR", value: "x" }, configuredCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.render.com/v1/services/srv-default/env-vars/MY%20VAR");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ value: "x" });
  });

  it("requires confirmation for mutating tools but not read-only ones", () => {
    expect(renderUpdateEnvVarTool.requiresConfirmation).toBe(true);
    expect(renderTriggerDeployTool.requiresConfirmation).toBe(true);
    expect(renderGetServiceTool.requiresConfirmation).toBe(false);
    expect(renderGetServiceTool.readOnly).toBe(true);
  });

  it("sends clearCache as the expected string enum for render_trigger_deploy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "dep-new", status: "created" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderTriggerDeployTool.run({ clearCache: true }, configuredCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ clearCache: "clear" });
    expect(result).toContain("dep-new");
  });
});
