// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Removing signal-headless from this computer: the pieces shared by the
// "Remove signal-headless from This Computer…" command and the uninstall
// hook (uninstallHook.ts). Plain Node, no vscode API.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// installerUninstaller finds the uninstaller install.sh or install.ps1
// wrote for this binary, if it came from one.
export function installerUninstaller(bin: string, platform: string = process.platform): string | undefined {
  const p = platform === "win32"
    ? path.join(path.dirname(bin), "uninstall.ps1")
    : path.join(path.dirname(bin), "..", "libexec", "signal-headless", "uninstall.sh");
  return fs.existsSync(p) ? p : undefined;
}

// within reports whether file is inside dir (paths resolved; case-blind on
// Windows).
export function within(file: string, dir: string, platform: string = process.platform): boolean {
  const norm = (p: string) => (platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const f = norm(file);
  const d = norm(dir);
  return f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

// deletableDataDir guards the one recursive delete of user data: an
// absolute path that is signal-headless's (by name or by its database), and
// not a home or root directory.
export function deletableDataDir(dir: string): boolean {
  if (!dir || !path.isAbsolute(dir)) {
    return false;
  }
  const r = path.resolve(dir);
  if (r === path.parse(r).root || r === path.resolve(os.homedir())) {
    return false;
  }
  return path.basename(r).includes("signal-headless") || fs.existsSync(path.join(r, "signal-headless.db"));
}

export interface RunResult {
  code: number;
  output: string;
}

// run starts a program without a shell, with extra environment and
// optional stdin, and collects its output.
export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, input = "", timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.on("error", () => undefined); // the program may not read it
    child.stdin.end(input);
    let output = "";
    const add = (b: Buffer) => (output = (output + b.toString()).slice(-8000));
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: output + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

// rpc makes one JSON-RPC call on a fresh connection to the daemon's socket.
export function rpc<T>(socket: string, method: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const c = net.connect({ path: socket });
    let buf = "";
    const done = (err?: Error, v?: T) => {
      clearTimeout(timer);
      c.destroy();
      err ? reject(err) : resolve(v as T);
    };
    const timer = setTimeout(() => done(new Error(`${method}: no answer`)), timeoutMs);
    c.on("error", (err) => done(err));
    c.on("connect", () => c.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method }) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 1) {
            m.error ? done(new Error(m.error.message)) : done(undefined, m.result as T);
          }
        } catch {
          // not ours (notifications on a signal-cli style connection)
        }
      }
    });
  });
}

// stopIfOurs stops the daemon on socket if its binary is inside dir (our
// download), and waits for it to go. Other daemons are left alone; so is an
// older daemon that doesn't say which binary it is.
export async function stopIfOurs(socket: string, dir: string, log: (line: string) => void): Promise<void> {
  let exe = "";
  try {
    exe = (await rpc<{ executable?: string }>(socket, "status")).executable ?? "";
  } catch {
    return; // not running
  }
  if (!exe || !within(exe, dir)) {
    log(`leaving the running daemon alone (${exe || "binary unknown"})`);
    return;
  }
  await rpc(socket, "shutdown").catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    try {
      await rpc(socket, "status", 500);
    } catch {
      log(`stopped the daemon from ${exe}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// removeDir deletes a directory, retrying briefly (Windows releases a just
// stopped .exe a moment late).
export async function removeDir(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 10) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export interface RemovalPlan {
  bin: string;
  linked: boolean;
  number?: string;
  dataDir: string;
  uninstaller?: string; // install.sh / install.ps1's, when the binary came from one
  managed: boolean; // the binary is the extension's own download
}

// plan looks at what there is to remove (--check --json), without changing
// anything. env points the CLI at the extension's socket.
export async function plan(bin: string, managedRoot: string, env: NodeJS.ProcessEnv): Promise<RemovalPlan> {
  const r = await run(bin, ["--check", "--json"], env);
  let check: { linked?: boolean; number?: string; dataDir?: string };
  try {
    check = JSON.parse(r.output.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error(`signal-headless --check: ${r.output.trim() || `exit ${r.code}`}`);
  }
  return {
    bin,
    linked: !!check.linked,
    number: check.number,
    dataDir: check.dataDir ?? "",
    uninstaller: installerUninstaller(bin),
    managed: within(bin, managedRoot),
  };
}

// execute removes it: through the installer's uninstaller when there is one
// (it knows its own files), else directly. number answers the account-number
// confirmation of --unlink; unlinkFailed decides whether to delete the data
// anyway when unlinking fails (the phone would still list this computer).
export async function execute(
  p: RemovalPlan, number: string, managedRoot: string, env: NodeJS.ProcessEnv,
  log: (line: string) => void, unlinkFailed: (output: string) => Promise<boolean>,
): Promise<void> {
  const confirmEnv = { ...env, SIGNAL_HEADLESS_CONFIRM: number };
  const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ");
  if (p.uninstaller) {
    const [cmd, args] = process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p.uninstaller, "-Yes"]]
      : ["sh", [p.uninstaller, "-y"]];
    const r = await run(cmd, args as string[], confirmEnv, number + "\n");
    log(r.output.trim());
    if (r.code !== 0) {
      throw new Error(`the uninstaller failed: ${tail(r.output)}`);
    }
  } else {
    if (p.linked) {
      const r = await run(p.bin, ["--unlink"], confirmEnv, number + "\n");
      log(r.output.trim());
      if (r.code !== 0 && !(await unlinkFailed(tail(r.output)))) {
        throw new Error("stopped: nothing deleted");
      }
    }
    await run(p.bin, ["--stop"], env);
    for (let i = 0; i < 50 && (await run(p.bin, ["--status"], env)).code === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (deletableDataDir(p.dataDir)) {
      await removeDir(p.dataDir);
      log(`deleted ${p.dataDir}`);
    } else if (p.dataDir) {
      log(`not deleting ${p.dataDir}: it doesn't look like signal-headless's data directory`);
    }
  }
  if (p.managed && fs.existsSync(managedRoot)) {
    await removeDir(managedRoot);
    log(`deleted ${managedRoot}`);
  }
}
