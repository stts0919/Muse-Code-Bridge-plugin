# Muse Code Bridge plugin｜繁體中文

[English](README.md) · [線上使用文件](https://stts0919.github.io/Muse-Code-Bridge-plugin/)

在 Codex 對話中使用已登入 Meta 帳號的 Muse Code。套件包含 **Muse skill**、本機 MCP server、保留的 workspace session、使用者核准流程，以及訂閱用量監控。

這是獨立的社群整合。你需要另外安裝官方 Muse Code CLI；Bridge 會在你的電腦上執行 `muse serve`。本 Repo 只包含程式碼與合成測試資料，沒有帳號憑證、個人 workspace 對應表或對話歷史。

## 使用前準備

- Node.js 22 或更新版本，且 `node` 可從 `PATH` 執行。
- 支援帳號與用量 MSP 方法的官方 Muse Code CLI，目前驗證版本為 1.3.0。
- 以 Meta 帳號完成 Muse Code 的瀏覽器登入，並具有適用的訂閱資格。
- 支援本機 MCP 的工具。套件中的 skill 與 task 模式主要為 Codex Desktop／CLI 設計。

Bridge 會從 Muse 子程序環境移除 `META_API_KEY` 和 `MODEL_API_KEY`，並且只在 Muse 回報 `accountLogin` 時允許模型回合。訂閱條款與限額仍由 Meta 決定；帳號已登入並不等於所有訂閱權益都已驗證。尚未取得用量觀測時，監控會顯示資料未提供。

## 在 Codex 安裝

1. 依照 [Meta 官方文件](https://dev.meta.ai/docs/muse-code)安裝 Muse Code，再完成瀏覽器登入：

   ```sh
   muse --version
   muse login
   node --version
   ```

2. 把此 Repo 加入 Codex 的 plugin marketplace：

   ```sh
   codex plugin marketplace add stts0919/Muse-Code-Bridge-plugin
   ```

3. 安裝 plugin：

   ```sh
   codex plugin add muse-code-bridge@muse-code-bridge-public
   ```

   或在 Codex plugin 目錄選擇 **Muse Code Bridge Public**，再安裝 **Muse Code Bridge**。

4. 開啟新的 Codex task，讓 skill 與 MCP tools 載入。

Repo 已附上打包好的 `dist/server.mjs`，使用者不需要執行 `npm install`。桌面 App 的環境必須能找到 `node` 與 `muse`。如果 Muse 不在 App 的 `PATH`，可在本機 MCP 環境設定 `MUSE_BIN`，指向已安裝的執行檔；個人路徑留在本機即可。

## 開啟、使用與離開 Muse 模式

從 `/` skill 選單選 **Muse**，或輸入：

```text
使用 $muse-code-bridge 開啟這個 task 的 Muse 模式。
```

當 skill 收到純文字 `/Muse`，也會啟用相同流程。支援 MCP prompt 指令的工具可以使用 `/prompts:Muse`。

開啟後，同一 task 後續的實質任務會傳給該 workspace 保留的 Muse session，回覆會標示 **Muse Code:**。你可以先試一個唯讀任務：

```text
請閱讀這個 workspace，說明程式進入點與啟動方式，先不要修改檔案。
```

Muse 要求核准或提出問題時，Codex 會顯示原始操作與選項。由你明確選擇，skill 不會推測你的決定。

輸入「顯示 Muse Code 用量」查看使用視窗與重置時間。輸入 `/MuseOff`，或說「離開 Muse 模式」，即可回到一般 Codex 處理。

Muse 模式由工具遵循 skill／prompt 指令來運作，沒有切換 Codex 本身的模型供應商。不同工具的 slash command 選單可能有所差異。

## 只安裝 skill，或接入其他 MCP 工具

Skill 位於 [`plugins/muse-code-bridge/skills/muse-code-bridge/SKILL.md`](plugins/muse-code-bridge/skills/muse-code-bridge/SKILL.md)。只複製 skill 會提供操作指引，但仍需要連接本 Repo 的 MCP server，才能呼叫 Muse。

手動設定 MCP 時，可先 clone 此 Repo，再新增 stdio server：

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

將示範路徑替換成你電腦上的 clone 位置。Claude Code 與 VS Code MCP client 的設定位置不同，請依各工具文件操作。七個 MCP tools 可供支援的 client 使用，但 Muse 自動模式與用量 widget 取決於 client 的 skill／prompt 與 MCP Apps 支援。

## 可用工具

| Tool | 用途 |
|---|---|
| `get_muse_status` | 查看執行檔、登入通道、session 與待處理請求 |
| `start_muse_subscription_login` | 取得 Meta 瀏覽器授權網址與代碼 |
| `chat_with_muse` | 把 workspace 訊息傳給保留的 Muse session |
| `respond_to_muse` | 傳回使用者選定的核准選項或答案 |
| `get_muse_usage` | 讀取目前訂閱使用視窗 |
| `cancel_muse_turn` | 要求取消指定回合 |
| `reset_muse_session` | 清除 workspace 對應，不刪除 Muse 歷史 |

## 本機資料與隱私

Bridge 只會保存 workspace 與 session 的對應，預設位置為：

- macOS：`~/Library/Application Support/Muse Code Bridge/state.json`
- Linux：`${XDG_STATE_HOME:-~/.local/state}/muse-code-bridge/state.json`
- Windows：`%LOCALAPPDATA%/Muse Code Bridge/state.json`

可以在本機用 `MUSE_BRIDGE_STATE_PATH` 改變位置，建議放在 Git repo 之外。POSIX 系統建立目錄時使用 `0700`、檔案使用 `0600`；Windows 則依使用者目錄 ACL 管理。

Status 與用量回覆會省略帳號名稱和 Email；診斷訊息會遮蔽常見 credential 和 Email 格式。專案沒有加入分析追蹤或託管 Bridge 服務，用量 widget 也沒有外部素材與網路端點。

實際使用時，提示詞與選取的 workspace 內容會交由 Muse／Meta 處理，也可能依 Muse Code 或 MCP 工具的既有規則保留紀錄。Session ID、必要路徑、代理輸出與待核准操作會經過本機 MCP 連線。重設 Bridge 對應不會刪除這些歷史；請勿把 runtime state、log、匯出對話或含個資的截圖上傳本 Repo。

## 開發與驗證

既有 dependency 已鎖定版本：MCP SDK 負責傳輸協定、Muse SDK 負責 MSP、Zod 負責參數 schema，Esbuild 僅用於開發打包。

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

測試只使用合成資料，不呼叫模型、不讀取 credential，也不使用訂閱額度。打包會產生第三方授權聲明。提交前請檢查 staged 檔案，執行公開檢查，並為自己的 Git commit 使用非私人 Email 設定。

## 授權

MIT。第三方授權保留在 [`THIRD_PARTY_NOTICES.md`](plugins/muse-code-bridge/THIRD_PARTY_NOTICES.md) 與 bundle 授權聲明。此專案與 Meta、OpenAI 沒有隸屬關係。
