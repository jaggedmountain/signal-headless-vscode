// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Launcher answers "is this host linked?" and starts the daemon — through
// the systemd user unit when one is installed (systemd then stays in charge
// of it), else as a detached process that outlives VS Code.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { cleanEnv } from "./env";

export interface CheckResult {
  linked: boolean;
  number?: string;
  deviceId?: number;
  daemonRunning: boolean;
  version: string;
  dataDir: string;
  socket: string;
}

export const UNIT = "signal-headless.service";
const EXIT_NOT_LINKED = 3;

export class NotLinkedError extends Error {
  constructor() {
    super("this computer is not linked to a Signal account");
    this.name = "NotLinkedError";
  }
}

export interface LauncherOptions {
  executable: string;
  socket: string;
  systemctl?: string; // for tests
  log: (line: string) => void;
}

export class Launcher {
  constructor(private readonly o: LauncherOptions) {}

  check(): Promise<CheckResult> {
    return new Promise((resolve, reject) => {
      execFile(this.o.executable, ["--check", "--json", "--socket", this.o.socket], { env: cleanEnv(process.env), timeout: 30_000 }, (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (err && code !== EXIT_NOT_LINKED) {
          reject(new Error(`${this.o.executable} --check: ${stderr.trim() || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as CheckResult);
        } catch {
          reject(new Error(`${this.o.executable} --check: unexpected output ${JSON.stringify(stdout.slice(0, 200))}`));
        }
      });
    });
  }

  // hasUnit reports whether the systemd user unit is installed.
  hasUnit(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.o.systemctl ?? "systemctl", ["--user", "cat", UNIT], { timeout: 10_000 }, (err) => resolve(!err));
    });
  }

  async start(): Promise<void> {
    const check = await this.check();
    if (check.daemonRunning) {
      return;
    }
    if (!check.linked) {
      throw new NotLinkedError();
    }
    if (await this.hasUnit()) {
      this.o.log(`starting the daemon: systemctl --user start ${UNIT}`);
      await run(this.o.systemctl ?? "systemctl", ["--user", "start", UNIT]);
    } else {
      this.o.log(`starting the daemon: ${this.o.executable} --daemon`);
      await this.spawnDetached();
    }
    await this.waitForSocket();
  }

  private spawnDetached(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.executable, ["--daemon", "--foreground=false", "--socket", this.o.socket], {
        detached: true, // setsid: survives this editor
        stdio: ["ignore", "ignore", "pipe"],
        env: cleanEnv(process.env),
      });
      let stderr = "";
      let done = false;
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4096)));
      const finish = (err?: Error) => {
        if (done) {
          return;
        }
        done = true;
        clearInterval(poll);
        clearTimeout(deadline);
        child.stderr?.destroy();
        child.removeAllListeners();
        child.unref();
        err ? reject(err) : resolve();
      };
      child.on("error", (err) => finish(err));
      child.on("exit", (code) => {
        if (code === EXIT_NOT_LINKED) {
          finish(new NotLinkedError());
          return;
        }
        const msg = stderr.trim().split("\n").pop() || `exit status ${code}`;
        finish(new Error(`daemon failed to start: ${msg}`));
      });
      const poll = setInterval(() => fs.existsSync(this.o.socket) && finish(), 100);
      const deadline = setTimeout(() => finish(new Error("daemon did not create its socket within 20s")), 20_000);
    });
  }

  private async waitForSocket(ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!fs.existsSync(this.o.socket)) {
      if (Date.now() > end) {
        throw new Error(`daemon did not create ${this.o.socket} within ${ms / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")}: ${stderr.trim() || err.message}`));
      } else {
        resolve();
      }
    });
  });
}
