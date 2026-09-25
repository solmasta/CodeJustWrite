import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import type { CjwConfig, ProviderRegistry } from "@codejustwrite/core";
import { Session } from "../src/session.js";

/** Just enough of a ws WebSocket for Session: readyState/OPEN/send, recording what was sent. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (json: string) => sent.push(JSON.parse(json)),
    close: () => {},
  };
  return { ws: ws as unknown as WebSocket, raw: ws, sent };
}

/** A provider that streams a canned reply, pausing on `gate` partway so a test can drop the
 *  connection mid-turn. */
function fakeRegistry(gate: Promise<void>) {
  const provider = {
    name: "fake",
    async complete(_m: unknown, _t: unknown, _model: string, handlers?: { onTextDelta?: (d: string) => void }) {
      handlers?.onTextDelta?.("Hello ");
      await gate;
      handlers?.onTextDelta?.("world");
      return { message: { role: "assistant", content: "Hello world" }, finishReason: "stop" };
    },
    async listModels() {
      return [];
    },
  };
  return { get: () => provider } as unknown as ProviderRegistry;
}

const config = { provider: "local", model: "fake-model", mcpServers: [] } as unknown as CjwConfig;

function newSession(gate: Promise<void> = Promise.resolve()) {
  return new Session("/tmp/cjw-session-test", fakeRegistry(gate), config);
}

describe("Session reconnect resume", () => {
  it("replays exactly the turn events a client missed while its connection was down", async () => {
    let release!: () => void;
    const session = newSession(new Promise<void>((r) => (release = r)));

    const first = fakeSocket();
    session.attach(first.ws);
    const turn = session.handleUserMessage("hi", "msg-1");
    await new Promise((r) => setTimeout(r, 0));

    // Connection silently dies mid-turn (e.g. Wi-Fi -> cellular handoff).
    first.raw.readyState = 3;
    const lastSeen = Math.max(...first.sent.filter((m) => typeof m.seq === "number").map((m) => m.seq as number));
    release();
    await turn;
    expect(first.sent.some((m) => m.type === "assistant_done")).toBe(false);

    const second = fakeSocket();
    session.attach(second.ws, lastSeen);
    const types = second.sent.map((m) => m.type);
    expect(types[0]).toBe("state");
    expect(types).not.toContain("history");
    expect(second.sent.filter((m) => m.type === "assistant_delta").map((m) => m.text)).toEqual(["world"]);
    expect(types).toContain("assistant_done");
    // Nothing it already had gets sent twice.
    expect(second.sent.every((m) => m.seq === undefined || (m.seq as number) > lastSeen)).toBe(true);
  });

  it("sends a full history rebuild to a client with nothing rendered yet", async () => {
    const session = newSession();
    session.attach(fakeSocket().ws);
    await session.handleUserMessage("hi", "msg-1");

    const fresh = fakeSocket();
    session.attach(fresh.ws);
    const history = fresh.sent.find((m) => m.type === "history");
    expect(history?.entries).toEqual([
      { type: "user", text: "hi" },
      { type: "assistant", text: "Hello world" },
    ]);
    expect(typeof history?.seq).toBe("number");
    expect(fresh.sent.some((m) => m.type === "assistant_delta")).toBe(false);
  });

  it("ignores a resent user message it already received, but acknowledges it", async () => {
    const session = newSession();
    const sock = fakeSocket();
    session.attach(sock.ws);
    await session.handleUserMessage("hi", "msg-1");
    await session.handleUserMessage("hi", "msg-1");

    expect(sock.sent.filter((m) => m.type === "turn_started")).toHaveLength(1);
    expect(sock.sent.filter((m) => m.type === "assistant_done")).toHaveLength(1);
    expect(sock.sent.some((m) => m.type === "message_received" && m.clientMsgId === "msg-1")).toBe(true);
  });
});
