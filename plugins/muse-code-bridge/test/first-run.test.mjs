import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultStateFile } from "../src/runtime.mjs";

// The executable fixture uses a POSIX shebang; platform path rules have
// separate unit tests. This does not claim live Windows or Meta-login QA.
const fixture = fileURLToPath(new URL("./fixtures/fake-muse.mjs", import.meta.url));
const skip = process.platform === "win32";

async function firstRun(scenario, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-first-run-"));
  let client;
  try {
    const workspace = await realpath(await mkdir(path.join(directory, "workspace"), { recursive: true }));
    const stateFile = defaultStateFile({}, process.platform, path.join(directory, "new-user"));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.resolve("dist/server.mjs")], cwd: workspace, stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        MUSE_BIN: scenario === "missing" ? path.join(directory, "absent-muse") : fixture,
        MUSE_BRIDGE_STATE_PATH: stateFile,
        TEST_MUSE_SCENARIO: scenario,
        META_API_KEY: "synthetic-parent-key",
        MODEL_API_KEY: "synthetic-parent-key",
      },
    });
    client = new Client({ name: "synthetic-first-run", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    await run({ client, workspace, stateFile });
    await assert.rejects(access(path.join(workspace, "state.json")));
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("new user without Muse gets an actionable error and no repository state", { skip }, async () => {
  await firstRun("missing", async ({ client, workspace, stateFile }) => {
    const result = await client.callTool({ name: "get_muse_status", arguments: { workspace } });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.message, /Install Muse Code.*PATH.*MUSE_BIN/);
    await assert.rejects(access(stateFile));
  });
});

test("new logged-out user receives login instructions and cannot start a model turn", { skip }, async () => {
  await firstRun("logged-out", async ({ client, workspace, stateFile }) => {
    const status = await client.callTool({ name: "get_muse_status", arguments: { workspace } });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.account.state, "loggedOut");
    assert.equal("label" in status.structuredContent.account, false);
    assert.equal(status.structuredContent.usage.available, false);
    const denied = await client.callTool({ name: "chat_with_muse", arguments: { workspace, message: "Synthetic request" } });
    assert.equal(denied.structuredContent.code, "SUBSCRIPTION_LOGIN_REQUIRED");
    const login = await client.callTool({ name: "start_muse_subscription_login", arguments: {} });
    assert.equal(login.structuredContent.verification_url, "https://example.invalid/device");
    assert.equal(login.structuredContent.user_code, "EXAMPLE-CODE");
    await assert.rejects(access(stateFile));
  });
});

test("new signed-in fixture preserves replies and writes only private OS-style mapping", { skip }, async () => {
  await firstRun("success", async ({ client, workspace, stateFile }) => {
    const result = await client.callTool({ name: "chat_with_muse", arguments: { workspace, message: "Synthetic request" } });
    const email = ["synthetic", "example.invalid"].join("@");
    assert.equal(result.structuredContent.status, "completed");
    assert.equal(result.structuredContent.response, `Synthetic reply with contact ${email} and long ID ${"opaque".repeat(12)}`);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(state, { version: 1, workspaces: { [workspace]: "synthetic-session" } });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
  });
});

test("bundled failed-turn MCP output redacts diagnostics and retains protocol identifiers", { skip }, async () => {
  await firstRun("failed", async ({ client, workspace }) => {
    const result = await client.callTool({ name: "chat_with_muse", arguments: { workspace, message: "Synthetic request" } });
    assert.equal(result.structuredContent.status, "failed");
    assert.equal(result.structuredContent.session_id, "synthetic-session");
    assert.equal(result.structuredContent.terminal.viewCursor, "opaque".repeat(12));
    assert.equal(result.structuredContent.terminal.error.kind, "modelError");
    assert.ok(!JSON.stringify(result).includes("synthetic-provider-value"));
    assert.ok(!JSON.stringify(result).includes(["synthetic", "example.invalid"].join("@")));
    assert.equal("unexpectedCredential" in result.structuredContent.terminal, false);
  });
});

test("bundled pending operation and offered choice stay exact; no implicit approval", { skip }, async () => {
  await firstRun("pending", async ({ client, workspace }) => {
    const result = await client.callTool({ name: "chat_with_muse", arguments: { workspace, message: "Synthetic request" } });
    assert.equal(result.structuredContent.status, "needs_user_action");
    const pending = result.structuredContent.pending;
    assert.deepEqual(pending.raw_args, { command: "printf example" });
    assert.equal(pending.choices[0].choice_id, "opaque".repeat(12));
    const incorrect = await client.callTool({ name: "respond_to_muse", arguments: { session_id: pending.session_id, request_id: pending.request_id, action: "decide_approval", choice_id: "invented" } });
    assert.equal(incorrect.structuredContent.code, "CHOICE_NOT_OFFERED");
    const denied = await client.callTool({ name: "respond_to_muse", arguments: { session_id: pending.session_id, request_id: pending.request_id, action: "decide_approval", choice_id: pending.choices[0].choice_id } });
    assert.equal(denied.structuredContent.status, "cancelled");
  });
});
