#!/usr/bin/env node
// Synthetic MSP host: no network, credentials, real login, or model calls.
import { createInterface } from "node:readline";

const scenario = process.env.TEST_MUSE_SCENARIO || "logged-out";
const sessionId = "synthetic-session";
const turnId = "synthetic-turn";
const token = "synthetic-provider-value";
const email = ["synthetic", "example.invalid"].join("@");
const cursor = "opaque".repeat(12);
let turnFinished = false;
const sourceRange = { stream: { id: sessionId, kind: "session" }, first: { id: "synthetic-record", sequence: 1 }, last: { id: "synthetic-record", sequence: 1 } };
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const reply = (request, result = {}) => send({ jsonrpc: "2.0", id: request.id, result: { ...result, ...(request.params?.commandId ? { commandId: request.params.commandId, status: "applied" } : {}) } });
const reject = (request, message) => send({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message, data: { kind: "environmentError", retryable: false } } });
const terminal = (state) => ({ sessionId, turnId, terminal: state, viewCursor: cursor, sourceRange });
const approvalRequest = (id) => ({ sessionId, turnId, approvalId: id, currentRequirementId: id, toolName: "synthetic-shell", subject: id, rawArgs: { command: "printf example" }, availableChoices: [{ choiceId: cursor, label: "Deny", decision: "deny", scope: "call" }] });
const questionRequest = (id) => ({ sessionId, turnId, userInputId: id, questions: [{ id: "synthetic-question", header: "Choice", question: "Choose a synthetic option", selection: { mode: "single" }, options: [{ label: "Example" }] }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      reply(request, { serverInfo: { name: "synthetic-muse", version: "1.3.0-fixture" }, schema: { version: 1, fingerprint: `sha256:${"0".repeat(64)}` } });
      break;
    case "account/read":
      if (scenario === "account-read-race") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { state: "accountLogin" } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "account/changed", params: { state: "apiKey" } })}\n`);
        break;
      }
      reply(request, { state: process.env.META_API_KEY || process.env.MODEL_API_KEY ? "envKey" : scenario === "usage-down-api-key" ? "apiKey" : scenario === "logged-out" ? "loggedOut" : "accountLogin", label: "Synthetic account", credentialRequired: true });
      break;
    case "usage/read":
      if (scenario === "usage-down" || scenario === "usage-down-api-key" || (turnFinished && scenario.startsWith("usage-after-turn"))) reject(request, "Synthetic usage failure");
      else if (turnFinished && scenario === "exit-after-turn") process.exit(17);
      else reply(request, {});
      break;
    case "account/loginStart": reply(request, { verificationUrl: "https://example.invalid/device", userCode: "EXAMPLE-CODE" }); break;
    case "approval/listPending":
      if (scenario === "account-flip") notify("account/changed", { state: "apiKey" });
      reply(request, { approvals: [], userInputs: [] });
      break;
    case "session/start":
    case "session/resume": reply(request, { session: { sessionId, status: "idle" } }); break;
    case "session/rename": reply(request); break;
    case "turn/start":
      reply(request, { turnId });
      setImmediate(() => {
        if (scenario === "hold-turn") {
          setTimeout(() => notify("item/delta", { sessionId, turnId, field: "text", delta: "Synthetic started" }), 10);
        } else if (scenario === "crash-turn") {
          notify("item/delta", { sessionId, turnId, field: "text", delta: "Synthetic partial reply" });
          setTimeout(() => process.exit(17), 20);
        } else if (scenario === "pending" || scenario === "usage-after-turn-pending") {
          notify("approval/requested", {
            sessionId, turnId, approvalId: "synthetic-approval", currentRequirementId: "synthetic-requirement",
            toolName: "synthetic-shell", subject: "Synthetic operation", rawArgs: { command: "printf example" },
            availableChoices: [{ choiceId: cursor, label: "Deny", decision: "deny", scope: "call" }],
          });
        } else if (scenario.startsWith("approval-race")) {
          notify("approval/requested", approvalRequest("request-A"));
        } else if (scenario.startsWith("input-race")) {
          notify("userInput/requested", questionRequest("request-A"));
        } else if (scenario === "unqueued") {
          notify("turn/unqueued", { sessionId, turnId, commandId: request.params.commandId, viewCursor: cursor, sourceRange });
        } else if (scenario === "unknown-terminal") {
          notify("turn/completed", terminal("future-state"));
        } else if (scenario === "failed") {
          notify("turn/completed", { ...terminal("failed"), reason: `access_token=${token}`, error: { kind: "modelError", message: `Bearer ${token} ${email}`, retryable: false }, unexpectedCredential: token });
        } else {
          notify("item/completed", { sessionId, turnId, item: { kind: "agentMessage", text: `Synthetic reply with contact ${email} and long ID ${cursor}` } });
          turnFinished = true;
          notify("turn/completed", terminal("completed"));
        }
      });
      break;
    case "approval/decide":
      if (request.params.choiceId !== cursor) { reject(request, "Invalid synthetic approval choice"); break; }
      if (scenario.startsWith("approval-race")) {
        notify(scenario === "approval-race-input" ? "userInput/requested" : "approval/requested", scenario === "approval-race-input" ? questionRequest("request-B") : approvalRequest("request-B"));
        setImmediate(() => reply(request));
        break;
      }
      reply(request);
      setImmediate(() => {
        notify("approval/resolved", { sessionId, turnId, approvalId: "synthetic-approval" });
        turnFinished = true;
        notify("turn/completed", terminal("cancelled"));
      });
      break;
    case "userInput/answer":
    case "userInput/clarify":
    case "userInput/cancel":
      notify("userInput/requested", questionRequest("request-B"));
      setImmediate(() => reply(request));
      break;
    case "turn/cancel":
      reply(request);
      setImmediate(() => notify("turn/completed", terminal("cancelled")));
      break;
    default: reject(request, "Unsupported synthetic method");
  }
}).on("close", () => process.exit(0));
