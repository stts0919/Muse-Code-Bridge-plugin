// Public diagnostics deliberately omit account labels and redact credentials.
export function publicAccountState(account) {
  return {
    state: typeof account?.state === "string" ? account.state : "unknown",
    credentialRequired: typeof account?.credentialRequired === "boolean"
      ? account.credentialRequired : true,
  };
}

export function redactDiagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/((?:META_API_KEY|MODEL_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[REDACTED]")
    .slice(0, 1200);
}

const CREDENTIAL_FIELD = /^(?:META_API_KEY|MODEL_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookies?|set-cookie|client[_-]?secret|credentials?|secret|token)$/i;
const IDENTIFIER_FIELD = /^(?:session[_-]?id|turn[_-]?id|request[_-]?id|approval[_-]?id|user[_-]?input[_-]?id|choice[_-]?id|requirement[_-]?id|pending_request_ids|view[_-]?cursor)$/i;

// Only diagnostic subtrees pass through this helper. Task content, exact
// approval arguments, login codes, and routing identifiers remain functional.
export function redactDiagnosticValue(value, field = "", seen = new WeakSet(), depth = 0) {
  if (CREDENTIAL_FIELD.test(field)) return "[REDACTED]";
  if (typeof value === "string") return IDENTIFIER_FIELD.test(field) ? value : redactDiagnostic(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 20) return "[TRUNCATED_DIAGNOSTIC]";
  if (seen.has(value)) return "[CIRCULAR_DIAGNOSTIC]";
  seen.add(value);
  try {
    if (field === "account") return publicAccountState(value);
    if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, field, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDiagnosticValue(item, key, seen, depth + 1)]));
  } finally {
    seen.delete(value);
  }
}

// MSP 1.3.0 completion/reclaim fields: retain their routing/provenance data,
// redact their diagnostic subtrees, and omit unspecified top-level metadata.
export function publicTurnTerminal(terminal) {
  if (!terminal || typeof terminal !== "object") return terminal;
  const keys = ["terminal", "sessionId", "turnId", "commandId", "viewCursor", "sourceRange", "durationMs", "timeToFirstTokenMs", "usage"];
  const result = Object.fromEntries(keys.filter((key) => Object.hasOwn(terminal, key)).map((key) => [key, terminal[key]]));
  if (Object.hasOwn(terminal, "error")) result.error = redactDiagnosticValue(terminal.error);
  if (typeof terminal.reason === "string") result.reason = redactDiagnostic(terminal.reason);
  return result;
}
