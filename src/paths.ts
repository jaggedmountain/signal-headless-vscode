// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Locating the daemon socket and the signal-headless binary. Mirrors the
// daemon's own defaults (internal/paths).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function socketPath(setting: string, env: NodeJS.ProcessEnv = process.env): string {
  if (setting.trim() !== "") {
    return expandHome(setting.trim());
  }
  if (env.SIGNAL_HEADLESS_SOCKET) {
    return env.SIGNAL_HEADLESS_SOCKET;
  }
  const rt = env.XDG_RUNTIME_DIR || (process.platform === "linux" && process.getuid ? `/run/user/${process.getuid()}` : "");
  if (rt !== "" && fs.existsSync(rt)) {
    return path.join(rt, "signal-headless.sock");
  }
  return path.join(dataDir(env), "signal-headless.sock");
}

// dataDir mirrors the daemon's default (internal/paths): XDG-style on Linux,
// Application Support on macOS, %LOCALAPPDATA% on Windows.
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.SIGNAL_HEADLESS_DATA) {
    return env.SIGNAL_HEADLESS_DATA;
  }
  switch (platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "signal-headless");
    case "win32":
      return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "signal-headless");
  }
  return path.join(os.homedir(), ".local", "share", "signal-headless");
}

export function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
