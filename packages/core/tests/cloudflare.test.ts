import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cloudflareListZonesTool,
  cloudflareListDnsRecordsTool,
  cloudflareCreateDnsRecordTool,
  cloudflareDeleteDnsRecordTool,
  cloudflarePurgeCacheTool,
} from "../src/agent/tools/cloudflare.js";
import { makeCtx } from "./testUtils.js";

function envelope(result: unknown, success = true, errors: Array<{ code: number; message: string }> = []): Response {
  return new Response(JSON.stringify({ success, errors, result }), {
    status: success ? 200 : 400,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare tools — missing configuration", () => {
  it("fails clearly when CLOUDFLARE_API_TOKEN isn't configured", async () => {
    const ctx = makeCtx("/tmp", { config: { ...makeCtx("/tmp").config, cloudflareZoneId: "zone-1" } });
    await expect(cloudflareListZonesTool.run({}, ctx)).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it("fails clearly when no zoneId is given or configured for a zone-scoped tool", async () => {
    const ctx = makeCtx("/tmp", { config: { ...makeCtx("/tmp").config, cloudflareApiToken: "cfat_test" } });
    await expect(cloudflareListDnsRecordsTool.run({}, ctx)).rejects.toThrow(/CJW_CLOUDFLARE_ZONE_ID/);
  });
});

describe("Cloudflare tools — requests", () => {
  function configuredCtx() {
    return makeCtx("/tmp", {
      config: { ...makeCtx("/tmp").config, cloudflareApiToken: "cfat_test", cloudflareZoneId: "zone-default" },
    });
  }

  it("sends the bearer token and lists zones", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope([{ id: "zone-1", name: "example.com", status: "active" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudflareListZonesTool.run({}, configuredCtx());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones?per_page=20",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cfat_test" }) })
    );
    expect(result).toContain("zone-1 — example.com (active)");
  });

  it("reports an empty zone list clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(envelope([])));
    const result = await cloudflareListZonesTool.run({}, configuredCtx());
    expect(result).toMatch(/no zones/i);
  });

  it("lets an explicit zoneId argument override the configured default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope([]));
    vi.stubGlobal("fetch", fetchMock);

    await cloudflareListDnsRecordsTool.run({ zoneId: "zone-other" }, configuredCtx());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/zones/zone-other/dns_records"),
      expect.anything()
    );
  });

  it("treats success: false as a failure even on an HTTP 200, surfacing Cloudflare's own error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1003, message: "Invalid zone" }], result: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflareListZonesTool.run({}, configuredCtx())).rejects.toThrow(/1003.*Invalid zone/);
  });

  it("formats DNS records with type, name, target, proxied flag, and ttl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        envelope([{ id: "rec-1", type: "A", name: "www.example.com", content: "1.2.3.4", proxied: true, ttl: 300 }])
      )
    );
    const result = await cloudflareListDnsRecordsTool.run({}, configuredCtx());
    expect(result).toBe("rec-1 — A www.example.com → 1.2.3.4 (proxied) (ttl 300)");
  });

  it("creates a DNS record with sensible defaults for ttl/proxied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ id: "rec-new", type: "A", name: "app.example.com", content: "5.6.7.8" })
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(cloudflareCreateDnsRecordTool.requiresConfirmation).toBe(true);
    const result = await cloudflareCreateDnsRecordTool.run(
      { type: "A", name: "app.example.com", content: "5.6.7.8" },
      configuredCtx()
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-default/dns_records");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "A",
      name: "app.example.com",
      content: "5.6.7.8",
      ttl: 1,
      proxied: false,
    });
    expect(result).toContain("rec-new");
  });

  it("DELETEs the right record path for cloudflare_delete_dns_record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(null));
    vi.stubGlobal("fetch", fetchMock);

    expect(cloudflareDeleteDnsRecordTool.requiresConfirmation).toBe(true);
    const result = await cloudflareDeleteDnsRecordTool.run({ recordId: "rec-1" }, configuredCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-default/dns_records/rec-1");
    expect(init.method).toBe("DELETE");
    expect(result).toContain("rec-1");
  });

  it("purges everything by default, or specific files when urls are given", async () => {
    // A Response body can only be read once, so each call needs its own instance — reusing one
    // via mockResolvedValue would make the second .json() call fail silently (caught, then
    // treated as a missing envelope).
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(envelope({})));
    vi.stubGlobal("fetch", fetchMock);

    expect(cloudflarePurgeCacheTool.requiresConfirmation).toBe(true);
    await cloudflarePurgeCacheTool.run({}, configuredCtx());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      purge_everything: true,
    });

    await cloudflarePurgeCacheTool.run({ urls: ["https://example.com/a.js"] }, configuredCtx());
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      files: ["https://example.com/a.js"],
    });
  });

  it("marks read-only tools accordingly", () => {
    expect(cloudflareListZonesTool.readOnly).toBe(true);
    expect(cloudflareListZonesTool.requiresConfirmation).toBe(false);
    expect(cloudflareListDnsRecordsTool.readOnly).toBe(true);
  });
});
