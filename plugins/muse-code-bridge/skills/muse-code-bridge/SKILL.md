---
name: muse-code-bridge
description: "Use the user's Muse Code subscription from a Codex conversation through the local Muse Code Bridge, including task-scoped Muse mode, retained back-and-forth sessions, explicit approval handling, and subscription-usage monitoring. Trigger for Muse, Muse Code, /Muse mode, delegation to Muse, or Muse usage. Do not use for Meta Model API pay-as-you-go requests."
---

# Muse Code Bridge

Use the bundled `muse-code-bridge` MCP tools. The bridge starts Meta's installed `muse serve` locally and refuses model turns unless Muse reports the browser/account login lane. Before spawning Muse, it copies the process environment and removes `META_API_KEY` and `MODEL_API_KEY` only from the child copy. It does not change the parent process, shell, environment files, or saved credentials.

If the tools are unavailable, read [setup.md](references/setup.md) and help connect the local MCP server. A skill file alone does not install or authenticate Muse Code. Do not substitute direct Meta Model API calls for the subscription bridge.

## Muse mode

The plugin exposes the custom prompts `/prompts:Muse` and `/prompts:MuseOff`. The Muse skill also appears as **Muse** in the `/` command menu, so typing `/Muse` and selecting that entry enables the same workflow.

After Muse mode is enabled in a task:

- Route every later substantive user message in that task through `chat_with_muse` and the retained Muse session for the active workspace.
- Do not answer the substantive request with Codex before Muse replies and do not silently combine an independent Codex answer with Muse's answer.
- Handle bridge-control messages locally: usage/status, login, approvals or clarification answers, cancellation, session reset, and leaving Muse mode.
- Keep the mode task-scoped through the activation instruction already present in the conversation. Do not apply it to another task.
- Exit Muse mode when the user invokes `/prompts:MuseOff`, writes `/MuseOff`, or asks to leave Muse mode. Do not forward the exit instruction to Muse.

If the raw text `/Muse` reaches the model instead of command selection, treat it as an activation request. Confirm the mode after checking Muse status; do not forward the literal activation command as a Muse task.

## Conversation workflow

1. Before the first Muse turn in a task, call `get_muse_status` with the absolute current workspace.
2. If the credential lane is not `accountLogin`, call `start_muse_subscription_login`. Give the verification URL and code to the user and wait for them to complete browser approval. Call `get_muse_status` again before proceeding.
3. Call `chat_with_muse` with the user's intended Muse message and the absolute current workspace. Preserve the user's requirements and constraints; do not substitute a different task.
4. Present Muse's response clearly as `Muse Code:`. Keep substantive details faithful. You may add a short Codex note only when it helps distinguish relay status or a safety boundary.
5. Continue the same Muse session for later turns in that workspace. Set `new_session` only when the user explicitly asks for a fresh Muse conversation or after `reset_muse_session`.

Progress notifications are partial Muse output, not a completed answer. Wait for the tool's final result or a structured pending request.

An `unqueued` result means the queued turn was retracted; do not present it as completed work. `MUSE_HOST_EXITED`, `TURN_CANCELLED`, or `UNKNOWN_TERMINAL_STATE` do not authorize automatic resubmission. If a result includes `usage: null` and `usage_error`, retain its authoritative response/status and explain only that the meter is unavailable.

## Approvals and questions

When `chat_with_muse` returns `needs_user_action`:

- Show the user the exact operation or questions and the offered choices.
- Read `structuredContent.pending`; the short text message alone may omit the choices. If the host cannot expose it, call `get_muse_status` for the active workspace to recover the pending request.
- Never infer or automatically select an approval choice.
- After the user decides, call `respond_to_muse` with the exact session, request, choice, or answers returned by the bridge.
- Continue until Muse completes, fails, is cancelled, or needs another user decision.

Use `cancel_muse_turn` when the user asks to stop a running Muse turn.

## Usage monitoring

Call `get_muse_usage` when the user asks about Muse usage, quota, remaining allowance, reset time, or the usage monitor. Its structured values come from Muse MSP `usage/read`; do not infer missing values or convert them into token counts when Muse reports only percentages. The tool renders the compact usage widget when the client supports MCP Apps.

## Boundaries

- Do not call Meta Model API directly and do not ask for, expose, or forward an API key.
- Do not treat `MODEL_API_KEY` or a configured Meta provider in Codex as Muse subscription access.
- Do not claim a model turn used the subscription unless the bridge accepted it under `accountLogin`.
- Do not save account data, login codes, usage snapshots, workspace mappings, transcripts, or credentials into the public plugin repository.
- Diagnostics are redacted at the bridge response boundary. Conversation/progress text, exact pending operations, workspace paths, login codes, and session/request/choice identifiers are intentional local payloads and are not blanket-filtered. Do not describe all MCP output as anonymized or credential-free.
- `reset_muse_session` clears only the bridge mapping; it does not delete Muse history.
