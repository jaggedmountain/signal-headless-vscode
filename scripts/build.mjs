// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bundles the extension host code and the chat webview script with esbuild.
//   node scripts/build.mjs [--watch] [--production] [--tests]
import * as esbuild from "esbuild";
import { readdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const tests = process.argv.includes("--tests");
const tools = process.argv.includes("--tools");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "warning",
};

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node20", external: ["vscode"] },
  { ...common, entryPoints: ["webview/chat.ts"], outfile: "dist/chat.js", platform: "browser", format: "iife", target: "es2022" },
  // The vscode:uninstall hook: plain Node, run after the extension is gone.
  { ...common, entryPoints: ["src/uninstallHook.ts"], outfile: "dist/uninstall.js", platform: "node", format: "cjs", target: "node20" },
];

if (tests) {
  const unit = readdirSync("test/unit").filter((f) => f.endsWith(".test.ts")).map((f) => `test/unit/${f}`);
  const suite = readdirSync("test/suite").filter((f) => f.endsWith(".ts")).map((f) => `test/suite/${f}`);
  builds.push({ ...common, entryPoints: [...unit, ...suite, "test/runVSCode.ts"], outdir: "out/test", outbase: "test", platform: "node", format: "cjs", target: "node20", external: ["vscode", "mocha", "@vscode/test-electron"] });
}

if (tools) {
  builds.length = 0;
  builds.push({ ...common, entryPoints: ["scripts/fetch-daemon.ts"], outfile: "out/fetch-daemon.js", platform: "node", format: "cjs", target: "node20" });
}

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
