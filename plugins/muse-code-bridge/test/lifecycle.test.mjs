import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MuseHostBridge } from "../src/muse-host.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-muse.mjs", import.meta.url));
const posixOnly = { skip: process.platform === "win32" };
async function bounded(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Lifecycle operation did not settle")), ms); })]);
  } finally { clearTimeout(timer); }
}
async function withHost(scenario, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-lifecycle-"));
  const previous = process.env.TEST_MUSE_SCENARIO;
  process.env.TEST_MUSE_SCENARIO = scenario;
  const bridge = new MuseHostBridge({ museBin: fixture, stateFile: path.join(directory, "state.json") });
  try {
    const workspace = await realpath(await mkdir(path.join(directory, "workspace"), { recursive: true }));
    await run({ bridge, workspace });
  } finally {
    await bridge.close();
    if (previous === undefined) delete process.env.TEST_MUSE_SCENARIO;
    else process.env.TEST_MUSE_SCENARIO = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("cold reset loads existing A/B mappings, retains B, and does not start Muse", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-cold-reset-"));
  try {
    const a = await realpath(await mkdir(path.join(directory, "A"), { recursive: true }));
    const b = await realpath(await mkdir(path.join(directory, "B"), { recursive: true }));
    const stateFile = path.join(directory, "state.json");
    await writeFile(stateFile, JSON.stringify({ version: 1, workspaces: { [a]: "session-A", [b]: "session-B" } }));
    const bridge = new MuseHostBridge({ museBin: path.join(directory, "absent-muse"), stateFile });
    const reset = await bridge.resetWorkspace(a);
    assert.equal(reset.previous_session_id, "session-A");
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { version: 1, workspaces: { [b]: "session-B" } });
    assert.equal(bridge.host, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cold reset never overwrites a corrupt state file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-corrupt-reset-"));
  try {
    const stateFile = path.join(directory, "state.json"), content = "invalid JSON fixture";
    await writeFile(stateFile, content);
    const bridge = new MuseHostBridge({ stateFile });
    await assert.rejects(bridge.resetWorkspace(directory), (error) => error.code === "STATE_READ_FAILED");
    assert.equal(await readFile(stateFile, "utf8"), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent cold resets preserve other mappings without colliding writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-concurrent-reset-"));
  try {
    const paths = await Promise.all(["A", "B", "C"].map(async (name) => realpath(await mkdir(path.join(directory, name), { recursive: true }))));
    const stateFile = path.join(directory, "state.json");
    await writeFile(stateFile, JSON.stringify({ version: 1, workspaces: Object.fromEntries(paths.map((entry, index) => [entry, `session-${index}`])) }));
    const bridge = new MuseHostBridge({ stateFile });
    await Promise.all(paths.slice(0, 2).map((entry) => bridge.resetWorkspace(entry)));
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).workspaces, { [paths[2]]: "session-2" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid mapping validation is atomic and preserves the state file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-invalid-map-"));
  try {
    const stateFile = path.join(directory, "state.json");
    const content = JSON.stringify({ version: 1, workspaces: { valid: "synthetic-session", invalid: 7 } });
    await writeFile(stateFile, content);
    const bridge = new MuseHostBridge({ stateFile });
    await assert.rejects(bridge.resetWorkspace(directory), (error) => error.code === "STATE_READ_FAILED");
    assert.equal(bridge.workspaceSessions.size, 0);
    assert.equal(await readFile(stateFile, "utf8"), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unqueued is not reported as completed", posixOnly, async () => {
  await withHost("unqueued", async ({ bridge, workspace }) => {
    const result = await bounded(bridge.chat({ workspace, message: "Synthetic request" }));
    assert.equal(result.status, "unqueued");
    assert.equal(result.terminal.terminal, "unqueued");
  });
});

test("unknown terminal values fail closed", posixOnly, async () => {
  await withHost("unknown-terminal", async ({ bridge, workspace }) => {
    await assert.rejects(bounded(bridge.chat({ workspace, message: "Synthetic request" })), (error) => error.code === "UNKNOWN_TERMINAL_STATE");
  });
});

test("pre-aborted chat and response have no host, mapping, or model side effects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-pre-abort-"));
  try {
    const stateFile = path.join(directory, "state.json");
    const bridge = new MuseHostBridge({ museBin: path.join(directory, "absent-muse"), stateFile });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(bridge.chat({ workspace: directory, message: "Synthetic request", signal: controller.signal }), (error) => error.code === "TURN_CANCELLED");
    await assert.rejects(bridge.respond({ sessionId: "synthetic", requestId: "synthetic", action: "clarify", signal: controller.signal }), (error) => error.code === "TURN_CANCELLED");
    await assert.rejects(access(stateFile));
    assert.equal(bridge.hostPromise, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host crash settles waits, cleans listeners, and explicit reconnect can succeed", posixOnly, async () => {
  await withHost("crash-turn", async ({ bridge, workspace }) => {
    await assert.rejects(bounded(bridge.chat({ workspace, message: "Synthetic request" })), (error) => error.code === "MUSE_HOST_EXITED");
    const oldState = bridge.turns.get("synthetic-turn");
    assert.equal(oldState.listeners.size, 0);
    assert.equal(oldState.progressSinks.size, 0);
    assert.equal(bridge.host, null);
    process.env.TEST_MUSE_SCENARIO = "success";
    const result = await bounded(bridge.chat({ workspace, message: "Synthetic reconnect" }));
    assert.equal(result.status, "completed");
  });
});

test("in-flight abort settles promptly and does not restart the host", posixOnly, async () => {
  await withHost("hold-turn", async ({ bridge, workspace }) => {
    const controller = new AbortController();
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    const call = bridge.chat({ workspace, message: "Synthetic request", signal: controller.signal, onProgress: began });
    const rejected = assert.rejects(bounded(call), (error) => error.code === "TURN_CANCELLED");
    await bounded(started);
    const generation = bridge.hostGeneration;
    controller.abort();
    await rejected;
    const state = bridge.turns.get("synthetic-turn");
    assert.equal(state.listeners.size, 0);
    assert.equal(state.progressSinks.size, 0);
    assert.equal(bridge.hostGeneration, generation);
  });
});

test("account approval cannot be carried onto a replacement connection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-account-connection-"));
  try {
    const bridge = new MuseHostBridge({ stateFile: path.join(directory, "state.json") });
    bridge.hostPromise = Promise.resolve({});
    let commands = 0;
    const replacement = { request: async () => ({ state: "apiKey" }), command: async () => { commands += 1; } };
    bridge.connection = { request: async () => { bridge.connection = replacement; return { state: "accountLogin" }; } };
    await assert.rejects(bridge.chat({ workspace: directory, message: "Synthetic request" }), (error) => error.code === "MUSE_HOST_EXITED");
    assert.equal(commands, 0);
    await assert.rejects(access(bridge.stateFile));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const scenario of ["approval-race", "approval-race-input"]) {
  test(`${scenario}: pending B arriving before ACK A survives`, posixOnly, async () => {
    await withHost(scenario, async ({ bridge, workspace }) => {
      const first = await bounded(bridge.chat({ workspace, message: "Synthetic request" }));
      const result = await bounded(bridge.respond({ sessionId: first.session_id, requestId: first.pending.request_id, action: "decide_approval", choiceId: first.pending.choices[0].choice_id }));
      assert.equal(result.status, "needs_user_action");
      assert.equal(result.pending.request_id, "request-B");
    });
  });
}
for (const action of ["answer_questions", "clarify", "cancel_questions"]) {
  test(`${action}: next user question before ACK remains pending`, posixOnly, async () => {
    await withHost("input-race", async ({ bridge, workspace }) => {
      const first = await bounded(bridge.chat({ workspace, message: "Synthetic request" }));
      const result = await bounded(bridge.respond({ sessionId: first.session_id, requestId: first.pending.request_id, action, clarification: "Synthetic clarification", answers: [{ question_id: "synthetic-question", selected_label: "Example" }] }));
      assert.equal(result.status, "needs_user_action");
      assert.equal(result.pending.request_id, "request-B");
    });
  });
}

for (const scenario of ["usage-after-turn", "usage-down", "exit-after-turn"]) {
  test(`${scenario}: authoritative completed response survives meter failure`, posixOnly, async () => {
    await withHost(scenario, async ({ bridge, workspace }) => {
      const result = await bounded(bridge.chat({ workspace, message: "Synthetic request" }));
      assert.equal(result.status, "completed");
      assert.match(result.response, /Synthetic reply/);
      assert.equal(result.usage, null);
      assert.equal(typeof result.usage_error, "string");
    });
  });
}
test("unavailable usage never weakens the account-login gate", posixOnly, async () => {
  await withHost("usage-down-api-key", async ({ bridge, workspace }) => {
    await assert.rejects(bounded(bridge.chat({ workspace, message: "Synthetic request" })), (error) => error.code === "SUBSCRIPTION_LOGIN_REQUIRED");
  });
});

test("account lane changing on the same connection prevents a model turn", posixOnly, async () => {
  await withHost("account-flip", async ({ bridge, workspace }) => {
    await assert.rejects(bounded(bridge.chat({ workspace, message: "Synthetic request" })), (error) => error.code === "SUBSCRIPTION_LOGIN_REQUIRED");
    assert.equal(bridge.turns.size, 0);
  });
});

test("newer account notification cannot be overwritten by an older read continuation", posixOnly, async () => {
  await withHost("account-read-race", async ({ bridge, workspace }) => {
    await assert.rejects(bounded(bridge.chat({ workspace, message: "Synthetic request" })), (error) => error.code === "SUBSCRIPTION_LOGIN_REQUIRED");
    assert.equal(bridge.account.state, "apiKey");
    assert.equal(bridge.turns.size, 0);
  });
});

test("response terminal survives a final usage failure", posixOnly, async () => {
  await withHost("usage-after-turn-pending", async ({ bridge, workspace }) => {
    const first = await bounded(bridge.chat({ workspace, message: "Synthetic request" }));
    const result = await bounded(bridge.respond({ sessionId: first.session_id, requestId: first.pending.request_id, action: "decide_approval", choiceId: first.pending.choices[0].choice_id }));
    assert.equal(result.status, "cancelled");
    assert.equal(result.usage, null);
    assert.equal(typeof result.usage_error, "string");
  });
});

test("status preserves authoritative account information when the meter is unavailable", posixOnly, async () => {
  await withHost("usage-down", async ({ bridge, workspace }) => {
    const status = await bounded(bridge.status(workspace));
    assert.equal(status.account.state, "accountLogin");
    assert.equal(status.usage, null);
    assert.equal(typeof status.usage_error, "string");
  });
});
