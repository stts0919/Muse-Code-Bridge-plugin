import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function defaultStateFile(env = process.env, platform = process.platform, home = homedir()) {
  const base = platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Muse Code Bridge")
    : platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Muse Code Bridge")
      : path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "muse-code-bridge");
  return path.join(base, "state.json");
}

export function subscriptionEnvironment(env = process.env) {
  const child = { ...env };
  delete child.META_API_KEY;
  delete child.MODEL_API_KEY;
  return child;
}

export async function resolveMuseBinary(binary = "muse", env = process.env) {
  const candidates = path.isAbsolute(binary) ? [binary] : (env.PATH || "")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) => process.platform === "win32" && !path.extname(binary)
      ? [path.join(directory, `${binary}.exe`), path.join(directory, binary)]
      : [path.join(directory, binary)]);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Muse Code executable was not found. Install Muse Code, add it to PATH, or set MUSE_BIN to its executable path.");
}
