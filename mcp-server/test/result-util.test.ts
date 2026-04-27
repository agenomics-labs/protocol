// ADR-103 — canonical Result shape + defineAction() builder tests.
// Runs under Node's built-in test runner via tsx (same as action-shape.test.ts).

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  ok,
  err,
  defineAction,
} from "../src/util/result.js";
import type { Result } from "../src/util/result.js";
// AUD-211 (cycle-2): `wrap` is intentionally NOT re-exported from
// `../src/util/result.js` (the canonical action-runtime `wrap` returns
// `Result<T, Error>`, which is structurally incompatible with the
// AepError-shaped local wraps in `actions/{vault,reputation,settlement,registry}.ts`).
// This test exercises the canonical `wrap` semantics directly against
// its source-of-truth at `@agenomics/action-runtime`, preserving
// coverage without re-introducing the discouraged re-export.
import { wrap } from "@agenomics/action-runtime";

describe("ADR-103 Result helpers (mcp-server/src/util/result.ts)", () => {
  describe("ok()", () => {
    it("produces a successful Result with the given value", () => {
      const r = ok(42);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, 42);
    });

    it("works with object values", () => {
      const r = ok({ data: "hello" });
      assert.equal(r.ok, true);
      if (r.ok) assert.deepEqual(r.value, { data: "hello" });
    });
  });

  describe("err()", () => {
    it("produces a failed Result with the given error", () => {
      const e = new Error("boom");
      const r = err(e);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, e);
    });

    it("accepts non-Error error values", () => {
      const r: Result<never, string> = err("something went wrong");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "something went wrong");
    });
  });

  describe("wrap()", () => {
    it("returns ok(value) when fn resolves", async () => {
      const r = await wrap(async () => 99);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, 99);
    });

    it("returns err(Error) when fn throws an Error", async () => {
      const r = await wrap(async () => { throw new Error("failure"); });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.error instanceof Error);
        assert.equal(r.error.message, "failure");
      }
    });

    it("coerces a non-Error throw to Error", async () => {
      const r = await wrap(async () => { throw "string error"; });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.error instanceof Error);
        assert.equal(r.error.message, "string error");
      }
    });
  });

  describe("defineAction()", () => {
    it("exposes name and description from spec", () => {
      const action = defineAction({
        name: "test_action",
        description: "A test action",
        handler: async (_input: unknown) => "done",
      });
      assert.equal(action.name, "test_action");
      assert.equal(action.description, "A test action");
    });

    it("run() returns ok(value) when handler resolves", async () => {
      const action = defineAction({
        name: "add_one",
        description: "Adds 1 to the input",
        handler: async (n: number) => n + 1,
      });
      const r = await action.run(5);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, 6);
    });

    it("run() returns err(Error) when handler throws", async () => {
      const action = defineAction({
        name: "always_fails",
        description: "Always throws",
        handler: async (_input: unknown) => { throw new Error("handler error"); },
      });
      const r = await action.run(null);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.error instanceof Error);
        assert.equal(r.error.message, "handler error");
      }
    });

    it("run() coerces non-Error throws to Error", async () => {
      const action = defineAction({
        name: "throws_string",
        description: "Throws a string",
        handler: async (_input: unknown) => { throw "oops"; },
      });
      const r = await action.run(null);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.error instanceof Error);
        assert.equal(r.error.message, "oops");
      }
    });

    it("handler receives the input passed to run()", async () => {
      interface Payload { x: number; y: number }
      const action = defineAction({
        name: "sum",
        description: "Sums x and y",
        handler: async ({ x, y }: Payload) => x + y,
      });
      const r = await action.run({ x: 3, y: 4 });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, 7);
    });
  });
});
