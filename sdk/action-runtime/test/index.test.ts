import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  err,
  wrap,
  defineAction,
  ActionError,
  ValidationError,
  setInternalErrorSink,
} from "../src/index.js";
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

test("wrap() converts non-Error string rejection to redacted ActionError", async () => {
  const result = await wrap(() => Promise.reject("string rejection"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.ok(result.error instanceof ActionError);
    // Short, environment-free string is preserved verbatim.
    assert.equal(result.error.message, "string rejection");
    assert.equal((result.error as ActionError).code, "ACTION_ERROR");
  }
});

test("wrap() converts thrown non-Error/non-string to a type tag (no value leak)", async () => {
  const result = await wrap(async () => {
    throw 42;
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof ActionError);
    // SDK-F3: the raw value is NOT serialised across the boundary.
    assert.equal(result.error.message, "non-error rejection (number)");
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

test("defineAction() run() wraps non-Error string throws as redacted ActionError", async () => {
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
    assert.ok(result.error instanceof ActionError);
    assert.equal(result.error.message, "oops");
  }
});

// --- SDK-F3: error redaction at the runtime boundary ---

test("defineAction() redacts RPC URLs from error messages", async () => {
  const action = defineAction({
    name: "leaky-rpc",
    description: "Throws with an RPC URL embedded",
    handler: async (_i: unknown): Promise<never> => {
      throw new Error(
        "connection refused to https://mainnet.helius-rpc.com/?api-key=SECRET123",
      );
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof ActionError);
    assert.ok(
      !result.error.message.includes("helius-rpc.com"),
      `RPC host leaked: ${result.error.message}`,
    );
    assert.ok(
      !result.error.message.includes("SECRET123"),
      `api key leaked: ${result.error.message}`,
    );
    assert.ok(result.error.message.includes("[redacted]"));
  }
});

test("defineAction() redacts filesystem (keypair) paths from error messages", async () => {
  const action = defineAction({
    name: "leaky-path",
    description: "Throws with a keypair path embedded",
    handler: async (_i: unknown): Promise<never> => {
      throw new Error("cannot read keypair at /home/deployer/.config/solana/id.json");
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      !result.error.message.includes("/home/deployer"),
      `path leaked: ${result.error.message}`,
    );
    assert.ok(result.error.message.includes("[redacted]"));
  }
});

test("defineAction() never returns the raw Error instance or its stack", async () => {
  const raw = new Error("inner failure with /etc/secrets/key path");
  const action = defineAction({
    name: "no-stack",
    description: "Throws a real Error",
    handler: async (_i: unknown): Promise<never> => {
      throw raw;
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.notStrictEqual(result.error, raw, "raw Error instance leaked");
    assert.ok(!result.error.message.includes("/etc/secrets"), "path in message");
    assert.ok(
      !(result.error.stack ?? "").includes("/etc/secrets"),
      "sensitive data present in stack",
    );
  }
});

test("defineAction() bounds very long error messages", async () => {
  const action = defineAction({
    name: "long-msg",
    description: "Throws a huge message",
    handler: async (_i: unknown): Promise<never> => {
      throw new Error("x".repeat(5000));
    },
  });
  const result = await action.run({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.message.length <= 260);
  }
});

test("setInternalErrorSink() receives the RAW error; caller still gets redacted", async () => {
  let captured: unknown;
  setInternalErrorSink((e) => {
    captured = e;
  });
  try {
    const action = defineAction({
      name: "sink-test",
      description: "Throws with sensitive content",
      handler: async (_i: unknown): Promise<never> => {
        throw new Error("rpc https://secret.rpc.example/key=ABC");
      },
    });
    const result = await action.run({});
    assert.equal(result.ok, false);
    assert.ok(captured instanceof Error);
    assert.ok(
      (captured as Error).message.includes("secret.rpc.example"),
      "internal sink must see the unredacted error",
    );
    if (!result.ok) {
      assert.ok(
        !result.error.message.includes("secret.rpc.example"),
        "caller-facing message must be redacted",
      );
    }
  } finally {
    setInternalErrorSink(undefined);
  }
});

// --- SDK-F3: input validation hook ---

test("defineAction() runs the validate hook before the handler", async () => {
  let handlerSawValidated = false;
  const action = defineAction<{ amount: number }, string>({
    name: "validated",
    description: "Validates amount is a positive integer",
    validate: (input: unknown) => {
      const i = input as { amount?: unknown };
      if (typeof i?.amount !== "number" || !Number.isInteger(i.amount) || i.amount <= 0) {
        throw new ValidationError("amount must be a positive integer");
      }
      return { amount: i.amount };
    },
    handler: async (i) => {
      handlerSawValidated = true;
      return `ok:${i.amount}`;
    },
  });

  const good = await action.run({ amount: 5 });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value, "ok:5");
  assert.equal(handlerSawValidated, true);

  handlerSawValidated = false;
  const bad = await action.run({ amount: -1 });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.error instanceof ActionError);
    assert.equal((bad.error as ActionError).code, "VALIDATION_ERROR");
    assert.equal(bad.error.message, "amount must be a positive integer");
  }
  assert.equal(handlerSawValidated, false, "handler must NOT run on invalid input");

  const hostile = await action.run({ amount: "0; DROP TABLE" });
  assert.equal(hostile.ok, false);
  assert.equal(handlerSawValidated, false);
});

test("defineAction() without validate passes input through unchanged (documented contract)", async () => {
  const action = defineAction<{ raw: unknown }, unknown>({
    name: "no-validate",
    description: "No validation — handler owns it",
    handler: async (i) => i.raw,
  });
  const result = await action.run({ raw: { anything: true } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { anything: true });
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
