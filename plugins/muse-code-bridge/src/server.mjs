import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, MuseHostBridge } from "./muse-host.mjs";
import { redactDiagnostic } from "./privacy.mjs";
import {
  formatUsageText,
  USAGE_WIDGET_HTML,
  USAGE_WIDGET_URI,
} from "./usage.mjs";

const server = new McpServer(
  { name: "muse-code-bridge", version: "0.1.0" },
  { capabilities: { logging: {} } },
);
const bridge = new MuseHostBridge();

const MUSE_MODE_PROMPT = `Enable Muse mode for this Codex task.

For every later substantive user message in this same task, invoke the Muse Code Bridge and send that message to the retained Muse session for the active workspace. Do not answer the substance with Codex before Muse replies. Present the result as "Muse Code:" and keep it faithful.

Before the first Muse turn, verify the account with get_muse_status. If needed, start the subscription browser login. Never use a Meta API-key credential lane.

Bridge-control messages are handled locally instead of being forwarded: usage/status requests, approval or clarification responses, cancellation, starting a fresh Muse session, and leaving Muse mode. Muse mode ends when the user invokes /prompts:MuseOff, writes /MuseOff, or asks to leave Muse mode.`;

const MUSE_OFF_PROMPT = `Disable Muse mode for this Codex task now. Do not forward this command to Muse. Confirm that later user messages will be handled normally by Codex unless the user enables Muse mode again.`;

const textContent = (text) => [{ type: "text", text }];

function errorResult(error) {
  const code = error instanceof BridgeError ? error.code : "BRIDGE_ERROR";
  const message = redactDiagnostic(error);
  const details = error instanceof BridgeError ? error.details : {};
  return {
    isError: true,
    structuredContent: { status: "error", code, message, details },
    content: textContent(`${code}: ${message}`),
  };
}

function progressFor(extra) {
  let sequence = 0;
  return (tail) => {
    const token = extra?._meta?.progressToken;
    if (token === undefined) return;
    sequence += 1;
    extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: sequence,
        message: `Muse: ${tail}`,
      },
    }).catch(() => {});
  };
}

function museResult(result) {
  let message;
  if (result.status === "needs_user_action") {
    const pending = result.pending;
    message = pending?.type === "approval"
      ? `Muse paused for approval of ${pending.tool_name ?? "a tool"}. Ask the user to choose one offered choice, then call respond_to_muse.`
      : "Muse paused for user input. Ask the user the returned questions, then call respond_to_muse.";
  } else if (result.status === "failed") {
    message = result.response || "Muse reported that the turn failed.";
  } else {
    message = result.response || `Muse turn ${result.status}.`;
  }
  return {
    structuredContent: result,
    content: textContent(message),
  };
}

server.registerPrompt(
  "Muse",
  {
    title: "Muse",
    description: "Enable Muse mode for this task so later messages use the retained Muse Code subscription session.",
  },
  async () => ({
    description: "Enable task-scoped Muse mode",
    messages: [
      { role: "user", content: { type: "text", text: MUSE_MODE_PROMPT } },
    ],
  }),
);

server.registerPrompt(
  "MuseOff",
  {
    title: "Muse Off",
    description: "Leave Muse mode and return later messages in this task to normal Codex handling.",
  },
  async () => ({
    description: "Disable task-scoped Muse mode",
    messages: [
      { role: "user", content: { type: "text", text: MUSE_OFF_PROMPT } },
    ],
  }),
);

