// ─── Structured logging ──────────────────────────────────────────────
//
// Every line goes to stderr, never stdout: in stdio mode stdout carries the MCP
// JSON-RPC stream and any write there corrupts the protocol. Do not "fix" these
// to console.log.
//
// Each line is a single-line JSON object carrying an explicit `level`. Railway
// parses that field; without it, everything on stderr defaults to level=error
// and `railway logs --filter "@level:error"` returns every successful startup
// line alongside the real failures. Fields beyond `message` become queryable
// attributes (`@tool:`, `@ms:>500`).
//
// Two consumers bind to this shape — check both before editing:
//   * scripts/analyse-railway-logs.py matches STARTUP_PATTERNS as substrings of
//     `message`, so startup text must stay byte-identical.
//   * scripts/tests/test-wake-timing.mjs watches stderr for "Background warmup
//     complete" / "warmup failed". Such sentinels survive JSON encoding only
//     while they stay plain ASCII; a quote or backslash in one would be
//     escaped and the wait would silently never match.

type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

/**
 * `cause` is unpacked into `error` (and `stack` when present) rather than
 * folded into the message, so the stack survives on one line and stays
 * filterable instead of being flattened into prose. Keeping the message a
 * constant string also lets Railway group recurrences of the same failure.
 */
function emit(level: LogLevel, message: string, cause?: unknown, fields?: LogFields): void {
  const extra: LogFields = { ...fields };
  if (cause !== undefined) {
    extra.error = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof Error && cause.stack) extra.stack = cause.stack;
  }
  console.error(JSON.stringify({ level, message, ...extra }));
}

/** No `cause` parameter: an informational line has no failure to attach. */
export function logInfo(message: string, fields?: LogFields): void {
  emit("info", message, undefined, fields);
}

/**
 * Degraded-but-running: an optional subsystem failed and was skipped, or a
 * fallback took over. Reserve logError for what an operator must act on —
 * a warm-up or flush failure costs latency or a metric, not correctness, and
 * putting it at error level is what buries real failures in `@level:error`.
 */
export function logWarn(message: string, cause?: unknown, fields?: LogFields): void {
  emit("warn", message, cause, fields);
}

/** Something the operator must act on. */
export function logError(message: string, cause?: unknown, fields?: LogFields): void {
  emit("error", message, cause, fields);
}
