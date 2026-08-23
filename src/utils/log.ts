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
// `message` is the field scripts/analyse-railway-logs.py matches
// STARTUP_PATTERNS against — keep startup text byte-identical when editing.

type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  console.error(JSON.stringify({ level, message, ...fields }));
}

export function logInfo(message: string, fields?: LogFields): void {
  emit("info", message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  emit("warn", message, fields);
}

/**
 * `cause` is unpacked into `error` (and `stack` when present) rather than
 * folded into the message, so the stack survives on one line and stays
 * filterable instead of being flattened into prose.
 */
export function logError(message: string, cause?: unknown, fields?: LogFields): void {
  const extra: LogFields = { ...fields };
  if (cause !== undefined) {
    extra.error = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof Error && cause.stack) extra.stack = cause.stack;
  }
  emit("error", message, extra);
}
