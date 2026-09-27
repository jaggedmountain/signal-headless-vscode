// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs the extension test suite in a separate VS Code instance (use
// xvfb-run to keep it off the desktop) against a --fake daemon.
import { runTests } from "@vscode/test-electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFake } from "./unit/helpers";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shv-vscode-"));
  const fake = await startFake(fs.mkdtempSync(path.join(tmp, "daemon-")));
  fs.mkdirSync(path.join(tmp, "home"));
  const userData = path.join(tmp, "user");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "signalHeadless.socketPath": fake.socket,
    "signalHeadless.autoStartDaemon": false,
    // notify-send talks to the real desktop over D-Bus, even from xvfb.
    "signalHeadless.desktopNotifications": false,
    "signalHeadless.executablePath": "/nonexistent",
    "signalHeadless.downloadDaemon": "never",
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
  }, null, 2));
  // Keep the test window inside xvfb: with WAYLAND_DISPLAY set, Electron
  // would open it on the real desktop.
  delete process.env.WAYLAND_DISPLAY;
  const snapCode = "/snap/code/current/usr/share/code/code";
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_TEST_BINARY || (fs.existsSync(snapCode) ? snapCode : undefined),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "out", "test", "suite", "index.js"),
      // The extension must never find a real signal-headless (in ~/.local/bin
      // or on PATH): it would open the real account's store.
      extensionTestsEnv: {
        SHV_TEST_SOCKET: fake.socket, SHV_TEST_DIR: tmp, SHV_SCREENSHOTS: process.env.SHV_SCREENSHOTS ?? "",
        HOME: path.join(tmp, "home"),
        PATH: (process.env.PATH ?? "").split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, "signal-headless"))).join(path.delimiter),
      },
      launchArgs: ["--user-data-dir", userData, "--extensions-dir", path.join(tmp, "extensions"), "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--disable-gpu", "--ozone-platform=x11"],
    });
  } finally {
    await fake.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
