import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Check exactly the staged/indexed release files, including generated bundles.
function gitOutput(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // Child-process errors contain captured file contents; never print them.
    console.error("Could not read the Git index. Public-artifact check failed.");
    process.exit(1);
  }
}
const files = gitOutput(["ls-files", "-z"]).split("\0").filter(Boolean);
if (!files.length) throw new Error("No indexed files to inspect. Stage the intended public files first.");
const privateName = path.basename(homedir());
const rules = [
  ["private home path", /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'<>]+/i],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["provider token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["credential URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];
const forbiddenFile = /(?:^|\/)(?:node_modules|sessions|transcripts|auth\.json|state\.json(?:\.tmp)?|credentials\.json|\.env(?:\..*)?|\.DS_Store)(?:\/|$)|\.(?:log|map|pem|key|p12)$/i;
const failures = [];
for (const file of files) {
  if (forbiddenFile.test(file)) failures.push(`${file}: runtime or private file`);
  if ((await lstat(file)).isSymbolicLink()) { failures.push(`${file}: symlink`); continue; }
  const content = gitOutput(["show", `:${file}`]);
  for (const [label, rule] of rules) if (rule.test(content)) failures.push(`${file}: ${label}`);
  if (!/^(?:runner|root|user|node|codex)$/i.test(privateName) && content.includes(privateName)) failures.push(`${file}: local account identifier`);
}
if (failures.length) {
  console.error(failures.join("\n")); // Never echo matching credential values.
  process.exit(1);
}
console.log(`Public-artifact check passed for ${files.length} indexed files; no detected private paths, credentials, runtime records, or symlinks.`);
