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
    .replace(/(Bearer\s+)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[REDACTED]")
    .slice(0, 1200);
}
