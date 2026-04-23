import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, err, wrap, defineAction } from "../src/index.js";
import type { Result } from "../src/index.js";

// --- ok() ---

test("ok() constructs a successful Result", () => {
  const result = ok(42);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 42);
  }
});

test("ok() works with string values", () => {
  const result = ok("hello");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "hello");
  }
});

test("ok() works with object values", () => {
  const result = ok({ x: 1, y: 2 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { x: 1, y: 2 });
  }
});

// --- err() ---

test("err() constructs a failed Result", () => {
  const error = new Error("something went wrong");
  const result = err(error);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, error);
  }
});

test("err() works with string error", () => {
  const result = err("custom error");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "custom error");
  }
});

// --- wrap() ---

test("wrap() returns ok Result for resolved promise", async () => {
  const result = await wrap(() => Promise.resolve("success"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "success");
  }
});

test("wrap() returns err Result for rejected promise (Error instance)", async () => {
  const result = await wrap(() => Promise.reject(new Error("boom")));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "boom");
  }
});

test("wrap() converts non-Error rejection to Error", async () => {
  const result = await wrap(() => Promise.reject("string rejection"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "string rejection");
  }
});

test("wrap() converts thrown non-Error to Error", async () => {
  const result = await wrap(async () => {
    throw 42;
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "42");
  }
});

// --- defineAction() ---

test("defineAction() preserves name and description", () => {
  const action = defineAction({
    name: "my-action",
    description: "Does something",
    handler: async (_input: unknown) => "done",
  });
  assert.equal(action.name, "my-action");
  assert.equal(action.description, "Does something");
});

test("defineAction() run() returns ok on successful handler", async () => {
  const action = defineAction({
    name: "add",
    description: "Adds numbers",
    handler: async (input: { a: number; b: number }) => input.a + input.b,
  });
  const result = await action.run({ a: 3, b: 4 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 7);
  }
});

test("defineAction() run() returns err when handler throws", async () => {
  const action = defineAction({
    name: "fail-action",
    description: "Always fails",
    handler: async (_input: unknown): Promise<never> => {
      throw new Error("handler error");
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "handler error");
  }
});

test("defineAction() run() wraps non-Error throws as Error", async () => {
  const action = defineAction({
    name: "bad-throw",
    description: "Throws a string",
    handler: async (_input: unknown): Promise<never> => {
      throw "oops";
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "oops");
  }
});

// --- type narrowing smoke test ---

test("Result type narrows correctly via ok property", () => {
  const r: Result<number> = ok(10);
  if (r.ok) {
    assert.equal(r.value, 10);
  } else {
    assert.fail("should be ok");
  }
});
