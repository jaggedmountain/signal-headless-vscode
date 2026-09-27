// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fetches the daemon release this extension is pinned to into .daemon/, for
// the tests (npm run fetch-daemon). Same download and checksum code as the
// extension. SIGNAL_HEADLESS_RELEASES overrides the releases URL.
import * as fs from "node:fs";
import * as path from "node:path";
import { download, probe } from "../src/daemonBinary";

async function main(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { signalHeadless: { daemonVersion: string } };
  const version = process.env.SIGNAL_HEADLESS_VERSION || pkg.signalHeadless.daemonVersion;
  const baseUrl = process.env.SIGNAL_HEADLESS_RELEASES || "https://github.com/jaggedmountain/signal-headless/releases";
  const dir = path.resolve(".daemon");
  const exe = await download({ baseUrl, version, dir });
  const p = await probe(exe);
  console.log(`fetch-daemon: ${exe} (${p?.version}, protocol ${p?.protocol})`);
}

main().catch((err) => {
  console.error(`fetch-daemon: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
