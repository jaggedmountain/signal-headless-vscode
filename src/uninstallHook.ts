// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "vscode:uninstall" hook (dist/uninstall.js): VS Code runs it with Node
// once the extension is uninstalled, without the vscode API or a way to ask
// anything. So it only cleans up after the extension itself: if the running
// daemon is the copy the extension downloaded, stop it, then delete the
// download. It never unlinks, never touches message history or keys, and
// leaves any other signal-headless install alone ("Signal: Remove
// signal-headless from This Computer…" is the full removal).
import * as fs from "node:fs";
import * as path from "node:path";
import { removeDir, stopIfOurs } from "./removal";

// State is written by the extension while it runs (extension.ts), since the
// hook can't look up the extension's storage or settings.
export interface UninstallState {
  managedRoot: string; // the extension's downloaded daemon(s)
  socket: string;
}

export const STATE_FILE = "uninstall-state.json";

export async function cleanUp(state: UninstallState, log: (line: string) => void): Promise<void> {
  if (!state.managedRoot || !fs.existsSync(state.managedRoot)) {
    return;
  }
  await stopIfOurs(state.socket, state.managedRoot, log);
  await removeDir(state.managedRoot);
  log(`deleted ${state.managedRoot}`);
}

async function main(): Promise<void> {
  const file = path.join(__dirname, "..", STATE_FILE);
  let state: UninstallState;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return; // never ran, or ran in development
  }
  await cleanUp(state, (line) => console.log(`signal-headless: ${line}`));
}

if (require.main === module) {
  main().catch((err) => console.error(`signal-headless: uninstall cleanup: ${err}`));
}
