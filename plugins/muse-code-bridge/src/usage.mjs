export const USAGE_WIDGET_URI = "ui://muse-code-bridge/usage-v1.html";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageWindow(id, label, source, durationMins = null) {
  if (!source || typeof source !== "object") return null;
  const usedPercent = asFiniteNumber(source.usedPercent);
  const resetsAtMs = asFiniteNumber(source.resetsAtMs);
  if (usedPercent === null || resetsAtMs === null) return null;
  return {
    id,
    label,
    used_percent: usedPercent,
    remaining_percent: clamp(100 - usedPercent, 0, 100),
    resets_at_ms: resetsAtMs,
    window_duration_mins:
      asFiniteNumber(source.windowDurationMins) ?? durationMins,
    over_quota: usedPercent > 100,
  };
}

export function normalizeUsage(rawUsage, account = null) {
  const accountState = account && typeof account === "object"
    ? {
        state: typeof account.state === "string" ? account.state : "unknown",
        credential_required:
          typeof account.credentialRequired === "boolean"
            ? account.credentialRequired
            : null,
      }
    : { state: "unknown", credential_required: null };

  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      available: false,
      subscription_verified: false,
      tier: null,
      observed_at_ms: null,
      account: accountState,
      windows: [],
      note:
        accountState.state === "accountLogin"
          ? "Muse is signed in, but no subscription-usage observation is available yet."
          : "Muse Code subscription login is required before usage can be monitored.",
    };
  }

  const current = usageWindow(
    "current",
    "Current usage window",
    rawUsage.window,
  );
  const weekly = usageWindow("weekly", "Weekly usage", rawUsage.weekly);
  const tier = typeof rawUsage.tier === "string" ? rawUsage.tier : null;
  const observedAtMs = asFiniteNumber(rawUsage.observedAtMs);
  const windows = [current, weekly].filter(Boolean);

  return {
    available: Boolean(tier && observedAtMs !== null && windows.length),
    subscription_verified:
      accountState.state === "accountLogin" && Boolean(tier),
    tier,
    observed_at_ms: observedAtMs,
    account: accountState,
    windows,
    note:
      windows.length > 0
        ? "Usage is a point-in-time observation reported by Muse Code."
        : "Muse Code returned no usable subscription windows.",
  };
}

function formatTime(epochMs) {
  if (!Number.isFinite(epochMs)) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochMs));
}

export function formatUsageText(usage) {
  if (!usage.subscription_verified) {
    return [
      "Muse Code subscription is not verified for this bridge.",
      `Credential lane: ${usage.account?.state ?? "unknown"}.`,
      "Use start_muse_subscription_login and complete the Meta browser sign-in.",
    ].join("\n");
  }
  if (!usage.available) {
    return `Muse Code subscription is signed in (${usage.tier ?? "tier unavailable"}), but no usage window is available yet.`;
  }
  const lines = [`Muse Code subscription tier: ${usage.tier}`];
  for (const window of usage.windows) {
    lines.push(
      `${window.label}: ${window.used_percent}% used, ${window.remaining_percent}% remaining; resets ${formatTime(window.resets_at_ms)}.`,
    );
  }
  if (usage.observed_at_ms) {
    lines.push(`Observed ${formatTime(usage.observed_at_ms)}.`);
  }
  return lines.join("\n");
}

