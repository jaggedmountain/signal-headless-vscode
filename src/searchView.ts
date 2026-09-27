// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Search Results: message search shown as a tree under Conversations,
// grouped by conversation, with the matches highlighted. Selecting a result
// opens the conversation scrolled to that message.
import * as vscode from "vscode";
import { Session } from "./session";
import { snippet } from "./snippet";
import { Message } from "./types";

const LIMIT = 500;

type Node = { kind: "thread"; thread: string; hits: Message[] } | { kind: "hit"; m: Message } | { kind: "info"; text: string };

export class SearchView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private query = "";
  private scope: string | undefined; // thread id, or all conversations
  private groups: Node[] = [];
  private busy = false;
  private seq = 0;

  constructor(private readonly session: Session) {
    this.view = vscode.window.createTreeView("signalHeadless.search", { treeDataProvider: this, showCollapseAll: true });
    void vscode.commands.executeCommand("setContext", "signalHeadless.hasSearch", false);
  }

  get results(): Node[] {
    return this.groups;
  }

  // run searches and shows the results; scope limits it to one conversation.
  async run(query: string, scope?: string): Promise<number> {
    this.query = query.trim();
    this.scope = scope;
    const my = ++this.seq;
    this.busy = true;
    this.groups = [];
    void vscode.commands.executeCommand("setContext", "signalHeadless.hasSearch", true);
    this.changed.fire(undefined);
    this.view.message = "Searching…";
    let hits: Message[] = [];
    try {
      hits = this.query.length === 0 ? [] : await this.session.search(this.query, scope, LIMIT);
    } catch (err) {
      if (my === this.seq) {
        this.view.message = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
        this.busy = false;
      }
      return 0;
    }
    if (my !== this.seq) {
      return hits.length;
    }
    const byThread = new Map<string, Message[]>();
    for (const m of hits) {
      const list = byThread.get(m.thread) ?? [];
      list.push(m);
      byThread.set(m.thread, list);
    }
    // Conversations ordered by their newest hit (results come newest first).
    this.groups = [...byThread].map(([thread, list]) => ({ kind: "thread", thread, hits: list }) as Node);
    const where = scope ? ` in ${this.session.thread(scope)?.title ?? "this conversation"}` : "";
    const more = hits.length >= LIMIT ? ` (showing the newest ${LIMIT})` : "";
    this.view.message = hits.length === 0
      ? `No messages match “${this.query}”${where}.`
      : `${hits.length} message${hits.length === 1 ? "" : "s"} match “${this.query}”${where}${more}.`;
    this.view.description = this.query;
    this.busy = false;
    this.changed.fire(undefined);
    if (hits.length > 0) {
      void vscode.commands.executeCommand("signalHeadless.search.focus");
    }
    return hits.length;
  }

  clear(): void {
    this.seq++;
    this.query = "";
    this.groups = [];
    this.view.message = undefined;
    this.view.description = undefined;
    void vscode.commands.executeCommand("setContext", "signalHeadless.hasSearch", false);
    this.changed.fire(undefined);
  }

  get lastQuery(): { query: string; scope?: string } {
    return { query: this.query, scope: this.scope };
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      return this.busy ? [] : this.groups;
    }
    return n.kind === "thread" ? n.hits.map((m) => ({ kind: "hit", m }) as Node) : [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "info") {
      return new vscode.TreeItem(n.text);
    }
    if (n.kind === "thread") {
      const t = this.session.thread(n.thread);
      const item = new vscode.TreeItem(t?.title ?? n.thread.slice(0, 8), vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${n.hits.length}`;
      item.iconPath = new vscode.ThemeIcon(t?.noteToSelf ? "note" : t?.kind === "group" ? "organization" : "account");
      item.id = `t:${n.thread}`;
      item.contextValue = "searchThread";
      return item;
    }
    const m = n.m;
    const { text, highlights } = snippet(m.body, this.query);
    const item = new vscode.TreeItem({ label: text, highlights });
    const who = m.outgoing ? "Me" : m.authorName || this.session.name(m.author);
    item.description = `${who} · ${when(m.ts)}`;
    item.tooltip = new vscode.MarkdownString().appendText(`${who} — ${new Date(m.ts).toLocaleString()}\n\n${m.body}`);
    item.iconPath = new vscode.ThemeIcon(m.outgoing ? "arrow-right" : "comment");
    item.id = `m:${m.id}`;
    item.command = { command: "signalHeadless.open", title: "Show", arguments: [m.thread, { reveal: m.ts }] };
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}