server.registerResource(
  "muse-usage-widget",
  USAGE_WIDGET_URI,
  {},
  async () => ({
    contents: [
      {
        uri: USAGE_WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: USAGE_WIDGET_HTML,
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  }),
);

server.registerTool(
  "start_muse_subscription_login",
  {
    title: "Start Muse subscription login",
    description:
      "Start Muse Code's browser/device login without a Terminal. Use this when status says the subscription account is not signed in. This does not run a model turn.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  async () => {
    try {
      const result = await bridge.startSubscriptionLogin();
      const text = result.verification_url
        ? `Open ${result.verification_url} and confirm code ${result.user_code ?? "shown by Meta"} with the Meta account that owns the Muse Code subscription.`
        : result.instructions;
      return { structuredContent: result, content: textContent(text) };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "chat_with_muse",
  {
    title: "Chat with Muse Code",
    description:
      "Send a message to the subscription-authenticated Muse Code agent for a local workspace and return Muse's response in this Codex conversation. Reuses one retained Muse session per workspace. Refuses API-key credential lanes.",
    inputSchema: {
      message: z.string().min(1).describe("The user's message for Muse Code, preserved faithfully."),
      workspace: z.string().min(1).describe("Absolute path to the intended local project workspace."),
      new_session: z.boolean().optional().default(false).describe("Start a fresh Muse session for this workspace."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Muse Code is working…",
      "openai/toolInvocation/invoked": "Muse Code replied.",
    },
  },
  async ({ message, workspace, new_session }, extra) => {
    try {
      const result = await bridge.chat({
        message,
        workspace,
        newSession: new_session,
        signal: extra.signal,
        onProgress: progressFor(extra),
      });
      return museResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "respond_to_muse",
  {
    title: "Respond to Muse request",
    description:
      "Continue a paused Muse turn after the user explicitly chooses an approval option or answers Muse's questions. Never infer an approval choice.",
    inputSchema: {
      session_id: z.string().min(1),
      request_id: z.string().min(1),
      action: z.enum(["decide_approval", "answer_questions", "clarify", "cancel_questions"]),
      choice_id: z.string().optional(),
      feedback: z.string().max(500).optional(),
      clarification: z.string().max(500).optional(),
      answers: z.array(z.object({
        question_id: z.string().min(1),
        selected_label: z.string().optional(),
        selected_labels: z.array(z.string()).optional(),
        free_text: z.string().max(500).optional(),
        note: z.string().max(500).optional(),
      })).optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    },
  },
  async (args, extra) => {
    try {
      const result = await bridge.respond({
        sessionId: args.session_id,
        requestId: args.request_id,
        action: args.action,
        choiceId: args.choice_id,
        feedback: args.feedback,
        clarification: args.clarification,
        answers: args.answers,
        signal: extra.signal,
        onProgress: progressFor(extra),
      });
      return museResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_muse_usage",
  {
    title: "Show Muse Code usage",
    description:
      "Read the authoritative Muse Code subscription usage windows and render a compact visual monitor. Does not run a model turn.",
    inputSchema: {
      refresh: z.boolean().optional().default(true),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
    _meta: {
      ui: { resourceUri: USAGE_WIDGET_URI },
      "openai/outputTemplate": USAGE_WIDGET_URI,
      "openai/toolInvocation/invoking": "Reading Muse usage…",
      "openai/toolInvocation/invoked": "Muse usage updated.",
    },
  },
  async () => {
    try {
      const { account, usage } = await bridge.subscriptionStatus();
      return {
        structuredContent: usage,
        content: textContent(formatUsageText(usage)),
        _meta: { account_lane: account?.state ?? "unknown" },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_muse_status",
  {
    title: "Get Muse bridge status",
    description:
      "Check Muse Code binary, subscription credential lane, bridge session, pending requests, and usage without running a model turn.",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute workspace path when session status is needed."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ workspace }) => {
    try {
      const result = await bridge.status(workspace);
      const lane = result.account?.state ?? "unknown";
      const session = result.session_id ? ` Session ${result.session_id} is ${result.session_status ?? "unknown"}.` : "";
      const pending = result.pending_state === "unavailable"
        ? ` Pending request details are temporarily unavailable: ${result.pending_error?.message ?? "unknown reason"}`
        : result.pending
          ? ` Muse is waiting for ${result.pending.type === "approval" ? "an approval" : "your input"}.`
          : " No pending Muse request.";
      return {
        structuredContent: result,
        content: textContent(`Muse credential lane: ${lane}.${session}${pending}`),
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "reset_muse_session",
  {
    title: "Start a fresh Muse conversation",
    description:
      "Clear the bridge's workspace-to-session mapping so the next Muse message starts a fresh retained conversation. Does not delete Muse history.",
    inputSchema: { workspace: z.string().min(1) },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ workspace }) => {
    try {
      const result = await bridge.resetWorkspace(workspace);
      return {
        structuredContent: result,
        content: textContent("The bridge will start a fresh Muse session next time. Existing Muse history was not deleted."),
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "cancel_muse_turn",
  {
    title: "Cancel Muse turn",
    description: "Cancel the named running Muse turn.",
    inputSchema: {
      session_id: z.string().min(1),
      turn_id: z.string().min(1),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ session_id, turn_id }) => {
    try {
      const result = await bridge.cancel(session_id, turn_id);
      return {
        structuredContent: { status: "cancellation_requested", result },
        content: textContent("Muse turn cancellation was requested."),
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function shutdown() {
  try {
    await bridge.close();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // stdout is reserved for MCP frames. Keep fatal diagnostics on stderr and
  // never include prompts or credentials.
  console.error(`muse-code-bridge: ${redactDiagnostic(error)}`);
  process.exit(1);
});
