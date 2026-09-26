# Local setup

This skill requires the MCP server packaged with Muse Code Bridge, Node.js 22+, and the official Muse Code CLI (tested on 1.3.0).

In Codex, add the repository marketplace with `codex plugin marketplace add stts0919/Muse-Code-Bridge-plugin`, then install Muse Code Bridge from the plugin directory and start a new task. The repo provides a bundled `dist/server.mjs`; end users do not need to download npm dependencies.

For another local MCP host, configure a stdio server with `command: node` and an absolute `args` path pointing to `plugins/muse-code-bridge/dist/server.mjs` in the user's clone. Configuration belongs to that user's machine; do not commit their paths.

Use the host's tool discovery to confirm `get_muse_status` is callable, then call it for the intended absolute workspace. If Muse is not found on the host's PATH, configure `MUSE_BIN` locally. If account state is not `accountLogin`, call `start_muse_subscription_login`, show Meta's verification URL/code, and wait for the user to complete browser approval. Recheck status afterward.

Keep the state file outside repositories. `MUSE_BRIDGE_STATE_PATH` can override the operating-system default. It contains private workspace/session mappings and must not be shared.

MCP prompt menus, skill shortcuts, and the usage widget vary by client. Seven tools and the usage text fallback are available even without MCP Apps rendering. Do not claim native Muse provider switching or a built-in subscription login in a third-party GUI.
