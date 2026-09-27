// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Conversations tree in the Signal activity-bar view.
import * as vscode from "vscode";
import { Mutes } from "./mutes";
import { Session } from "./session";
import { Thread } from "./types";

// ACTIVE_DAYS: the "Active" filter shows conversations with a message in
// this many days (plus any with unread messages).
export const ACTIVE_DAYS = 30;

export class ThreadsView implements vscode.TreeDataProvider<Thread>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Thread | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private showArchived = false;
  private activeOnly: boolean;
  readonly view: vscode.TreeView<Thread>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly session: Session, private readonly mutes: Mutes, private readonly state: vscode.Memento) {
    this.activeOnly = state.get("activeOnly", true);
    void vscode.commands.executeCommand("setContext", "signalHeadless.activeOnly", this.activeOnly);
    this.view = vscode.window.createTreeView("signalHeadless.threads", { treeDataProvider: this });
    const refresh = () => this.refresh();
    session.on("threads", refresh);
    session.on("contacts", refresh);
    session.on("state", refresh);
    this.disposables.push(this.view, this.changed, {
      dispose: () => {
        session.off("threads", refresh);
        session.off("contacts", refresh);
        session.off("state", refresh);
      },
    });
    void vscode.commands.executeCommand("setContext", "signalHeadless.showArchived", false);
  }

  setShowArchived(v: boolean): void {
    this.showArchived = v;
    void vscode.commands.executeCommand("setContext", "signalHeadless.showArchived", v);
    this.refresh();
  }

  setActiveOnly(v: boolean): void {
    this.activeOnly = v;
    void this.state.update("activeOnly", v);
    void vscode.commands.executeCommand("setContext", "signalHeadless.activeOnly", v);
    this.refresh();
  }

  get isActiveOnly(): boolean {
    return this.activeOnly;
  }

  refresh(): void {
    this.changed.fire(undefined);
    const n = this.session.totalUnread;
    this.view.badge = n > 0 ? { value: n, tooltip: `${n} unread message${n === 1 ? "" : "s"}` } : undefined;
    const st = this.session.status;
    this.view.description = this.session.state === "unlinked" ? "not linked" : this.session.state !== "connected" ? "disconnected" : st && st.connection !== "connected" ? st.connection : this.activeOnly ? `last ${ACTIVE_DAYS} days` : "all";
  }

  getChildren(element?: Thread): Thread[] {
    if (element || this.session.state !== "connected") {
      return [];
    }
    const since = Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;
    return this.session.threads.filter((t) =>
      (this.showArchived || !t.archived || t.unread > 0) && (!this.activeOnly || t.unread > 0 || t.lastTs >= since));
  }

  getTreeItem(t: Thread): vscode.TreeItem {
    const muted = this.mutes.has(t.id);
    const item = new vscode.TreeItem(t.unread > 0 ? { label: t.title, highlights: [[0, t.title.length]] } : t.title);
    item.id = t.id;
    const prefix = t.lastAuthor && t.kind === "group" && t.lastAuthor !== this.session.me ? `${this.session.name(t.lastAuthor)}: ` : "";
    item.description = `${t.unread > 0 ? `${t.unread} · ` : ""}${prefix}${t.lastPreview ?? ""}`;
    const icon = muted ? "bell-slash" : t.noteToSelf ? "note" : t.kind === "group" ? "organization" : "account";
    item.iconPath = new vscode.ThemeIcon(t.unread > 0 ? "circle-filled" : icon, t.unread > 0 ? new vscode.ThemeColor("notificationsInfoIcon.foreground") : undefined);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(t.title)}**`);
    if (t.lastTs) {
      md.appendMarkdown(`  \n${new Date(t.lastTs).toLocaleString()}`);
    }
    if (t.lastPreview) {
      md.appendMarkdown(`  \n${escapeMd(prefix + t.lastPreview)}`);
    }
    const flags = [t.unread > 0 ? `${t.unread} unread` : "", muted ? "muted" : "", t.archived ? "archived" : "", t.expireTimer ? "disappearing messages" : ""].filter(Boolean);
    if (flags.length) {
      md.appendMarkdown(`  \n_${flags.join(" · ")}_`);
    }
    item.tooltip = md;
    item.contextValue = ["thread", t.unread > 0 ? "unread" : "", muted ? "muted" : "", t.archived ? "archived" : ""].filter(Boolean).join(" ");
    item.command = { command: "signalHeadless.open", title: "Open", arguments: [t.id] };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
