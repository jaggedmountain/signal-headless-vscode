// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unread count and connection state in the status bar.
import * as vscode from "vscode";
import { Session } from "./session";
import { historyText } from "./types";

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("signalHeadless.status", vscode.StatusBarAlignment.Right, 100);
  private readonly off: () => void;

  constructor(private readonly session: Session) {
    this.item.name = "Signal";
    const update = () => this.update();
    session.on("threads", update);
    session.on("state", update);
    session.on("status", update);
    this.off = () => {
      session.off("threads", update);
      session.off("state", update);
      session.off("status", update);
    };
    this.update();
    this.item.show();
  }

  update(): void {
    const s = this.session;
    const n = s.totalUnread;
    const st = s.status;
    this.item.backgroundColor = undefined;
    if (s.state === "unlinked") {
      this.item.text = "$(link) Link Signal";
      this.item.tooltip = "Signal: this computer isn't linked to a Signal account.\nClick to link it (scan a QR code with the phone).";
      this.item.command = "signalHeadless.link";
      return;
    }
    if (s.state !== "connected") {
      this.item.text = s.state === "connecting" ? "$(sync~spin) Signal" : "$(debug-disconnect) Signal";
      this.item.tooltip = `Signal: not connected to the daemon${s.lastError ? `\n${s.lastError}` : ""}\nClick to reconnect`;
      this.item.command = "signalHeadless.reconnect";
      return;
    }
    if (st && st.connection !== "connected") {
      this.item.text = `$(warning) Signal${n > 0 ? ` ${n}` : ""}`;
      this.item.tooltip = `Signal: ${st.connection}${st.error ? ` (${st.error})` : ""}`;
      if (st.connection === "logged-out") {
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      }
      this.item.command = "signalHeadless.openThread";
      return;
    }
    const h = st?.history;
    if (h && (h.state === "waiting" || h.state === "downloading" || h.state === "importing")) {
      this.item.text = `$(sync~spin) Signal${n > 0 ? ` ${n}` : ""}`;
      this.item.tooltip = historyText(h);
      this.item.command = "signalHeadless.openThread";
      return;
    }
    this.item.text = n > 0 ? `$(comment-unresolved) ${n}` : "$(comment)";
    const unread = s.threads.filter((t) => t.unread > 0 && !t.archived);
    const lines = unread.slice(0, 8).map((t) => `${t.title}: ${t.unread}`);
    if (unread.length > 8) {
      lines.push(`… and ${unread.length - 8} more`);
    }
    this.item.tooltip = `Signal — ${st?.account.number ?? ""}\n${n > 0 ? lines.join("\n") : "No unread messages"}`;
    this.item.command = n > 0 ? "signalHeadless.nextUnread" : "signalHeadless.openThread";
  }

  dispose(): void {
    this.off();
    this.item.dispose();
  }
}
