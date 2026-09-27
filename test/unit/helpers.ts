// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Starts a --fake signal-headless daemon in a scratch directory.
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The daemon binary for tests: $SIGNAL_HEADLESS_BIN, else the pinned release
// fetched by `npm run fetch-daemon` (.daemon/), else a signal-headless
// source checkout next to this one (../bin, ../signal-headless/bin).
export const binary = process.env.SIGNAL_HEADLESS_BIN ||
  [path.resolve(".daemon", "signal-headless"), path.resolve("..", "bin", "signal-headless"), path.resolve("..", "signal-headless", "bin", "signal-headless")]
    .find((p) => fs.existsSync(p)) || path.resolve(".daemon", "signal-headless");

export interface FakeDaemon {
  dir: string;
  socket: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startFake(dir = fs.mkdtempSync(path.join(os.tmpdir(), "shv-test-"))): Promise<FakeDaemon> {
  if (!fs.existsSync(binary)) {
    throw new Error(`${binary} missing: run \`npm run fetch-daemon\` (or set SIGNAL_HEADLESS_BIN)`);
  }
  const socket = path.join(dir, "s.sock");
  // Short placeholder lifetime so tests can watch deleted messages go away.
  const proc = spawn(binary, ["--daemon", "--fake", "--data", dir, "--socket", socket, "--deleted-ttl", "2s"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += d));
  await waitFor(() => fs.existsSync(socket), 10_000, () => `fake daemon did not start: ${stderr}`);
  return {
    dir,
    socket,
    proc,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
      }),
  };
}

export async function waitFor(cond: () => boolean, ms = 5000, what: string | (() => string) = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// pidsWithArg lists signal-headless processes whose command line contains arg.
export function pidsWithArg(arg: string): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) {
      continue;
    }
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
      if (path.basename(argv[0]) === "signal-headless" && argv.includes(arg)) {
        out.push(Number(d));
      }
    } catch {
      // exited
    }
  }
  return out;
}

// linkWrapper writes a stand-in for signal-headless that behaves like an
// unlinked host until `--link` succeeds, and like a --fake device afterwards.
// Nothing it runs can reach the real account: before linking it points at an
// empty scratch store, afterwards everything runs with --fake.
export function linkWrapper(dir: string): string {
  const wrapper = path.join(dir, "signal-headless");
  fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh
D='${dir}'
B='${binary}'
echo "$*" >> "$D/calls"
for a in "$@"; do
  if [ "$a" = "--link" ]; then
    "$B" "$@" --fake | while IFS= read -r line; do
      case "$line" in *'"linked"'*) touch "$D/linked" ;; esac
      printf '%s\\n' "$line"
    done
    exit 0
  fi
done
if [ -f "$D/linked" ]; then exec "$B" "$@" --fake --data "$D/fake"; fi
exec "$B" "$@" --data "$D/empty"
`, { mode: 0o755 });
  return wrapper;
}
