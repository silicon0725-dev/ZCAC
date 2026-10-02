/**
 * ZCAC Phase 13 — Protocol frames + 崩溃语义单测。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeFrames,
  encodeFrame,
  extractTurnResponse,
  rpcResult,
} from "../src/adapters/protocol/frames.js";

describe("protocol frames", () => {
  it("encodes a request as NDJSON line", () => {
    const line = encodeFrame({ id: 1, method: "session/create", params: { a: 1 } });
    assert.equal(line, '{"id":1,"method":"session/create","params":{"a":1}}\n');
  });

  it("decodes multiple frames and preserves partial buffer", () => {
    const input =
      '{"id":1,"result":{"sessionId":"s1"}}\n{"method":"v4/conversation/frame","params":{"x":2}}\n{"id":2,"res';
    const { frames, rest } = decodeFrames(input);
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0], { id: 1, result: { sessionId: "s1" } });
    assert.equal(rest, '{"id":2,"res');
  });

  it("skips non-JSON lines (log pollution) without breaking the stream", () => {
    const input = 'AI SDK Warning: something\n{"id":9,"result":true}\n';
    const { frames } = decodeFrames(input);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { id: 9, result: true });
  });


  it("extracts assistant text from event payloads", () => {
    const payload = {
      parts: [{ type: "text", text: "final answer text" }],
    };
    assert.equal(extractTurnResponse(payload), "final answer text");
  });

  it("returns empty string for unparseable payloads", () => {
    assert.equal(extractTurnResponse(undefined), "");
    assert.equal(extractTurnResponse({ nothing: 1 }), "");
  });

describe("rpcResult", () => {
  it("extracts result from a response frame", () => {
    assert.deepEqual(rpcResult({ id: 1, result: { sessionId: "s1" } }), { sessionId: "s1" });
    assert.equal(rpcResult({ method: "notify" }), undefined);
  });
});
});
