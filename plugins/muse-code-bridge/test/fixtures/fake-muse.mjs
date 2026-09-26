#!/usr/bin/env node
// Synthetic MSP host: no network, credentials, real login, or model calls.
import { createInterface } from "node:readline";

const scenario = process.env.TEST_MUSE_SCENARIO || "logged-out";
const sessionId = "synthetic-session";
const turnId = "synthetic-turn";
const token = "synthetic-provider-value";
const email = ["synthetic", "example.invalid"].join("@");
const cursor = "opaque".repeat(12);
const sourceRange = { stream: { id: sessionId, kind: "session" }, first: { id: "synthetic-record", sequence: 1 }, last: { id: "synthetic-record", sequence: 1 } };
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const reply = (request, result = {}) => send({ jsonrpc: "2.0", id: request.id, result: { ...result, ...(request.params?.commandId ? { commandId: request.params.commandId, status: "applied" } : {}) } });
const reject = (request, message) => send({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message, data: { kind: "environmentError", retryable: false } } });
const terminal = (state) => ({ sessionId, turnId, terminal: state, viewCursor: cursor, sourceRange });

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      reply(request, { serverInfo: { name: "synthetic-muse", version: "1.3.0-fixture" }, schema: { version: 1, fingerprint: `sha256:${"0".repeat(64)}` } });
      break;
    case "account/read":
      reply(request, { state: process.env.META_API_KEY || process.env.MODEL_API_KEY ? "envKey" : scenario === "logged-out" ? "loggedOut" : "accountLogin", label: "Synthetic account", credentialRequired: true });
      break;
    case "usage/read": reply(request, {}); break;
    case "account/loginStart": reply(request, { verificationUrl: "https://example.invalid/device", userCode: "EXAMPLE-CODE" }); break;
    case "approval/listPending": reply(request, { approvals: [], userInputs: [] }); break;
    case "session/start":
    case "session/resume": reply(request, { session: { sessionId, status: "idle" } }); break;
    case "session/rename": reply(request); break;
    case "turn/start":
      reply(request, { turnId });
      setImmediate(() => {
        if (scenario === "pending") {
          notify("approval/requested", {
            sessionId, turnId, approvalId: "synthetic-approval", currentRequirementId: "synthetic-requirement",
            toolName: "synthetic-shell", subject: "Synthetic operation", rawArgs: { command: "printf example" },
            availableChoices: [{ choiceId: cursor, label: "Deny", decision: "deny", scope: "call" }],
          });
        } else if (scenario === "failed") {
          notify("turn/completed", { ...terminal("failed"), reason: `access_token=${token}`, error: { kind: "modelError", message: `Bearer ${token} ${email}`, retryable: false }, unexpectedCredential: token });
        } else {
          notify("item/completed", { sessionId, turnId, item: { kind: "agentMessage", text: `Synthetic reply with contact ${email} and long ID ${cursor}` } });
          notify("turn/completed", terminal("completed"));
        }
      });
      break;
    case "approval/decide":
      if (request.params.choiceId !== cursor) { reject(request, "Invalid synthetic approval choice"); break; }
      reply(request);
      setImmediate(() => {
        notify("approval/resolved", { sessionId, turnId, approvalId: "synthetic-approval" });
        notify("turn/completed", terminal("cancelled"));
      });
      break;
    default: reject(request, "Unsupported synthetic method");
  }
}).on("close", () => process.exit(0));
