# Muse Code Bridge plugin

[繁體中文文件](README.zh-TW.md) · [GitHub Pages](https://stts0919.github.io/Muse-Code-Bridge-plugin/)

Use an account-authenticated Muse Code session from a Codex conversation. The plugin includes a reusable **Muse** skill, a local MCP server, retained workspace sessions, explicit approval handling, and a subscription usage monitor.

This is an independent community integration. Muse Code itself is installed separately; the bridge launches the official CLI with `muse serve`. The repository contains code and synthetic tests only. It includes no account credentials, personal workspace mappings, or conversation history.

## Requirements

- Node.js 22 or newer on `PATH`.
- An installed Muse Code CLI supporting the account and usage MSP methods (tested with Muse Code 1.3.0).
- Muse Code browser/account login and an eligible subscription.
- A local MCP-capable host. The Codex skill and task mode are intended for Codex desktop and CLI.

Muse's subscription terms and usage limits still apply. The bridge strips `META_API_KEY` and `MODEL_API_KEY` from the Muse child environment, then refuses model turns unless Muse reports `accountLogin`. An account login alone does not prove every subscription entitlement; usage reports may be unavailable until Muse returns an observation.

## Install in Codex

1. Install Muse Code from the [official instructions](https://dev.meta.ai/docs/muse-code), then complete its browser login:

   ```sh
   muse --version
   muse login
   node --version
   ```

2. Add this repository as a plugin marketplace:

   ```sh
   codex plugin marketplace add stts0919/Muse-Code-Bridge-plugin
   ```

3. In Codex's plugin directory, select **Muse Code Bridge Public** and install **Muse Code Bridge**. Start a new task after installation so the skill and MCP tools load.

   The current Codex CLI also supports:

   ```sh
   codex plugin add muse-code-bridge@muse-code-bridge-public
   ```

The checked-in `dist/server.mjs` is bundled, so end users do not need `npm install` for this installation path. `node` and `muse` must still be visible to the desktop application's environment. If Muse is not on that `PATH`, configure the MCP process environment with `MUSE_BIN` pointing to the installed executable. Keep this machine-specific setting local.

## Use

Select **Muse** from the `/` skill menu, or ask:

```text
Use $muse-code-bridge to enable Muse mode for this task.
```

Plain `/Muse` also enables the mode when the skill receives it. MCP clients that expose prompt commands can use `/prompts:Muse`. Later substantive messages in the same task are relayed to a retained Muse session for the active workspace. Responses are labelled **Muse Code:**.

Try a read-only request first:

```text
Read this workspace and explain its entry points. Do not modify files yet.
```

When Muse requests approval or asks a question, the host displays the operation and choices. Choose explicitly; the skill must not infer your decision. To monitor usage, ask **Show Muse Code usage**. To return to ordinary Codex handling, type `/MuseOff` or ask to leave Muse mode.

Mode is enforced by the host following the skill/prompt instructions; it does not replace the host's model provider. Skill command discovery varies between hosts.

## Skill-only use and other MCP hosts

The skill lives at [`plugins/muse-code-bridge/skills/muse-code-bridge/SKILL.md`](plugins/muse-code-bridge/skills/muse-code-bridge/SKILL.md). Copying it alone gives the host instructions, but it also needs this repository's MCP server to call Muse.

For a manually configured MCP host, clone the repo and point a stdio MCP entry at the bundled server:

```json
{
  "mcpServers": {
    "muse-code-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/Muse-Code-Bridge-plugin/plugins/muse-code-bridge/dist/server.mjs"]
    }
  }
}
```

Replace only the example path on your machine. Claude Code and VS Code MCP clients use different configuration locations; follow your host's documentation. The seven MCP tools are portable, but automatic Muse mode and the usage widget depend on the host's prompt/skill and MCP Apps support.

## Available tools

| Tool | Purpose |
|---|---|
| `get_muse_status` | Read binary, account lane, session, and pending requests |
| `start_muse_subscription_login` | Return Meta's browser/device verification URL and code |
| `chat_with_muse` | Send a workspace message to a retained Muse session |
| `respond_to_muse` | Return the user's exact approval choice or answers |
| `get_muse_usage` | Read current subscription window observations |
| `cancel_muse_turn` | Request cancellation of a specific running turn |
| `reset_muse_session` | Clear a workspace mapping without deleting Muse history |

## Local state and privacy

Only a workspace-to-session mapping is written by the bridge. It defaults to the operating system's user state directory:

- macOS: `~/Library/Application Support/Muse Code Bridge/state.json`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/muse-code-bridge/state.json`
- Windows: `%LOCALAPPDATA%/Muse Code Bridge/state.json`

Override it locally with `MUSE_BRIDGE_STATE_PATH`, preferably outside your Git workspace. On POSIX systems the bridge creates state directories with mode `0700` and files with mode `0600`; Windows relies on the user's directory ACLs.

Account labels/emails are omitted from status and usage responses. Diagnostic redaction covers common credentials and email patterns. No analytics or hosted bridge service is included. The usage widget has no external assets or network endpoints.

During actual use, prompts and selected workspace content are processed by Muse/Meta and may be recorded by Muse Code or the MCP host under their normal policies. Session IDs, required workspace paths, agent output, and pending operations pass through the local MCP connection. Resetting the bridge mapping does not delete those histories. Do not upload runtime state, logs, exports, or screenshots containing private information to this repository.

## Development

The existing runtime dependencies are pinned: MCP SDK for protocol transport, Muse SDK for MSP, and Zod for tool argument schemas. Esbuild is a development-only bundler. No additional runtime dependency is needed by the published bundle.

```sh
git clone https://github.com/stts0919/Muse-Code-Bridge-plugin.git
cd Muse-Code-Bridge-plugin/plugins/muse-code-bridge
npm ci
npm run check
npm run build
npm test
cd ../..
node scripts/check-public.mjs
```

Tests use synthetic data and do not invoke a model, access credentials, or consume a subscription. Building also generates third-party license notices for the bundled dependencies. Before committing, review the staged files and run the public-artifact check; use a private-email Git setting for your own commits.

## License

MIT. Third-party dependency licenses are preserved in [`THIRD_PARTY_NOTICES.md`](plugins/muse-code-bridge/THIRD_PARTY_NOTICES.md) and the bundle's legal notices. This project is not affiliated with Meta or OpenAI.
