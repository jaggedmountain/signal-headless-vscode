// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Launcher } from "../../src/launcher";
import { Session } from "../../src/session";
import { linkWrapper, pidsWithArg, waitFor } from "./helpers";

// Every daemon or --check here runs through linkWrapper, which pins a scratch
// store (or --fake): tests never open the real one.

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "shv-launch-"));
const quiet = () => undefined;

test("an unlinked host is reported as such, and linking starts the daemon", async () => {
  const dir = scratch();
  const socket = path.join(dir, "s.sock");
  const exe = linkWrapper(dir);
  const s = new Session({ socket, executable: async () => exe, autoStart: true, systemctl: "/nonexistent", log: quiet });
  s.start();
  try {
    await waitFor(() => s.state === "unlinked", 10_000, "unlinked state");
    assert.equal(fs.existsSync(socket), false, "no daemon without a device");
    // What the link panel runs:
    const out = spawnSync(exe, ["--link", "--json", "--name", "test", "--socket", socket], { encoding: "utf8" });
    const events = out.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["url", "linked"]);
    assert.match(events[0].url, /^sgnl:\/\/linkdevice\?/);
    s.linked();
    await waitFor(() => s.state === "connected", 15_000, "connected after linking");
    assert.equal(s.status?.account.number, "+15550000000");
  } finally {
    s.dispose();
    for (const pid of pidsWithArg(socket)) {
      process.kill(pid, "SIGTERM");
    }
  }
});

test("linking from a terminal is noticed without a reconnect", async () => {
  const dir = scratch();
  const socket = path.join(dir, "s.sock");
  const exe = linkWrapper(dir);
  const s = new Session({ socket, executable: async () => exe, autoStart: true, systemctl: "/nonexistent", log: quiet });
  s.start();
  try {
    await waitFor(() => s.state === "unlinked", 10_000, "unlinked state");
    fs.writeFileSync(path.join(dir, "linked"), "");
    await waitFor(() => s.state === "connected", 20_000, "connected after an outside link");
  } finally {
    s.dispose();
    for (const pid of pidsWithArg(socket)) {
      process.kill(pid, "SIGTERM");
    }
  }
});

test("the systemd user unit is preferred when installed", async () => {
  const dir = scratch();
  const socket = path.join(dir, "s.sock");
  const exe = linkWrapper(dir);
  fs.writeFileSync(path.join(dir, "linked"), "");
  // A stand-in systemctl: "cat" finds the unit, "start" runs the daemon the
  // way the unit would.
  const systemctl = path.join(dir, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh
echo "$*" >> '${dir}/systemctl.calls'
case "$2" in
  cat) exit 0 ;;
  start) setsid '${exe}' --daemon --socket '${socket}' >/dev/null 2>&1 < /dev/null & exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
  const s = new Session({ socket, executable: async () => exe, autoStart: true, systemctl, log: quiet });
  s.start();
  try {
    await waitFor(() => s.state === "connected", 15_000, "connected via the unit");
    const calls = fs.readFileSync(path.join(dir, "systemctl.calls"), "utf8").trim().split("\n");
    assert.deepEqual(calls, ["--user cat signal-headless.service", "--user start signal-headless.service"]);
    assert.ok(!fs.readFileSync(path.join(dir, "calls"), "utf8").includes("--foreground=false"), "no detached daemon of our own");
  } finally {
    s.dispose();
    for (const pid of pidsWithArg(socket)) {
      process.kill(pid, "SIGTERM");
    }
  }
});

test("check asks a running daemon instead of opening its store", async () => {
  const dir = scratch();
  const exe = linkWrapper(dir);
  const socket = path.join(dir, "s.sock");
  const launcher = new Launcher({ executable: exe, socket, log: quiet });
  assert.deepEqual((({ linked, daemonRunning }) => ({ linked, daemonRunning }))(await launcher.check()), { linked: false, daemonRunning: false });
  fs.writeFileSync(path.join(dir, "linked"), "");
  await launcher.start();
  try {
    const check = await launcher.check();
    assert.equal(check.daemonRunning, true);
    assert.equal(check.number, "+15550000000");
  } finally {
    for (const pid of pidsWithArg(socket)) {
      process.kill(pid, "SIGTERM");
    }
  }
});
