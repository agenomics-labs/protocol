export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// SDK-F3 (cycle-4 audit `06-sdk.md` finding F3) — error redaction at the
// action-runtime trust boundary.
//
// `defineAction` is the advertised capability-handler runtime. A handler may
// touch RPC endpoint URLs, keypair paths, provider internals. A raw
// `Error.message` / `Error.stack` flowing back through the `Result` to an
// untrusted action *caller* exfiltrates those environment internals. The
// runtime now returns a STABLE, SAFE shape and logs the raw error internally
// only.
// ---------------------------------------------------------------------------

/**
 * Sanitised error returned to untrusted action callers. Carries a stable
 * machine `code` and a short, environment-free message. The raw error is
 * never serialised across this boundary; it is logged internally instead.
 */
export class ActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    // Do NOT retain the original error / its stack on this instance —
    // the whole point is that nothing environment-derived crosses back.
  }
}

/** Patterns that commonly leak environment internals in error strings. */
const SENSITIVE_PATTERNS: RegExp[] = [
  // URLs (RPC endpoints, provider URLs) incl. embedded credentials
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi,
  // filesystem paths (keypair files, home dirs) — POSIX and Windows
  /(?:\/[^\s'":]+){2,}/g,
  /[a-zA-Z]:\\[^\s'"]+/g,
  // long base58/hex blobs (keys, secrets, signatures)
  /\b[1-9A-HJ-NP-Za-km-z]{40,}\b/g,
  /\b(?:0x)?[0-9a-fA-F]{40,}\b/g,
];

/**
 * Redact a value into a single safe, bounded string. Never returns the
 * original `Error` instance or its `.stack`.
 */
function redactMessage(raw: unknown): string {
  let s: string;
  if (raw instanceof Error) {
    s = raw.message ?? "";
  } else if (typeof raw === "string") {
    s = raw;
  } else {
    // Stringifying arbitrary objects can serialise provider internals —
    // do not attempt it. Emit only the runtime type tag.
    return `non-error rejection (${typeof raw})`;
  }
  for (const re of SENSITIVE_PATTERNS) s = s.replace(re, "[redacted]");
  // Bound the surface so a hostile, very long message cannot itself be an
  // exfiltration / log-flooding channel.
  if (s.length > 256) s = s.slice(0, 256) + "…";
  return s.length > 0 ? s : "action failed";
}

/** Internal sink for the raw (unredacted) error. Off by default. */
let internalErrorSink: ((err: unknown) => void) | undefined;

/**
 * Register an internal logger that receives the RAW error (before
 * redaction). Intended for trusted server-side observability only — never
 * wire this to anything reachable by an untrusted action caller.
 */
export function setInternalErrorSink(sink: ((err: unknown) => void) | undefined): void {
  internalErrorSink = sink;
}

function toActionError(raw: unknown): ActionError {
  try {
    internalErrorSink?.(raw);
  } catch {
    /* a faulty sink must never break the action result path */
  }
  const code =
    raw instanceof ActionError
      ? raw.code
      : raw instanceof Error && typeof raw.name === "string" && raw.name.length > 0
        ? raw.name
        : "ACTION_ERROR";
  return new ActionError(code, redactMessage(raw));
}

export async function wrap<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toActionError(e));
  }
}

/**
 * Optional input validator. Runs BEFORE `handler` at the runtime boundary.
 * It must return the parsed/narrowed input on success and THROW on invalid
 * input (the throw is caught and redacted like any other failure). This is
 * the SDK-F3 capability/authz boundary: `defineAction` performs NO implicit
 * validation; supply `validate` to enforce one here, or the handler owns it.
 */
export type Validate<TInput> = (input: unknown) => TInput;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VALIDATION_ERROR";
  }
}

export interface ActionSpec<TInput, TOutput> {
  name: string;
  description: string;
  /**
   * Optional input validation/authorization hook. Strongly recommended for
   * any handler that moves funds or touches signing material — without it
   * `handler` receives whatever the (possibly untrusted) caller passed.
   */
  validate?: Validate<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
}

export interface Action<TInput, TOutput> {
  name: string;
  description: string;
  run: (input: unknown) => Promise<Result<TOutput, Error>>;
}

export function defineAction<TInput, TOutput>(
  spec: ActionSpec<TInput, TOutput>,
): Action<TInput, TOutput> {
  return {
    name: spec.name,
    description: spec.description,
    run: (input: unknown) =>
      wrap(async () => {
        const validated = spec.validate
          ? spec.validate(input)
          : (input as TInput);
        return spec.handler(validated);
      }),
  };
}
