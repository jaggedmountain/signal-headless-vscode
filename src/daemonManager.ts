// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Binaries decides which signal-headless this extension runs: the
// configured one, else an install on the host that is new enough, else the
// release this extension was built for, downloaded (with consent) from
// GitHub into the extension's storage.
import * as path from "node:path";
import * as vscode from "vscode";
import { Candidate, Probe, candidates, choose, download, prune, releaseAsset } from "./daemonBinary";

export const INSTALL_DOCS = "https://github.com/jaggedmountain/signal-headless#quick-start";

export class Binaries {
  private cached?: Candidate & Probe;
  private declined = false;
  private inflight?: Promise<string | undefined>;
  private note = "";

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: (line: string) => void) {}

  // pinned: the daemon release this extension was built against, from
  // package.json ("signalHeadless": { "daemonVersion", "minProtocol" }).
  get pinned(): { version: string; minProtocol: number } {
    const p = (this.context.extension.packageJSON as { signalHeadless?: { daemonVersion?: string; minProtocol?: number } }).signalHeadless ?? {};
    return { version: p.daemonVersion ?? "v0.1.0", minProtocol: p.minProtocol ?? 1 };
  }

  private get managedRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, "daemon");
  }

  private get managedDir(): string {
    return path.join(this.managedRoot, this.pinned.version);
  }

  // describe says what is in use (the Diagnostics view, the log).
  describe(): string {
    if (this.cached) {
      return `${this.cached.path} (${this.cached.source}, ${this.cached.version}, protocol ${this.cached.protocol})`;
    }
    return this.note || "not chosen yet";
  }

  // reset forgets the choice and a declined download (settings changed, or
  // an explicit reconnect).
  reset(): void {
    this.cached = undefined;
    this.declined = false;
  }

  // resolve returns a usable binary, asking to download one when there is
  // none. interactive: the user asked for something that needs it (linking,
  // the terminal shell), so ask again even after a "not now".
  resolve(interactive = false): Promise<string | undefined> {
    this.inflight ??= this.find(interactive).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async find(interactive: boolean): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration("signalHeadless");
    const { minProtocol, version } = this.pinned;
    const list = candidates(cfg.get("executablePath", ""), this.managedDir);
    const { chosen, tooOld } = await choose(list, minProtocol);
    for (const o of tooOld) {
      this.log(`skipping ${o.path} (${o.source}): version ${o.version}, protocol ${o.protocol} < ${minProtocol}`);
    }
    if (chosen) {
      this.cached = chosen;
      this.log(`daemon binary: ${this.describe()}`);
      return chosen.path;
    }
    const why = tooOld.length ? `The installed signal-headless (${tooOld[0].version}) is too old for this extension.` : "signal-headless isn't installed.";
    this.note = why;
    if (!releaseAsset()) {
      this.note = `${why} There's no release for ${process.platform}-${process.arch} yet.`;
      if (interactive) {
        void vscode.window.showErrorMessage(`Signal: ${this.note}`, "How to Install").then((c) => c && void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS)));
      }
      return undefined;
    }
    const mode = cfg.get<string>("downloadDaemon", "ask");
    if (mode === "never" || (this.declined && !interactive)) {
      return undefined;
    }
    if (mode === "ask") {
      const choice = await vscode.window.showInformationMessage(
        `Signal: ${why} Download signal-headless ${version} (about 20 MB) from its GitHub releases?`,
        "Download", "Choose File…", "How to Install");
      if (choice === "Choose File…") {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Use this signal-headless" });
        if (picked?.[0]) {
          await cfg.update("executablePath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
          this.reset();
          return this.find(interactive);
        }
        this.declined = true;
        return undefined;
      }
      if (choice === "How to Install") {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
      }
      if (choice !== "Download") {
        this.declined = true;
        return undefined;
      }
    }
    return this.fetch();
  }

  private async fetch(): Promise<string | undefined> {
    const { version, minProtocol } = this.pinned;
    const baseUrl = vscode.workspace.getConfiguration("signalHeadless").get("releasesUrl", "https://github.com/jaggedmountain/signal-headless/releases");
    try {
      const exe = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signal: downloading signal-headless ${version}`, cancellable: false },
        (progress) => {
          let last = 0;
          return download({
            baseUrl, version, dir: this.managedDir,
            onProgress: (got, total) => {
              if (total > 0) {
                const pct = Math.floor((got / total) * 100);
                if (pct > last) {
                  progress.report({ increment: pct - last, message: `${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` });
                  last = pct;
                }
              }
            },
          });
        });
      prune(this.managedRoot, version);
      const { chosen } = await choose([{ path: exe, source: "managed" }], minProtocol);
      if (!chosen) {
        throw new Error(`the downloaded binary doesn't run here, or is older than protocol ${minProtocol}`);
      }
      this.cached = chosen;
      this.log(`downloaded ${this.describe()}`);
      return exe;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.note = `download failed: ${msg}`;
      this.log(`daemon download: ${msg}`);
      this.declined = true;
      void vscode.window.showErrorMessage(`Signal: couldn't download signal-headless ${version}: ${msg}`, "How to Install")
        .then((c) => c && void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS)));
      return undefined;
    }
  }
}
