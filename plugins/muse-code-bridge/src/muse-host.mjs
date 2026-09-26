import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnMspConnection } from "@muse-code/sdk";
import { normalizeUsage } from "./usage.mjs";
import { publicAccountState, publicTurnTerminal, redactDiagnostic, redactDiagnosticValue } from "./privacy.mjs";
import { defaultStateFile, resolveMuseBinary, subscriptionEnvironment } from "./runtime.mjs";

const BRIDGE_VERSION = "0.1.2";
const DEFAULT_MUSE_BIN = "muse";

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function redactError(error) {
  return redactDiagnostic(error);
}

function isMethodMissing(error) {
  return error && (error.code === -32601 || error.kind === "methodNotFound");
}

function isPendingProjectionUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /pending projection unavailable|materialized session view is unavailable/i.test(message);
}

function makeTurnState(sessionId, turnId, hostGeneration) {
  return {
    sessionId,
    turnId,
    terminal: null,
    failure: null,
    hostGeneration,
    pending: null,
    agentMessages: [],
    liveText: "",
    listeners: new Set(),
    progressSinks: new Set(),
    lastProgressAt: 0,
  };
}

export class MuseHostBridge {
  constructor(options = {}) {
    this.museBin = options.museBin ?? process.env.MUSE_BIN ?? DEFAULT_MUSE_BIN;
    this.stateFile = options.stateFile ?? process.env.MUSE_BRIDGE_STATE_PATH ?? defaultStateFile();
    this.hostPromise = null;
    this.host = null;
    this.connection = null;
    this.stderrTail = [];
    this.protocolErrors = [];
    this.account = null;
    this.accountRevision = 0;
    this.lastUsage = null;
    this.workspaceSessions = new Map();
    this.loadedSessions = new Set();
    this.sessionStatus = new Map();
    this.turns = new Map();
    this.stateLoaded = false;
    this.stateLoadPromise = null;
    this.stateSavePromise = Promise.resolve();
    this.hostGeneration = 0;
  }

