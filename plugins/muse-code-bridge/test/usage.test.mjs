import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsageText,
  normalizeUsage,
  USAGE_WIDGET_HTML,
} from "../src/usage.mjs";

test("normalizes Muse subscription windows without inventing history", () => {
  const result = normalizeUsage(
    {
      observedAtMs: 1_800_000_000_000,
      tier: "high",
      window: {
        resetsAtMs: 1_800_000_300_000,
        usedPercent: 38,
        windowDurationMins: 300,
      },
      weekly: {
        resetsAtMs: 1_800_600_000_000,
        usedPercent: 12,
      },
    },
    { state: "accountLogin", label: "Example account", credentialRequired: true },
  );

  assert.equal(result.available, true);
  assert.equal(result.subscription_verified, true);
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows[0], {
    id: "current",
    label: "Current usage window",
    used_percent: 38,
    remaining_percent: 62,
    resets_at_ms: 1_800_000_300_000,
    window_duration_mins: 300,
    over_quota: false,
  });
  assert.equal(result.windows[1].window_duration_mins, null);
});

test("preserves over-quota observations while clamping remaining percent", () => {
  const result = normalizeUsage(
    {
      observedAtMs: 1,
      tier: "power",
      window: { resetsAtMs: 2, usedPercent: 112, windowDurationMins: 300 },
      weekly: { resetsAtMs: 3, usedPercent: 101 },
    },
    { state: "accountLogin", credentialRequired: true },
  );

  assert.equal(result.windows[0].used_percent, 112);
  assert.equal(result.windows[0].remaining_percent, 0);
  assert.equal(result.windows[0].over_quota, true);
});

test("reports truthful absence before subscription usage is observed", () => {
  const result = normalizeUsage(null, {
    state: "loggedOut",
    credentialRequired: true,
  });
  assert.equal(result.available, false);
  assert.equal(result.subscription_verified, false);
  assert.match(formatUsageText(result), /subscription is not verified/i);
});

test("usage widget is self-contained and has a refresh control", () => {
  assert.match(USAGE_WIDGET_HTML, /Muse Code usage/);
  assert.match(USAGE_WIDGET_HTML, /get_muse_usage/);
  assert.doesNotMatch(USAGE_WIDGET_HTML, /https?:\/\//);
});
