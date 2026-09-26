import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: ["src/server.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.mjs",
  legalComments: "linked",
  metafile: true,
});

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll("\\", "/").match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
const notices = ["# Third-party notices", "", "The bundled server includes the following packages. Original license texts follow.", ""];
for (const name of [...packages].sort()) {
  const directory = path.join("node_modules", name);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  let licenseText = null;
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE-MIT", "LICENSE.txt", "license", "license.md"]) {
    try {
      licenseText = await readFile(path.join(directory, candidate), "utf8");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!licenseText) throw new Error(`Missing license text for bundled package ${name}`);
  notices.push(`## ${name} ${manifest.version}`, "", licenseText.trim(), "");
}
await writeFile("THIRD_PARTY_NOTICES.md", notices.join("\n"));
console.log(`Built bundled MCP server; preserved license texts for ${packages.size} dependencies.`);