  async #loadState() {
    if (this.stateLoaded) return;
    if (this.stateLoadPromise) return this.stateLoadPromise;
    this.stateLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.stateFile, "utf8"));
        if (parsed?.version !== 1 || !parsed.workspaces || typeof parsed.workspaces !== "object" || Array.isArray(parsed.workspaces)) {
          throw new Error("Unsupported bridge state format.");
        }
        const entries = Object.entries(parsed.workspaces);
        if (entries.some(([, sessionId]) => typeof sessionId !== "string")) throw new Error("Invalid bridge session mapping.");
        for (const [workspace, sessionId] of entries) {
          this.workspaceSessions.set(workspace, sessionId);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new BridgeError("STATE_READ_FAILED", "Could not read Muse bridge state.", { error: redactError(error) });
        }
      }
      this.stateLoaded = true;
    })().finally(() => { this.stateLoadPromise = null; });
    return this.stateLoadPromise;
  }

  async #saveState() {
    const payload = `${JSON.stringify({
      version: 1,
      workspaces: Object.fromEntries(this.workspaceSessions),
    }, null, 2)}\n`;
    const save = this.stateSavePromise.then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const temp = `${this.stateFile}.tmp`;
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, this.stateFile);
    });
    this.stateSavePromise = save.catch(() => {});
    return save;
  }

  async resolveWorkspace(input) {
    if (!input || typeof input !== "string") {
      throw new BridgeError(
        "WORKSPACE_REQUIRED",
        "An absolute workspace path is required so Muse Code stays inside the intended project.",
      );
    }
    if (!path.isAbsolute(input)) {
      throw new BridgeError("WORKSPACE_NOT_ABSOLUTE", "Muse workspace must be an absolute path.");
    }
    const resolved = await realpath(input);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new BridgeError("WORKSPACE_NOT_DIRECTORY", "Muse workspace must be a directory.");
    }
    if (resolved === path.parse(resolved).root) {
      throw new BridgeError("WORKSPACE_TOO_BROAD", "The filesystem root cannot be used as a Muse workspace.");
    }
    return resolved;
  }

  async ensureHost() {
    if (this.hostPromise) return this.hostPromise;
    const generation = ++this.hostGeneration;
    this.hostPromise = this.#startHost(generation).catch((error) => {
      this.#hostExited(generation);
      throw error;
    });
    return this.hostPromise;
  }

  #hostExited(generation) {
    for (const state of this.turns.values()) {
      if (state.hostGeneration !== generation || state.terminal || state.failure) continue;
      state.pending = null;
      state.failure = this.#hostExitError(state.sessionId, state.turnId);
      this.#signalTurn(state);
    }
    if (generation !== this.hostGeneration) return;
    this.hostPromise = null;
    this.host = null;
    this.connection = null;
    this.account = null;
    this.accountRevision += 1;
    this.lastUsage = null;
    this.loadedSessions.clear();
    this.sessionStatus.clear();
  }

  #hostExitError(sessionId = null, turnId = null) {
    return new BridgeError("MUSE_HOST_EXITED", "The Muse process ended before this operation settled. Inspect the retained session before retrying.", { session_id: sessionId, turn_id: turnId });
  }

  #checkConnection(connection) {
    if (!connection || this.connection !== connection) throw this.#hostExitError();
  }

  #checkAbort(signal) {
    if (signal?.aborted) throw new BridgeError("TURN_CANCELLED", "The Codex tool call was cancelled.");
  }

  async #startHost(generation) {
    this.museBin = await resolveMuseBinary(this.museBin);
    await this.#loadState();

    const env = subscriptionEnvironment();
    // Muse Code subscription auth is the browser/account lane. Never let an API
    // key override that lane inside this bridge process.

    const handshake = spawnMspConnection({
      command: this.museBin,
      args: ["serve"],
      cwd: homedir(),
      env,
      onStderr: (chunk) => {
        const safe = redactError(chunk);
        if (safe) this.stderrTail.push(safe);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      },
    });
    let exited = false;
    const onExit = () => { exited = true; this.#hostExited(generation); };
    handshake.exited.then(onExit, onExit);

    const spawned = await handshake.initialize({
      clientInfo: { name: "muse_code_bridge", version: BRIDGE_VERSION },
      capabilities: { experimentalApi: true, userInputDialogs: true },
    });
    if (exited || generation !== this.hostGeneration) throw this.#hostExitError();
    this.host = spawned;
    this.connection = spawned.connection;
    this.connection.onNotification((notification) => {
      if (generation === this.hostGeneration && this.connection === spawned.connection) this.#onNotification(notification);
    });
    this.connection.onProtocolError((error) => {
      if (generation !== this.hostGeneration || this.connection !== spawned.connection) return;
      this.protocolErrors.push(redactError(error));
      if (this.protocolErrors.length > 10) this.protocolErrors.shift();
    });
    await this.readAccount(spawned.connection);
    try {
      const usageResult = await spawned.connection.request("usage/read", {});
      this.#checkConnection(spawned.connection);
      this.lastUsage = usageResult?.usage ?? null;
    } catch {
      if (this.connection === spawned.connection) this.lastUsage = null;
    }
    if (exited || generation !== this.hostGeneration) throw this.#hostExitError();
    return spawned;
  }

  async request(method, params = {}, expectedConnection = null) {
    if (!expectedConnection) await this.ensureHost();
    const connection = expectedConnection ?? this.connection;
    this.#checkConnection(connection);
    return connection.request(method, params);
  }

  async command(method, params = {}, expectedConnection = null) {
    if (!expectedConnection) await this.ensureHost();
    const connection = expectedConnection ?? this.connection;
    this.#checkConnection(connection);
    return connection.command(method, params);
  }

  async readAccount(expectedConnection = null) {
    if (!expectedConnection) await this.ensureHost();
    const connection = expectedConnection ?? this.connection;
    this.#checkConnection(connection);
    const revision = this.accountRevision;
    let account;
    try {
      account = publicAccountState(await connection.request("account/read", {}));
    } catch (error) {
      if (isMethodMissing(error)) {
        account = { state: "unknown", credentialRequired: true };
      } else {
        throw error;
      }
    }
    this.#checkConnection(connection);
    if (revision === this.accountRevision) this.account = account;
    return this.account;
  }

  async readUsage(expectedConnection = null) {
    if (!expectedConnection) await this.ensureHost();
    const connection = expectedConnection ?? this.connection;
    this.#checkConnection(connection);
    const result = await connection.request("usage/read", {});
    this.#checkConnection(connection);
    this.lastUsage = result?.usage ?? null;
    return normalizeUsage(this.lastUsage, this.account);
  }

  async startSubscriptionLogin() {
    await this.ensureHost();
    const result = await this.connection.request("account/loginStart", { type: "deviceCode" });
    return {
      verification_url: result?.verificationUrl ?? null,
      user_code: result?.userCode ?? null,
      instructions:
        "Open the verification URL, sign in with the Meta account that owns the Muse Code subscription, and approve the displayed code.",
    };
  }

  async subscriptionStatus() {
    await this.ensureHost();
    const connection = this.connection;
    const account = await this.readAccount(connection);
    const usage = await this.readUsage(connection);
    return { account, usage };
  }

  async #assertSubscriptionLane() {
    await this.ensureHost();
    const connection = this.connection;
    const account = await this.readAccount(connection);
    this.#checkConnection(connection);
    this.#checkSubscriptionAccount(account);
    return { account, connection, generation: this.hostGeneration };
  }

  #checkSubscriptionAccount(account = this.account) {
    if (account?.state !== "accountLogin") {
      const reason = account?.state === "apiKey" || account?.state === "envKey"
        ? "Muse is using an API-key credential, which may be billed pay-as-you-go."
        : "Muse Code is not signed in with a Meta account.";
      throw new BridgeError(
        "SUBSCRIPTION_LOGIN_REQUIRED",
        `${reason} The bridge refused to run a model turn. Use start_muse_subscription_login first.`,
        { account },
      );
    }
  }

  async #withOptionalUsage(result, connection) {
    try {
      this.#checkConnection(connection);
      const usageResult = await connection.request("usage/read", {});
      this.#checkConnection(connection);
      this.lastUsage = usageResult?.usage ?? null;
      return { ...result, usage: normalizeUsage(this.lastUsage, this.account) };
    } catch {
      return { ...result, usage: null, usage_error: "Muse usage is temporarily unavailable." };
    }
  }

  #ensureTurn(sessionId, turnId, generation = this.hostGeneration) {
    let state = this.turns.get(turnId);
    if (state?.hostGeneration === generation) return state;
    if (generation !== this.hostGeneration) {
      state = makeTurnState(sessionId, turnId, generation);
      state.failure = this.#hostExitError(sessionId, turnId);
      return state;
    }
    if (!state) {
      state = makeTurnState(sessionId, turnId, generation);
      this.turns.set(turnId, state);
    } else if (state.hostGeneration !== undefined) {
      state = makeTurnState(sessionId, turnId, generation);
      this.turns.set(turnId, state);
    } else {
      state.hostGeneration = generation;
    }
    return state;
  }

  #signalTurn(state) {
    for (const listener of [...state.listeners]) listener();
  }

  #onNotification(notification) {
    const method = notification?.method;
    const params = notification?.params ?? {};

    if (method === "account/changed") {
      this.accountRevision += 1;
      this.account = publicAccountState(params);
    }
    if (method === "usage/changed") this.lastUsage = params;
    if (method === "session/statusChanged" && params.sessionId) {
      this.sessionStatus.set(params.sessionId, params.status);
    }

    const turnId = params.turnId ?? params.item?.turnId;
    const sessionId = params.sessionId;
    if (!turnId || !sessionId) return;
    const state = this.#ensureTurn(sessionId, turnId);

    if (method === "item/delta" && (!params.field || params.field === "text")) {
      state.liveText += params.delta ?? "";
      const now = Date.now();
      if (now - state.lastProgressAt >= 250) {
        state.lastProgressAt = now;
        const tail = state.liveText.slice(-220);
        for (const sink of state.progressSinks) sink(tail);
      }
    } else if (method === "item/completed") {
      const item = params.item;
      if (item?.kind === "agentMessage" && typeof item.text === "string") {
        state.agentMessages.push(item.text);
        state.liveText = item.text;
      }
    } else if (method === "approval/requested" || method === "approval/updated") {
      state.pending = { type: "approval", request: params };
    } else if (method === "approval/resolved") {
      if (state.pending?.type === "approval" && state.pending.request?.approvalId === params.approvalId) {
        state.pending = null;
      }
    } else if (method === "userInput/requested") {
      state.pending = { type: "user_input", request: params };
    } else if (method === "userInput/settled") {
      if (state.pending?.type === "user_input" && state.pending.request?.userInputId === params.userInputId) {
        state.pending = null;
      }
    } else if (method === "turn/completed") {
      state.terminal = params;
      state.pending = null;
    } else if (method === "turn/unqueued") {
      state.terminal = { terminal: "unqueued", ...params };
      state.pending = null;
    }
    this.#signalTurn(state);
  }

  async #pendingForSession(sessionId, connection = null) {
    // A live approval notification is the most current source and is already
    // folded by #onNotification. Prefer it before asking Muse to rebuild a
    // materialized projection, which can be unavailable for a resumed or
    // still-running session.
    const cached = [...this.turns.values()].reverse().find(
      (state) => state.sessionId === sessionId && state.pending,
    );
    if (cached) return cached.pending;

    let result;
    try {
      result = await this.request("approval/listPending", { sessionId }, connection);
    } catch (error) {
      if (!isPendingProjectionUnavailable(error)) throw error;

      // session/read is a point-in-time, lease-free read. Its pending pointers
      // tell us whether resuming could restore full request payloads. Never
      // overwrite a session that Muse reports as already loaded elsewhere.
      let snapshot;
      try {
        snapshot = await this.request("session/read", { sessionId, excludeItems: true }, connection);
      } catch (readError) {
        throw new BridgeError(
          "PENDING_STATE_UNAVAILABLE",
          "Muse could not materialize the pending request and the read-only session snapshot also failed.",
          { error: redactError(readError) },
        );
      }

      const pointers = Array.isArray(snapshot?.pendingRequests) ? snapshot.pendingRequests : [];
      if (pointers.length === 0) return null;

      try {
        const resumed = await this.command("session/resume", {
          sessionId,
          excludeItems: true,
          cursor: snapshot.viewCursor,
        }, connection);
        this.loadedSessions.add(sessionId);
        this.sessionStatus.set(sessionId, resumed?.session?.status ?? "idle");
      } catch (resumeError) {
        throw new BridgeError(
          "PENDING_STATE_UNAVAILABLE",
          "Muse found a pending request but could not attach to the session to restore its choices. The request was not approved.",
          {
            session_status: snapshot.session?.status ?? "unknown",
            pending_request_ids: pointers
              .map((pointer) => pointer.approvalId ?? pointer.userInputId)
              .filter(Boolean),
            error: redactError(resumeError),
          },
        );
      }

      const restored = [...this.turns.values()].reverse().find(
        (state) => state.sessionId === sessionId && state.pending,
      );
      if (restored) return restored.pending;

      try {
        result = await this.request("approval/listPending", { sessionId }, connection);
      } catch (resumeReadError) {
        throw new BridgeError(
          "PENDING_STATE_UNAVAILABLE",
          "Muse resumed the session but still could not return its pending request details.",
          { error: redactError(resumeReadError) },
        );
      }
    }

    const approval = result?.approvals?.[0];
    if (approval) {
      const state = this.#ensureTurn(sessionId, approval.turnId);
      state.pending = { type: "approval", request: approval };
      return state.pending;
    }
    const userInput = result?.userInputs?.[0];
    if (userInput) {
      const state = this.#ensureTurn(sessionId, userInput.turnId);
      state.pending = { type: "user_input", request: userInput };
      return state.pending;
    }
    return null;
  }

  async #openSession(workspace, newSession = false, connection = null) {
    if (!connection) await this.ensureHost();
    else this.#checkConnection(connection);
    if (!newSession) {
      const existing = this.workspaceSessions.get(workspace);
      if (existing) {
        if (!this.loadedSessions.has(existing)) {
          try {
            const resumed = await this.command("session/resume", {
              sessionId: existing,
              excludeItems: false,
              history: "auto",
            }, connection);
            this.loadedSessions.add(existing);
            this.sessionStatus.set(existing, resumed?.session?.status ?? "idle");
          } catch (error) {
            if (error?.kind !== "sessionNotFound" && error?.code !== -32020) throw error;
            this.workspaceSessions.delete(workspace);
            await this.#saveState();
          }
        }
        if (this.loadedSessions.has(existing)) return existing;
      }
    }

    const started = await this.command("session/start", {
      workspaceRoot: workspace,
      approvalMode: "onRequest",
    }, connection);
    const sessionId = started?.session?.sessionId;
    if (!sessionId) {
      throw new BridgeError("SESSION_START_FAILED", "Muse did not return a session id.");
    }
    this.workspaceSessions.set(workspace, sessionId);
    this.loadedSessions.add(sessionId);
    this.sessionStatus.set(sessionId, started?.session?.status ?? "idle");
    await this.#saveState();

    const suffix = createHash("sha256").update(workspace).digest("hex").slice(0, 6);
    const base = path.basename(workspace).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "workspace";
    try {
      await this.command("session/rename", {
        sessionId,
        name: `codex-bridge-${base}-${suffix}`,
      }, connection);
    } catch {
      // Naming is cosmetic; the durable session remains valid.
    }
    return sessionId;
  }

  #serializePending(pending) {
    if (!pending) return null;
    if (pending.type === "approval") {
      const request = pending.request;
      return {
        type: "approval",
        request_id: request.approvalId,
        session_id: request.sessionId,
        turn_id: request.turnId,
        tool_name: request.toolName,
        subject: request.subject,
        raw_args: request.rawArgs,
        protected_write: Boolean(request.protectedWrite),
        requirement_id: request.currentRequirementId,
        choices: (request.availableChoices ?? []).map((choice) => ({
          choice_id: choice.choiceId,
          label: choice.label,
          decision: choice.decision,
          scope: choice.scope,
          accepts_feedback: Boolean(choice.acceptsFeedback),
        })),
      };
    }
    const request = pending.request;
    return {
      type: "user_input",
      request_id: request.userInputId,
      session_id: request.sessionId,
      turn_id: request.turnId,
      auto_resolution_ms: request.autoResolutionMs ?? null,
      questions: request.questions ?? [],
    };
  }

  #turnResult(state) {
    if (state.failure) throw state.failure;
    if (state.pending) {
      return {
        status: "needs_user_action",
        session_id: state.sessionId,
        turn_id: state.turnId,
        response: state.agentMessages.join("\n\n") || state.liveText || null,
        pending: this.#serializePending(state.pending),
      };
    }
    const terminal = publicTurnTerminal(state.terminal);
    const response = state.agentMessages.join("\n\n") || state.liveText || "";
    const status = terminal?.terminal;
    if (!["completed", "failed", "cancelled", "unqueued"].includes(status)) {
      throw new BridgeError("UNKNOWN_TERMINAL_STATE", "Muse did not provide a recognized terminal state.", { terminal: status ?? null, session_id: state.sessionId, turn_id: state.turnId });
    }
    return {
      status,
      session_id: state.sessionId,
      turn_id: state.turnId,
      response: status === "failed" ? response || null : response,
      terminal,
    };
  }

  async #waitForTurn(state, { signal, onProgress, connection } = {}) {
    if (onProgress) state.progressSinks.add(onProgress);
    const cancel = () => {
      if (connection && this.connection === connection) {
        connection.command("turn/cancel", { sessionId: state.sessionId, turnId: state.turnId }).catch(() => {});
      }
    };
    try {
      if (signal?.aborted) { cancel(); this.#checkAbort(signal); }
      if (state.failure) throw state.failure;
      if (state.terminal || state.pending) return this.#turnResult(state);
      this.#checkConnection(connection);
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled || (!state.terminal && !state.pending && !state.failure)) return;
          settled = true;
          state.listeners.delete(finish);
          signal?.removeEventListener("abort", abort);
          try { resolve(this.#turnResult(state)); } catch (error) { reject(error); }
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          state.listeners.delete(finish);
          signal?.removeEventListener("abort", abort);
          reject(new BridgeError("TURN_CANCELLED", "The Codex tool call was cancelled."));
          cancel();
        };
        state.listeners.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else finish();
      });
    } finally {
      if (onProgress) state.progressSinks.delete(onProgress);
    }
  }

  async chat({ message, workspace, newSession = false, signal, onProgress }) {
    this.#checkAbort(signal);
    if (!message || typeof message !== "string" || !message.trim()) {
      throw new BridgeError("MESSAGE_REQUIRED", "A non-empty Muse message is required.");
    }
    const resolvedWorkspace = await this.resolveWorkspace(workspace);
    const subscription = await this.#assertSubscriptionLane();
    this.#checkAbort(signal);
    const { connection, generation } = subscription;
    const sessionId = await this.#openSession(resolvedWorkspace, newSession, connection);
    const existingPending = await this.#pendingForSession(sessionId, connection);
    this.#checkAbort(signal);
    this.#checkSubscriptionAccount();
    if (existingPending) {
      const state = this.#ensureTurn(sessionId, existingPending.request.turnId);
      return this.#withOptionalUsage(this.#turnResult(state), connection);
    }

    const ack = await this.command("turn/start", {
      sessionId,
      input: [{ type: "text", text: message }],
      displayText: message,
      ifBusy: "queue",
    }, connection);
    const turnId = ack?.turnId;
    if (!turnId) throw new BridgeError("TURN_START_FAILED", "Muse did not return a turn id.");
    const state = this.#ensureTurn(sessionId, turnId, generation);
    const result = await this.#waitForTurn(state, { signal, onProgress, connection });
    return this.#withOptionalUsage(result, connection);
  }

  async respond({ sessionId, requestId, action, choiceId, feedback, answers, clarification, signal, onProgress }) {
    this.#checkAbort(signal);
    const { connection, generation } = await this.#assertSubscriptionLane();
    if (!sessionId || !requestId) {
      throw new BridgeError("REQUEST_TARGET_REQUIRED", "session_id and request_id are required.");
    }
    const pending = await this.#pendingForSession(sessionId, connection);
    if (!pending) throw new BridgeError("NO_PENDING_REQUEST", "Muse has no pending request for this session.");
    const state = this.#ensureTurn(sessionId, pending.request.turnId, generation);
    this.#checkAbort(signal);
    this.#checkSubscriptionAccount();

    if (pending.type === "approval") {
      if (action !== "decide_approval") {
        throw new BridgeError("WRONG_REQUEST_ACTION", "This pending request requires decide_approval.");
      }
      if (pending.request.approvalId !== requestId) {
        throw new BridgeError("REQUEST_ID_MISMATCH", "The approval id is no longer current.");
      }
      const offered = (pending.request.availableChoices ?? []).find((choice) => choice.choiceId === choiceId);
      if (!offered) throw new BridgeError("CHOICE_NOT_OFFERED", "Select one of Muse's offered approval choices.");
      await this.command("approval/decide", {
        sessionId,
        approvalId: requestId,
        requirementId: pending.request.currentRequirementId,
        choiceId,
        feedback: feedback ?? null,
      }, connection);
    } else if (pending.request.userInputId !== requestId) {
      throw new BridgeError("REQUEST_ID_MISMATCH", "The user-input id is no longer current.");
    } else if (action === "answer_questions") {
      await this.command("userInput/answer", {
        sessionId,
        userInputId: requestId,
        answers: (answers ?? []).map((answer) => ({
          questionId: answer.question_id,
          ...(answer.selected_label ? { selectedLabel: answer.selected_label } : {}),
          ...(answer.selected_labels ? { selectedLabels: answer.selected_labels } : {}),
          ...(answer.free_text ? { freeText: answer.free_text } : {}),
          ...(answer.note ? { note: answer.note } : {}),
        })),
      }, connection);
    } else if (action === "clarify") {
      await this.command("userInput/clarify", {
        sessionId,
        userInputId: requestId,
        clarification: { format: "text", content: clarification ?? "" },
      }, connection);
    } else if (action === "cancel_questions") {
      await this.command("userInput/cancel", {
        sessionId,
        userInputId: requestId,
        reason: feedback ?? "User declined to answer in Codex.",
      }, connection);
    } else {
      throw new BridgeError("WRONG_REQUEST_ACTION", "Unsupported response action for the pending request.");
    }

    if (state.pending === pending) state.pending = null;
    const result = await this.#waitForTurn(state, { signal, onProgress, connection });
    return this.#withOptionalUsage(result, connection);
  }

  async cancel(sessionId, turnId) {
    if (!sessionId || !turnId) throw new BridgeError("TURN_TARGET_REQUIRED", "session_id and turn_id are required.");
    return this.command("turn/cancel", { sessionId, turnId });
  }

  async resetWorkspace(workspace) {
    const resolved = await this.resolveWorkspace(workspace);
    await this.#loadState();
    const previous = this.workspaceSessions.get(resolved) ?? null;
    this.workspaceSessions.delete(resolved);
    await this.#saveState();
    return { workspace: resolved, previous_session_id: previous, history_deleted: false };
  }

  async status(workspace = null) {
    await this.ensureHost();
    const connection = this.connection;
    const account = await this.readAccount(connection);
    let resolvedWorkspace = null;
    let sessionId = null;
    if (workspace) {
      resolvedWorkspace = await this.resolveWorkspace(workspace);
      sessionId = this.workspaceSessions.get(resolvedWorkspace) ?? null;
    }
    let pending = null;
    let pendingState = "available";
    let pendingError = null;
    if (sessionId) {
      try {
        pending = this.#serializePending(await this.#pendingForSession(sessionId, connection));
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "PENDING_STATE_UNAVAILABLE") throw error;
        pendingState = "unavailable";
        pendingError = { code: error.code, message: redactDiagnostic(error), details: redactDiagnosticValue(error.details) };
      }
    }

    return this.#withOptionalUsage({
      muse_binary: this.museBin,
      server: this.host?.initializeResult?.serverInfo ?? null,
      schema: this.host?.initializeResult?.schema ?? null,
      account,
      workspace: resolvedWorkspace,
      session_id: sessionId,
      session_status: sessionId ? this.sessionStatus.get(sessionId) ?? null : null,
      pending,
      pending_state: pendingState,
      pending_error: pendingError,
      api_key_override_removed: true,
      protocol_errors: this.protocolErrors,
    }, connection);
  }

  async close() {
    if (this.host) await this.host.close();
  }
}
