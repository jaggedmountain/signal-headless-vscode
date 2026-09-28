// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { deletableDataDir, execute, installerUninstaller, plan, within } from "../../src/removal";
import { cleanUp } from "../../src/uninstallHook";
import { binary, startFake, waitFor } from "./helpers";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "shv-rm-"));
const quiet = () => undefined;

test("an installer's uninstaller is found next to its binary", () => {
  const d = scratch();
  fs.mkdirSync(path.join(d, "bin"));
  fs.mkdirSync(path.join(d, "libexec", "signal-headless"), { recursive: true });
  fs.writeFileSync(path.join(d, "libexec", "signal-headless", "uninstall.sh"), "");
  assert.equal(installerUninstaller(path.join(d, "bin", "signal-headless"), "linux"), path.join(d, "bin", "..", "libexec", "signal-headless", "uninstall.sh"));
  fs.writeFileSync(path.join(d, "bin", "uninstall.ps1"), "");
  assert.equal(installerUninstaller(path.join(d, "bin", "signal-headless.exe"), "win32"), path.join(d, "bin", "uninstall.ps1"));
  assert.equal(installerUninstaller(path.join(scratch(), "bin", "signal-headless"), "linux"), undefined, "a binary without one");
});

test("within and the data-directory guard", () => {
  assert.ok(within("/a/b/daemon/v0.1.0/signal-headless", "/a/b/daemon"));
  assert.ok(!within("/a/b/daemonx/signal-headless", "/a/b/daemon"));
  assert.ok(!within("/a/b/daemon", "/a/b/daemon"));
  assert.ok(within("C:\\Users\\Me\\Daemon\\x.exe", "c:\\users\\me\\daemon", "win32") || process.platform !== "win32");
  assert.ok(!deletableDataDir(""));
  assert.ok(!deletableDataDir("relative/signal-headless"));
  assert.ok(!deletableDataDir(os.homedir()));
  assert.ok(!deletableDataDir(path.parse(process.cwd()).root));
  assert.ok(!deletableDataDir(scratch()), "an unrelated directory");
  assert.ok(deletableDataDir(path.join(os.homedir(), ".local", "share", "signal-headless")));
  const d = scratch();
  fs.writeFileSync(path.join(d, "signal-headless.db"), "");
  assert.ok(deletableDataDir(d), "holds the database");
});

// A stand-in daemon socket: answers status with the given executable and
// records shutdown.
function fakeSocket(exe: string): Promise<{ socket: string; calls: string[]; close: () => void }> {
  const socket = path.join(scratch(), "s.sock");
  const calls: string[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        calls.push(m.method);
        if (m.method === "shutdown") {
          c.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }) + "\n");
          server.close();
          return;
        }
        c.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { executable: exe } }) + "\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, calls, close: () => server.close() })));
}

test("uninstall hook: stops the daemon only if it's our download, and deletes the download", async () => {
  const root = path.join(scratch(), "daemon");
  fs.mkdirSync(path.join(root, "v0.1.0"), { recursive: true });
  fs.writeFileSync(path.join(root, "v0.1.0", "signal-headless"), "x");

  const ours = await fakeSocket(path.join(root, "v0.1.0", "signal-headless"));
  await cleanUp({ managedRoot: root, socket: ours.socket }, quiet);
  assert.ok(ours.calls.includes("shutdown"), "our daemon is stopped");
  assert.ok(!fs.existsSync(root), "the download is gone");

  fs.mkdirSync(root, { recursive: true });
  const theirs = await fakeSocket("/usr/local/bin/signal-headless");
  await cleanUp({ managedRoot: root, socket: theirs.socket }, quiet);
  theirs.close();
  assert.ok(!theirs.calls.includes("shutdown"), "someone else's daemon keeps running");
  assert.ok(!fs.existsSync(root));

  fs.mkdirSync(root, { recursive: true });
  await cleanUp({ managedRoot: root, socket: path.join(scratch(), "none.sock") }, quiet);
  assert.ok(!fs.existsSync(root), "no daemon running: still cleaned up");
});

test("removal: unlinks, stops the daemon, deletes its data and our download", async () => {
  const fake = await startFake();
  const env = { SIGNAL_HEADLESS_SOCKET: fake.socket, SIGNAL_HEADLESS_DATA: fake.dir };
  try {
    // As if the running binary were our download.
    const root = path.join(scratch(), "daemon");
    fs.mkdirSync(path.join(root, "v1"), { recursive: true });
    const bin = path.join(root, "v1", "signal-headless");
    fs.copyFileSync(binary, bin);
    fs.chmodSync(bin, 0o755);
    const p = await plan(bin, root, env);
    assert.equal(p.linked, true);
    assert.equal(p.number, "+15550000000");
    assert.equal(p.dataDir, fake.dir);
    assert.equal(p.managed, true);
    assert.equal(p.uninstaller, undefined);
    let askedAnyway = false;
    await execute(p, "+15550000000", root, env, quiet, async () => (askedAnyway = true));
    assert.ok(!askedAnyway, "unlinking succeeded");
    await waitFor(() => fake.proc.exitCode !== null, 10_000, "daemon stopped");
    assert.ok(!fs.existsSync(fake.dir), "data deleted");
    assert.ok(!fs.existsSync(root), "download deleted");
  } finally {
    await fake.stop();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("removal through an installer's uninstaller hands it the confirmation", async () => {
  const d = scratch();
  fs.mkdirSync(path.join(d, "bin"));
  fs.mkdirSync(path.join(d, "libexec", "signal-headless"), { recursive: true });
  const log = path.join(d, "log");
  // Stand-in uninstall.sh: records its arguments, the confirmation and stdin.
  fs.writeFileSync(path.join(d, "libexec", "signal-headless", "uninstall.sh"),
    `echo "args=$*" > '${log}'; echo "confirm=$SIGNAL_HEADLESS_CONFIRM" >> '${log}'; read n; echo "stdin=$n" >> '${log}'\n`);
  const bin = path.join(d, "bin", "signal-headless");
  const p = { bin, linked: true, number: "+15550000000", dataDir: path.join(d, "data"), uninstaller: installerUninstaller(bin), managed: false };
  await execute(p, "+15550000000", path.join(d, "none"), {}, quiet, async () => false);
  assert.equal(fs.readFileSync(log, "utf8"), "args=-y\nconfirm=+15550000000\nstdin=+15550000000\n");
});
