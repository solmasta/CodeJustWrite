import type { ToolContext, ToolDefinition } from "./types.js";

const RENDER_API = "https://api.render.com/v1";

function resolveServiceId(args: Record<string, unknown>, ctx: ToolContext): string {
  const serviceId = typeof args.serviceId === "string" && args.serviceId ? args.serviceId : ctx.config.renderServiceId;
  if (!serviceId) {
    throw new Error(
      "No Render service ID given and CJW_RENDER_SERVICE_ID isn't configured — pass serviceId explicitly."
    );
  }
  return serviceId;
}

function requireApiKey(ctx: ToolContext): string {
  if (!ctx.config.renderApiKey) throw new Error("RENDER_API_KEY isn't configured on this server.");
  return ctx.config.renderApiKey;
}

async function renderFetch(
  path: string,
  apiKey: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const res = await fetch(`${RENDER_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "object" && data && "message" in data ? (data as { message: unknown }).message : data;
    throw new Error(`Render API error (${res.status}): ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return data;
}

export const renderGetServiceTool: ToolDefinition = {
  spec: {
    name: "render_get_service",
    description:
      "Get a Render service's current state — name, plan, region, suspended status, auto-deploy branch, and URL.",
    parameters: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const data = await renderFetch(`/services/${serviceId}`, apiKey);
    return JSON.stringify(data, null, 2);
  },
};

interface RenderDeploy {
  id: string;
  status: string;
  createdAt?: string;
  finishedAt?: string;
  commit?: { id?: string; message?: string };
  trigger?: string;
}

function summarizeDeployList(data: unknown): string {
  const items = Array.isArray(data) ? data : [];
  if (!items.length) return "(no deploys found)";
  return items
    .map((item) => {
      // Render's list endpoints wrap each entry as { deploy: {...}, cursor: "..." }.
      const deploy = (item as { deploy?: RenderDeploy }).deploy ?? (item as RenderDeploy);
      const commitMsg = deploy.commit?.message?.split("\n")[0];
      return `${deploy.id} — ${deploy.status}${deploy.trigger ? ` (${deploy.trigger})` : ""} — ${deploy.createdAt ?? "?"}${commitMsg ? ` — ${commitMsg}` : ""}`;
    })
    .join("\n");
}

export const renderListDeploysTool: ToolDefinition = {
  spec: {
    name: "render_list_deploys",
    description: "List recent deploys for a Render service — status, trigger, commit, and timestamps.",
    parameters: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
        limit: { type: "number", description: "Max deploys to return. Defaults to 10." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 10;
    const data = await renderFetch(`/services/${serviceId}/deploys?limit=${limit}`, apiKey);
    return summarizeDeployList(data);
  },
};

export const renderGetDeployTool: ToolDefinition = {
  spec: {
    name: "render_get_deploy",
    description: "Get full detail on one deploy — status, commit, and timing.",
    parameters: {
      type: "object",
      properties: {
        deployId: { type: "string", description: "The deploy ID (from render_list_deploys)." },
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
      },
      required: ["deployId"],
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const data = await renderFetch(`/services/${serviceId}/deploys/${String(args.deployId)}`, apiKey);
    return JSON.stringify(data, null, 2);
  },
};

export const renderTriggerDeployTool: ToolDefinition = {
  spec: {
    name: "render_trigger_deploy",
    description: "Trigger a new deploy of a Render service's current branch (e.g. after a config-only change).",
    parameters: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
        clearCache: { type: "boolean", description: "Clear the build cache first. Defaults to false." },
      },
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const data = await renderFetch(`/services/${serviceId}/deploys`, apiKey, {
      method: "POST",
      body: { clearCache: args.clearCache ? "clear" : "do_not_clear" },
    });
    const deploy = data as RenderDeploy;
    return `Triggered deploy ${deploy.id ?? "(unknown id)"} — status: ${deploy.status ?? "unknown"}.`;
  },
};

export const renderUpdateEnvVarTool: ToolDefinition = {
  spec: {
    name: "render_update_env_var",
    description:
      "Set one environment variable on a Render service (creates it if it doesn't exist). Render redeploys the " +
      "service automatically to pick up the change. There is no matching read tool — this can only set a value, " +
      "never list or read back existing ones, so it can't be used to exfiltrate other secrets already configured " +
      "on the service.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name." },
        value: { type: "string", description: "New value." },
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
      },
      required: ["key", "value"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const key = String(args.key);
    await renderFetch(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, apiKey, {
      method: "PUT",
      body: { value: String(args.value) },
    });
    return `Set ${key} on service ${serviceId}. Render will redeploy automatically to apply it.`;
  },
};

interface RenderLogEntry {
  timestamp?: string;
  message?: string;
}

export const renderListLogsTool: ToolDefinition = {
  spec: {
    name: "render_list_logs",
    description: "Fetch recent log lines for a Render service, optionally within a time range.",
    parameters: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Defaults to CJW_RENDER_SERVICE_ID if omitted." },
        startTime: { type: "string", description: "RFC3339 timestamp. Defaults to Render's own default lookback." },
        endTime: { type: "string", description: "RFC3339 timestamp. Defaults to now." },
        limit: { type: "number", description: "Max log lines. Defaults to 100." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const apiKey = requireApiKey(ctx);
    const serviceId = resolveServiceId(args, ctx);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 100;
    const params = new URLSearchParams({ resource: serviceId, limit: String(limit) });
    if (typeof args.startTime === "string") params.set("startTime", args.startTime);
    if (typeof args.endTime === "string") params.set("endTime", args.endTime);
    const data = await renderFetch(`/logs?${params.toString()}`, apiKey);
    const entries = ((data as { logs?: RenderLogEntry[] }).logs ?? []) as RenderLogEntry[];
    if (!entries.length) return "(no log lines in range)";
    return entries.map((e) => `${e.timestamp ?? "?"} ${e.message ?? ""}`).join("\n");
  },
};

export const renderTools: ToolDefinition[] = [
  renderGetServiceTool,
  renderListDeploysTool,
  renderGetDeployTool,
  renderTriggerDeployTool,
  renderUpdateEnvVarTool,
  renderListLogsTool,
];
