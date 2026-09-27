// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// LinkPanel links this computer to a Signal account: it runs
// `signal-headless --link --json`, shows the QR code for the phone to scan,
// and starts the daemon once linked.
import { ChildProcess, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import qrcode from "qrcode-generator";
import { cleanEnv } from "./env";
import { Session } from "./session";
import { historyText } from "./types";

interface LinkEvent {
  event: "url" | "linked" | "error";
  url?: string;
  number?: string;
  deviceId?: number;
  name?: string;
  code?: string;
  message?: string;
  fake?: boolean;
}

export type LinkPhase = "idle" | "waiting" | "linked" | "connected" | "error";

export class LinkPanel {
  private static current?: LinkPanel;
  private child?: ChildProcess;
  private _phase: LinkPhase = "idle";
  private readonly disposables: vscode.Disposable[] = [];
  // Fire on every phase / history-transfer state change (tests).
  readonly onPhase = new vscode.EventEmitter<LinkPhase>();
  readonly onHistory = new vscode.EventEmitter<string>();
  private historyState = "";

  static show(session: Session, executable: () => Promise<string | undefined>, socket: () => string): LinkPanel {
    if (LinkPanel.current) {
      LinkPanel.current.panel.reveal();
      return LinkPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("signalHeadless.link", "Link Signal", vscode.ViewColumn.Active, { enableScripts: true });
    LinkPanel.current = new LinkPanel(panel, session, executable, socket);
    return LinkPanel.current;
  }

  static get active(): LinkPanel | undefined {
    return LinkPanel.current;
  }

  get phase(): LinkPhase {
    return this._phase;
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly session: Session,
    private readonly executable: () => Promise<string | undefined>,
    private readonly socket: () => string,
  ) {
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: { type: string; name?: string }) => {
        if (m.type === "start") {
          void this.start(m.name?.trim() || defaultName());
        } else if (m.type === "cancel") {
          this.stop();
          this.setPhase("idle");
        } else if (m.type === "close") {
          panel.dispose();
        } else if (m.type === "openView") {
          void vscode.commands.executeCommand("workbench.view.extension.signalHeadless");
          panel.dispose();
        }
      }),
    );
    const onState = () => {
      if (this._phase === "linked" && session.state === "connected") {
        this.setPhase("connected");
        this.post({ type: "connected", number: session.status?.account.number ?? "" });
      }
      if (this._phase === "connected") {
        const h = session.status?.history;
        this.post({ type: "history", text: historyText(h), busy: !!h && ["waiting", "downloading", "importing"].includes(h.state) });
        if (h && h.state !== this.historyState) {
          this.historyState = h.state;
          this.onHistory.fire(h.state);
        }
      }
    };
    session.on("state", onState);
    session.on("status", onState);
    this.disposables.push({ dispose: () => { session.off("state", onState); session.off("status", onState); } });
  }

  async start(name: string): Promise<void> {
    this.post({ type: "waiting" });
    const exe = await this.executable();
    if (!exe) {
      this.fail("signal-headless isn't available: install it (see the README) or let the extension download it.");
      return;
    }
    this.stop();
    this.setPhase("waiting");
    this.post({ type: "waiting" });
    const child = spawn(exe, ["--link", "--json", "--name", name, "--socket", this.socket()], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(process.env) });
    this.child = child;
    let buf = "";
    let stderr = "";
    let finished = false;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-4096)));
    child.stdout!.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") {
          continue;
        }
        let e: LinkEvent;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.event === "url" && e.url) {
          this.post({ type: "qr", svg: qrSvg(e.url), fake: !!e.fake });
        } else if (e.event === "linked") {
          finished = true;
          this.setPhase("linked");
          this.post({ type: "linked", number: e.number ?? "", deviceId: e.deviceId ?? 0, name: e.name ?? name });
          this.session.linked();
        } else if (e.event === "error") {
          finished = true;
          this.fail(e.message ?? "linking failed");
        }
      }
    });
    child.on("error", (err) => this.fail(err.message));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!finished && signal === null) {
        const last = stderr.trim().split("\n").pop() ?? "";
        this.fail(last || `signal-headless --link exited with status ${code}`);
      }
    });
  }

  private stop(): void {
    const c = this.child;
    this.child = undefined;
    if (c && c.exitCode === null) {
      c.kill("SIGTERM");
    }
  }

  private fail(message: string): void {
    this.stop();
    this.setPhase("error");
    this.post({ type: "error", message });
  }

  private setPhase(p: LinkPhase): void {
    this._phase = p;
    this.onPhase.fire(p);
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private dispose(): void {
    this.stop();
    LinkPanel.current = undefined;
    this.onPhase.dispose();
    this.onHistory.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 24px 32px; max-width: 640px; line-height: 1.5; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 12px; }
  .muted { color: var(--vscode-descriptionForeground); }
  label { display: block; margin: 16px 0 4px; }
  input { width: 100%; max-width: 360px; padding: 5px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
  button { margin-top: 16px; margin-right: 8px; padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  #qr { margin: 16px 0; }
  #qr svg { width: 260px; height: 260px; background: #fff; padding: 12px; border-radius: 8px; }
  ol { padding-left: 20px; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); font-weight: 600; }
  [hidden] { display: none !important; }
</style></head>
<body>
<h1>Link this computer to Signal</h1>
<section id="intro">
  <p>This computer becomes a linked device of a Signal account, like Signal Desktop.
  The phone stays the primary device. After scanning, the phone can offer to
  <b>transfer message history</b>; if chosen, it arrives here a minute or two later.</p>
  <label for="name">Device name (shown on the phone)</label>
  <input id="name" value="${escapeHtml(defaultName())}">
  <br><button id="start">Show QR code</button>
</section>
<section id="scan" hidden>
  <ol>
    <li>On the phone, open Signal → <b>Settings</b> → <b>Linked devices</b>.</li>
    <li>Tap <b>Link new device</b> and scan this code.</li>
  </ol>
  <div id="qr"><span class="muted">Contacting Signal…</span></div>
  <p class="muted" id="qrnote">The code works for a few minutes. Keep this panel open until the phone confirms.</p>
  <button class="secondary" id="cancel">Cancel</button>
</section>
<section id="done" hidden>
  <p class="ok" id="doneText"></p>
  <p id="doneSub" class="muted">Starting the daemon…</p>
  <p id="history" hidden><span id="spin" class="muted">⟳ </span><span id="historyText"></span></p>
  <button id="openView" hidden>Open conversations</button>
</section>
<section id="failed" hidden>
  <p class="error" id="errText"></p>
  <button id="retry">Try again</button>
  <button class="secondary" id="close">Close</button>
</section>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const show = (id) => { for (const s of ["intro", "scan", "done", "failed"]) $(s).hidden = s !== id; };
  const start = () => vscode.postMessage({ type: "start", name: $("name").value });
  $("start").onclick = start;
  $("name").onkeydown = (e) => { if (e.key === "Enter") start(); };
  $("retry").onclick = start;
  $("cancel").onclick = () => { vscode.postMessage({ type: "cancel" }); show("intro"); };
  $("close").onclick = () => vscode.postMessage({ type: "close" });
  $("openView").onclick = () => vscode.postMessage({ type: "openView" });
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "waiting") { $("qr").innerHTML = '<span class="muted">Contacting Signal…</span>'; show("scan"); }
    else if (m.type === "qr") { $("qr").innerHTML = m.svg; $("qrnote").textContent = m.fake ? "(fake mode: this code links nothing)" : "The code works for a few minutes. Keep this panel open until the phone confirms."; show("scan"); }
    else if (m.type === "linked") { $("doneText").textContent = "Linked " + m.number + " as device " + m.deviceId + " (" + m.name + ")."; show("done"); }
    else if (m.type === "connected") { $("doneSub").textContent = "Connected. New messages will arrive here and in the Signal view."; $("openView").hidden = false; }
    else if (m.type === "history") { $("history").hidden = !m.text; $("historyText").textContent = m.text; $("spin").hidden = !m.busy; }
    else if (m.type === "error") { $("errText").textContent = m.message; show("failed"); }
  });
</script>
</body></html>`;
  }
}

function defaultName(): string {
  return `signal-headless@${os.hostname()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// qrSvg renders the provisioning URL as an SVG QR code (generated here, so
// the webview only ever receives our own markup).
export function qrSvg(url: string): string {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
