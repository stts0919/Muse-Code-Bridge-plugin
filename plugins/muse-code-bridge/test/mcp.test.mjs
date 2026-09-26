import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("bundled MCP server exposes the bridge tools and usage widget", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.mjs"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "muse-code-bridge-test", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "cancel_muse_turn",
      "chat_with_muse",
      "get_muse_status",
      "get_muse_usage",
      "reset_muse_session",
      "respond_to_muse",
      "start_muse_subscription_login",
    ]);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["Muse", "MuseOff"]);
    const musePrompt = await client.getPrompt({ name: "Muse", arguments: {} });
    assert.match(musePrompt.messages[0].content.text, /every later substantive user message/i);
    assert.match(musePrompt.messages[0].content.text, /MuseOff/);

    const resource = await client.readResource({
      uri: "ui://muse-code-bridge/usage-v1.html",
    });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /Muse Code usage/);
  } finally {
    await client.close();
  }
});
