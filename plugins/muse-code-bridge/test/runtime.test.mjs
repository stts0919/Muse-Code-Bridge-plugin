import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultStateFile, resolveMuseBinary, subscriptionEnvironment } from "../src/runtime.mjs";
import { publicAccountState, redactDiagnostic } from "../src/privacy.mjs";
import { MuseHostBridge } from "../src/muse-host.mjs";
import { normalizeUsage } from "../src/usage.mjs";

test("resolves the Muse executable from PATH rather than a machine-specific path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-bridge-path-"));
  try {
    const binary = path.join(directory, process.platform === "win32" ? "muse.exe" : "muse");
    await writeFile(binary, "test fixture\n");
    await chmod(binary, 0o700);
    assert.equal(await resolveMuseBinary("muse", { PATH: directory }), binary);
    assert.equal(await resolveMuseBinary(binary, { PATH: "" }), binary);
    await assert.rejects(resolveMuseBinary("muse", { PATH: "" }), /not found/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subscription child environment strips API overrides without modifying its parent", () => {
  const secret = "synthetic-test-value";
  const parent = { PATH: "example-path", META_API_KEY: secret, MODEL_API_KEY: secret };
  assert.deepEqual(subscriptionEnvironment(parent), { PATH: "example-path" });
  assert.equal(parent.META_API_KEY, secret);
});

test("state paths follow the host platform and XDG configuration", () => {
  const home = path.resolve("example-home");
  assert.equal(defaultStateFile({}, "darwin", home), path.join(home, "Library", "Application Support", "Muse Code Bridge", "state.json"));
  assert.equal(defaultStateFile({ XDG_STATE_HOME: path.join(home, "state") }, "linux", home), path.join(home, "state", "muse-code-bridge", "state.json"));
  assert.equal(defaultStateFile({ LOCALAPPDATA: path.join(home, "local") }, "win32", home), path.join(home, "local", "Muse Code Bridge", "state.json"));
});

test("account status and usage omit labels and arbitrary provider fields", () => {
  const account = { state: "accountLogin", label: "Synthetic private label", credentialRequired: true, accessToken: "synthetic-test-value" };
  assert.deepEqual(publicAccountState(account), { state: "accountLogin", credentialRequired: true });
  const serialized = JSON.stringify(normalizeUsage(null, account));
  assert.doesNotMatch(serialized, /Synthetic private label|accessToken|synthetic-test-value/);
});

test("diagnostics redact credential assignments, bearer values, and email addresses", () => {
  const email = ["example", "example.invalid"].join("@");
  const safe = redactDiagnostic(`Authorization: Bearer synthetic-token access_token=synthetic-access cookie=synthetic-cookie ${email}`);
  assert.doesNotMatch(safe, /synthetic-token|synthetic-access|synthetic-cookie/);
  assert.ok(!safe.includes(email));
});

test("API-key account lanes fail before opening a session or sending a model turn", async () => {
  for (const lane of ["apiKey", "envKey", "loggedOut", "unknown"]) {
    const bridge = new MuseHostBridge();
    bridge.hostPromise = Promise.resolve({});
    const commands = [];
    bridge.connection = {
      request: async (method) => method === "account/read" ? { state: lane } : { usage: null },
      command: async (method) => { commands.push(method); throw new Error("Unexpected command"); },
    };
    await assert.rejects(bridge.chat({ message: "Test only", workspace: process.cwd() }), (error) => error.code === "SUBSCRIPTION_LOGIN_REQUIRED");
    assert.deepEqual(commands, []);
  }
});

test("an approval response must use the current request and an offered choice", async () => {
  const bridge = new MuseHostBridge();
  bridge.hostPromise = Promise.resolve({});
  let decisions = 0;
  bridge.connection = {
    request: async (method) => {
      if (method === "account/read") return { state: "accountLogin" };
      if (method === "usage/read") return { usage: null };
      return { approvals: [{ sessionId: "example-session", turnId: "example-turn", approvalId: "current-request", availableChoices: [{ choiceId: "deny" }] }] };
    },
    command: async () => { decisions += 1; },
  };
  await assert.rejects(bridge.respond({ sessionId: "example-session", requestId: "old-request", action: "decide_approval", choiceId: "deny" }), (error) => error.code === "REQUEST_ID_MISMATCH");
  await assert.rejects(bridge.respond({ sessionId: "example-session", requestId: "current-request", action: "decide_approval", choiceId: "invented-choice" }), (error) => error.code === "CHOICE_NOT_OFFERED");
  assert.equal(decisions, 0);
});

test("reset persists only workspace mappings and does not remove Muse history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-bridge-state-"));
  try {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const bridge = new MuseHostBridge({ stateFile: path.join(directory, "state.json") });
    const result = await bridge.resetWorkspace(workspace);
    assert.equal(result.history_deleted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
