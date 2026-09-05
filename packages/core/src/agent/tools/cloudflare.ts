import type { ToolContext, ToolDefinition } from "./types.js";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

function requireApiToken(ctx: ToolContext): string {
  if (!ctx.config.cloudflareApiToken) throw new Error("CLOUDFLARE_API_TOKEN isn't configured on this server.");
  return ctx.config.cloudflareApiToken;
}

function resolveZoneId(args: Record<string, unknown>, ctx: ToolContext): string {
  const zoneId = typeof args.zoneId === "string" && args.zoneId ? args.zoneId : ctx.config.cloudflareZoneId;
  if (!zoneId) {
    throw new Error(
      "No Cloudflare zone ID given and CJW_CLOUDFLARE_ZONE_ID isn't configured — pass zoneId explicitly " +
        "(cloudflare_list_zones will list the IDs for your domains)."
    );
  }
  return zoneId;
}

async function cloudflareFetch<T>(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => undefined)) as CloudflareEnvelope<T> | undefined;
  // Cloudflare's API can report success: false with a 200 status (e.g. a semantically invalid
  // request the endpoint still accepted), so check the envelope, not just res.ok.
  if (!res.ok || !data || !data.success) {
    const messages = data?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${messages}`);
  }
  return data.result;
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

export const cloudflareListZonesTool: ToolDefinition = {
  spec: {
    name: "cloudflare_list_zones",
    description: "List domains (zones) on the Cloudflare account, with their zone IDs and status.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max zones to return. Defaults to 20." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 20;
    const zones = await cloudflareFetch<CloudflareZone[]>(`/zones?per_page=${limit}`, token);
    if (!zones.length) return "(no zones found)";
    return zones.map((z) => `${z.id} — ${z.name} (${z.status})`).join("\n");
  },
};

export const cloudflareGetZoneTool: ToolDefinition = {
  spec: {
    name: "cloudflare_get_zone",
    description: "Get one Cloudflare zone's status and settings summary.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    const zone = await cloudflareFetch(`/zones/${zoneId}`, token);
    return JSON.stringify(zone, null, 2);
  },
};

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
}

export const cloudflareListDnsRecordsTool: ToolDefinition = {
  spec: {
    name: "cloudflare_list_dns_records",
    description: "List DNS records for a zone, optionally filtered by type and/or name.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
        type: { type: "string", description: "e.g. A, AAAA, CNAME, TXT, MX." },
        name: { type: "string", description: "Exact record name to filter by, e.g. www.example.com." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    const params = new URLSearchParams();
    if (typeof args.type === "string" && args.type) params.set("type", args.type);
    if (typeof args.name === "string" && args.name) params.set("name", args.name);
    const query = params.toString();
    const records = await cloudflareFetch<DnsRecord[]>(
      `/zones/${zoneId}/dns_records${query ? `?${query}` : ""}`,
      token
    );
    if (!records.length) return "(no matching DNS records)";
    return records
      .map((r) => `${r.id} — ${r.type} ${r.name} → ${r.content}${r.proxied ? " (proxied)" : ""} (ttl ${r.ttl})`)
      .join("\n");
  },
};

export const cloudflareCreateDnsRecordTool: ToolDefinition = {
  spec: {
    name: "cloudflare_create_dns_record",
    description: "Create a new DNS record in a zone.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
        type: { type: "string", description: "e.g. A, AAAA, CNAME, TXT, MX." },
        name: { type: "string", description: "Record name, e.g. www.example.com or @ for the root." },
        content: { type: "string", description: "Record value, e.g. an IP address or hostname." },
        ttl: { type: "number", description: "TTL in seconds. Defaults to 1 (Cloudflare's 'automatic')." },
        proxied: { type: "boolean", description: "Route through Cloudflare's proxy (orange-cloud). Defaults to false." },
      },
      required: ["type", "name", "content"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    const record = await cloudflareFetch<DnsRecord>(`/zones/${zoneId}/dns_records`, token, {
      method: "POST",
      body: {
        type: String(args.type),
        name: String(args.name),
        content: String(args.content),
        ttl: typeof args.ttl === "number" ? args.ttl : 1,
        proxied: Boolean(args.proxied),
      },
    });
    return `Created ${record.type} record ${record.id} — ${record.name} → ${record.content}`;
  },
};

export const cloudflareUpdateDnsRecordTool: ToolDefinition = {
  spec: {
    name: "cloudflare_update_dns_record",
    description: "Update an existing DNS record's content, TTL, or proxy status.",
    parameters: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "The DNS record ID (from cloudflare_list_dns_records)." },
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
        type: { type: "string", description: "e.g. A, AAAA, CNAME, TXT, MX." },
        name: { type: "string", description: "Record name, e.g. www.example.com." },
        content: { type: "string", description: "New record value." },
        ttl: { type: "number", description: "TTL in seconds." },
        proxied: { type: "boolean", description: "Route through Cloudflare's proxy (orange-cloud)." },
      },
      required: ["recordId", "type", "name", "content"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    const record = await cloudflareFetch<DnsRecord>(`/zones/${zoneId}/dns_records/${String(args.recordId)}`, token, {
      method: "PUT",
      body: {
        type: String(args.type),
        name: String(args.name),
        content: String(args.content),
        ttl: typeof args.ttl === "number" ? args.ttl : 1,
        proxied: Boolean(args.proxied),
      },
    });
    return `Updated ${record.type} record ${record.id} — ${record.name} → ${record.content}`;
  },
};

export const cloudflareDeleteDnsRecordTool: ToolDefinition = {
  spec: {
    name: "cloudflare_delete_dns_record",
    description: "Delete a DNS record.",
    parameters: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "The DNS record ID (from cloudflare_list_dns_records)." },
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
      },
      required: ["recordId"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    await cloudflareFetch(`/zones/${zoneId}/dns_records/${String(args.recordId)}`, token, { method: "DELETE" });
    return `Deleted DNS record ${String(args.recordId)}.`;
  },
};

export const cloudflarePurgeCacheTool: ToolDefinition = {
  spec: {
    name: "cloudflare_purge_cache",
    description: "Purge Cloudflare's cache for a zone — either everything, or a specific list of URLs.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "Defaults to CJW_CLOUDFLARE_ZONE_ID if omitted." },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Specific URLs to purge. Omit to purge everything for the zone.",
        },
      },
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireApiToken(ctx);
    const zoneId = resolveZoneId(args, ctx);
    const urls = Array.isArray(args.urls) ? args.urls.map(String) : undefined;
    await cloudflareFetch(`/zones/${zoneId}/purge_cache`, token, {
      method: "POST",
      body: urls?.length ? { files: urls } : { purge_everything: true },
    });
    return urls?.length ? `Purged cache for ${urls.length} URL(s).` : "Purged everything in this zone's cache.";
  },
};

export const cloudflareTools: ToolDefinition[] = [
  cloudflareListZonesTool,
  cloudflareGetZoneTool,
  cloudflareListDnsRecordsTool,
  cloudflareCreateDnsRecordTool,
  cloudflareUpdateDnsRecordTool,
  cloudflareDeleteDnsRecordTool,
  cloudflarePurgeCacheTool,
];