export const USAGE_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      --surface: color-mix(in srgb, Canvas 94%, CanvasText 6%);
      --surface-strong: color-mix(in srgb, Canvas 88%, CanvasText 12%);
      --text: CanvasText;
      --muted: color-mix(in srgb, CanvasText 62%, transparent);
      --accent: #6d5dfc;
      --accent-2: #8c7fff;
      --warning: #e38b2c;
      --border: color-mix(in srgb, CanvasText 14%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: transparent;
    }
    .shell {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface);
      padding: 16px;
      display: grid;
      gap: 14px;
    }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 16px; line-height: 1.25; letter-spacing: -0.01em; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .tier {
      white-space: nowrap;
      padding: 5px 9px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: color-mix(in srgb, var(--accent) 78%, CanvasText 22%);
      font-size: 11px;
      font-weight: 700;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
    .card { border: 1px solid var(--border); border-radius: 13px; background: var(--surface-strong); padding: 13px; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
    .label { color: var(--muted); font-size: 12px; }
    .value { font-size: 22px; font-weight: 760; letter-spacing: -0.04em; }
    .track { height: 8px; margin: 10px 0 8px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, CanvasText 10%, transparent); }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .25s ease; }
    .fill.over { background: var(--warning); }
    .meta { color: var(--muted); font-size: 11px; line-height: 1.45; }
    .empty { border: 1px dashed var(--border); border-radius: 12px; padding: 14px; color: var(--muted); font-size: 13px; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    button {
      appearance: none;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      border-radius: 9px;
      padding: 7px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button:disabled { opacity: .55; cursor: wait; }
    .stamp { color: var(--muted); font-size: 11px; }
  </style>
</head>
<body>
  <main class="shell" data-llm="Muse Code subscription usage monitor">
    <header>
      <div>
        <h1>Muse Code usage</h1>
        <div class="sub" id="account">Waiting for Muse Code…</div>
      </div>
      <div class="tier" id="tier">—</div>
    </header>
    <section class="grid" id="windows"></section>
    <footer>
      <div class="stamp" id="stamp"></div>
      <button id="refresh" type="button">Refresh</button>
    </footer>
  </main>
  <script>
    const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
    const fmt = (ms) => Number.isFinite(ms) ? new Intl.DateTimeFormat(undefined, {dateStyle:"medium", timeStyle:"short"}).format(new Date(ms)) : "Unavailable";
    const unwrap = (payload) => payload?.structuredContent ?? payload?.result?.structuredContent ?? payload?.result ?? payload ?? {};
    function render(payload) {
      const data = unwrap(payload);
      document.getElementById("tier").textContent = data.tier || "Unverified";
      const account = data.account || {};
      document.getElementById("account").textContent = account.state === "accountLogin"
        ? "Muse Code account login"
        : "Credential lane: " + (account.state || "unknown");
      const root = document.getElementById("windows");
      const windows = Array.isArray(data.windows) ? data.windows : [];
      if (!windows.length) {
        root.innerHTML = '<div class="empty">' + esc(data.note || "No subscription usage observation is available.") + '</div>';
      } else {
        root.innerHTML = windows.map((window) => {
          const used = Number(window.used_percent);
          const remaining = Number(window.remaining_percent);
          const width = Math.max(0, Math.min(100, Number.isFinite(used) ? used : 0));
          return '<article class="card">' +
            '<div class="row"><span class="label">' + esc(window.label) + '</span><span class="value">' + (Number.isFinite(remaining) ? remaining : "—") + '%</span></div>' +
            '<div class="track" aria-label="' + esc(window.label) + '"><div class="fill ' + (window.over_quota ? "over" : "") + '" style="width:' + width + '%"></div></div>' +
            '<div class="meta">Used ' + (Number.isFinite(used) ? used : "—") + '% · Resets ' + esc(fmt(window.resets_at_ms)) + '</div>' +
          '</article>';
        }).join("");
      }
      document.getElementById("stamp").textContent = data.observed_at_ms ? "Observed " + fmt(data.observed_at_ms) : "Refresh to read the latest observation";
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") render(message.params);
    }, {passive:true});
    if (window.openai?.toolOutput) render(window.openai.toolOutput);
    document.getElementById("refresh").addEventListener("click", async () => {
      const button = document.getElementById("refresh");
      button.disabled = true;
      button.textContent = "Refreshing…";
      try {
        if (window.openai?.callTool) {
          const result = await window.openai.callTool("get_muse_usage", {refresh:true});
          render(result);
        }
      } finally {
        button.disabled = false;
        button.textContent = "Refresh";
      }
    });
  </script>
</body>
</html>`;
