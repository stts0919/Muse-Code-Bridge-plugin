import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MuseHostBridge } from "../src/muse-host.mjs";
import { publicTurnTerminal, redactDiagnosticValue, redactDiagnostic } from "../src/privacy.mjs";

test("failed turn diagnostics do not forward provider credentials or email", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-response-privacy-"));
  try {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const token = "synthetic-provider-value";
    const email = ["synthetic", "example.invalid"].join("@");
    const bridge = new MuseHostBridge({ stateFile: path.join(directory, "state.json") });
    bridge.hostPromise = Promise.resolve({});
    bridge.connection = {
      request: async (method) => method === "account/read"
        ? { state: "accountLogin" }
        : method === "usage/read" ? { usage: null } : { approvals: [], userInputs: [] },
      command: async (method) => {
        if (method === "session/start") return { session: { sessionId: "synthetic-session", status: "idle" } };
        if (method === "turn/start") {
          bridge.turns.set("synthetic-turn", {
            sessionId: "synthetic-session", turnId: "synthetic-turn", pending: null,
            agentMessages: [], liveText: "", listeners: new Set(), progressSinks: new Set(),
            terminal: {
              terminal: "failed", sessionId: "synthetic-session", turnId: "synthetic-turn",
              error: { kind: "modelError", retryable: false, message: `Bearer ${token} ${email}` },
              reason: `access_token=${token}`, viewCursor: "opaque-cursor",
            },
          });
          return { turnId: "synthetic-turn" };
        }
        return {};
      },
    };
    const result = await bridge.chat({ message: "Synthetic request", workspace });
    assert.equal(result.status, "failed");
    assert.equal(result.terminal.error.kind, "modelError");
    assert.equal(result.terminal.error.retryable, false);
    assert.equal(result.terminal.viewCursor, "opaque-cursor");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(token), "provider credential must not leave the diagnostic boundary");
    assert.ok(!serialized.includes(email), "provider diagnostic email must be omitted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nested diagnostic details redact credentials while keeping opaque request identifiers", () => {
  const identifier = "opaque".repeat(12);
  const secret = "synthetic-provider-value";
  const details = {
    request_id: identifier,
    pending_request_ids: [identifier],
    account: { state: "accountLogin", label: "Synthetic account", credentialRequired: true },
    nested: { apiKey: secret, headers: { Authorization: `Bearer ${secret}` }, error: `access_token=${secret}` },
  };
  const result = redactDiagnosticValue(details);
  assert.equal(result.request_id, identifier);
  assert.equal(result.pending_request_ids[0], identifier);
  assert.equal(result.account.state, "accountLogin");
  assert.equal("label" in result.account, false);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(details.nested.apiKey, secret, "diagnostic sanitization must not mutate its source");
});

test("completed, cancelled, and unqueued metadata preserve provenance and omit unknown fields", () => {
  const identifier = "opaque".repeat(12);
  const sourceRange = { stream: { id: identifier, kind: "session" }, first: { id: identifier, sequence: 1 }, last: { id: identifier, sequence: 1 } };
  for (const terminal of ["completed", "cancelled", "unqueued"]) {
    const source = { terminal, sessionId: identifier, turnId: identifier, commandId: identifier, viewCursor: identifier, sourceRange, durationMs: 7, usage: { inputTokens: 10 }, extraCredential: "synthetic-value" };
    const result = publicTurnTerminal(source);
    assert.equal(result.sessionId, identifier);
    assert.equal(result.turnId, identifier);
    assert.equal(result.commandId, identifier);
    assert.equal(result.viewCursor, identifier);
    assert.deepEqual(result.sourceRange, sourceRange);
    assert.deepEqual(result.usage, source.usage);
    assert.equal(result.durationMs, 7);
    assert.equal("extraCredential" in result, false);
  }
});

test("diagnostic redaction covers quoted passwords and complete authorization/cookie lines", () => {
  for (const input of [
    'password="synthetic value with spaces"',
    '"accessToken": "synthetic value with spaces"',
    "Authorization: Bearer synthetic-value, extra=synthetic-extra",
    "Cookie: sid=synthetic-value; secret=synthetic-extra",
  ]) {
    const safe = redactDiagnostic(input);
    assert.ok(!safe.includes("synthetic"));
  }
});
