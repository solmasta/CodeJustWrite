import { describe, it, expect } from "vitest";
import { parseFakeToolCall } from "../src/agent/fakeToolCall.js";

const KNOWN = new Set(["list_dir", "read_file"]);

describe("parseFakeToolCall", () => {
  it("recovers a {name, arguments} shape", () => {
    const result = parseFakeToolCall('{"name": "list_dir", "arguments": {"path": "."}}', KNOWN);
    expect(result).toEqual({ name: "list_dir", arguments: { path: "." } });
  });

  it("recovers a {type: function, name, parameters} shape", () => {
    const result = parseFakeToolCall(
      '{"type": "function", "name": "list_dir", "parameters": {"path": "."}}',
      KNOWN
    );
    expect(result).toEqual({ name: "list_dir", arguments: { path: "." } });
  });

  it("recovers a nested {function: {name, arguments}} shape", () => {
    const result = parseFakeToolCall(
      '{"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}',
      KNOWN
    );
    expect(result).toEqual({ name: "read_file", arguments: { path: "a.txt" } });
  });

  it("recovers arguments given as a JSON-encoded string (the real wire format)", () => {
    const result = parseFakeToolCall('{"name": "list_dir", "arguments": "{\\"path\\": \\".\\"}"}', KNOWN);
    expect(result).toEqual({ name: "list_dir", arguments: { path: "." } });
  });

  it("recovers JSON wrapped in a markdown code fence", () => {
    const result = parseFakeToolCall('```json\n{"name": "list_dir", "arguments": {"path": "."}}\n```', KNOWN);
    expect(result).toEqual({ name: "list_dir", arguments: { path: "." } });
  });

  it("defaults to empty arguments when the tool takes none", () => {
    const result = parseFakeToolCall('{"name": "list_dir"}', KNOWN);
    expect(result).toEqual({ name: "list_dir", arguments: {} });
  });

  it("rejects a tool name that isn't actually registered", () => {
    expect(parseFakeToolCall('{"name": "delete_everything", "arguments": {}}', KNOWN)).toBeNull();
  });

  it("rejects a normal prose answer", () => {
    expect(parseFakeToolCall("Here's what I found in the repo: three files.", KNOWN)).toBeNull();
  });

  it("rejects prose that merely includes a JSON example alongside real explanation", () => {
    const content =
      'I would call list_dir like this: {"name": "list_dir", "arguments": {"path": "."}} — but I already checked and there are 3 files.';
    expect(parseFakeToolCall(content, KNOWN)).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseFakeToolCall('{"name": "list_dir", oops}', KNOWN)).toBeNull();
  });

  it("returns null for empty/null content", () => {
    expect(parseFakeToolCall(null, KNOWN)).toBeNull();
    expect(parseFakeToolCall("", KNOWN)).toBeNull();
  });
});
