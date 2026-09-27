// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Diagnostics: account, daemon and storage facts under Conversations, with
// maintenance actions (purge old local history, retry failed downloads).
import * as vscode from "vscode";
import { Session, errText } from "./session";
import { HistoryStatus, historyText } from "./types";

export interface StatsResult {
  threads: number;
  messages: number;
  attachments: number;
  attachmentsPending: number;
  attachmentsFailed: number;
  reactions: number;
  oldestTs?: number;
  newestTs?: number;
  dataDir: string;
  dbBytes: number;
  attachmentFiles: number;
  attachmentBytes: number;
}

export interface PurgeResult {
  messages: number;
  attachments: number;
  threads?: string[];
  bytes: number;
  dbBytesAfter: number;
}

interface Row {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  context?: string;
  command?: vscode.Command;
  children?: Row[];
}

export class DiagnosticsView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Row>;
  private stats?: StatsResult;
  private error = "";
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly session: Session, private readonly binary: () => string) {
    this.view = vscode.window.createTreeView("signalHeadless.diagnostics", { treeDataProvider: this });
    const soon = () => this.scheduleRefresh(500);
    session.on("state", soon);
    session.on("status", soon);
    session.on("history", soon);
    this.disposables.push(this.view, this.changed, this.view.onDidChangeVisibility(() => this.scheduleRefresh(0)), {
      dispose: () => {
        session.off("state", soon);
        session.off("status", soon);
        session.off("history", soon);
        clearTimeout(this.timer);
      },
    });
  }

  get current(): StatsResult | undefined {
    return this.stats;
  }

  private scheduleRefresh(ms: number): void {
    clearTimeout(this.timer);
    if (this.view.visible) {
      this.timer = setTimeout(() => void this.refresh(), ms);
    }
  }

  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    if (this.session.state === "connected") {
      try {
        this.stats = await this.session.call<StatsResult>("stats", undefined, 30_000);
        this.error = "";
      } catch (err) {
        this.error = errText(err);
      }
    }
    this.changed.fire(undefined);
    // Keep counts moving while downloads or an import are in progress.
    this.scheduleRefresh(this.busy() ? 5_000 : 60_000);
  }

  private busy(): boolean {
    const h = this.session.status?.history?.state;
    return (this.stats?.attachmentsPending ?? 0) > 0 || h === "waiting" || h === "downloading" || h === "importing";
  }

  getChildren(r?: Row): Row[] {
    return r ? r.children ?? [] : this.rows();
  }

  getTreeItem(r: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(r.label, r.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = r.id;
    item.description = r.description;
    item.tooltip = r.tooltip;
    item.iconPath = new vscode.ThemeIcon(r.icon);
    item.contextValue = r.context;
    item.command = r.command;
    return item;
  }

  private rows(): Row[] {
    const s = this.session;
    const st = s.status;
    const rows: Row[] = [];
    if (s.state !== "connected") {
      rows.push({ id: "conn", label: s.state === "unlinked" ? "Not linked" : "Daemon not connected", description: s.lastError, icon: "debug-disconnect", tooltip: s.lastError });
      return rows;
    }
    if (st) {
      rows.push({ id: "account", label: st.account.number, description: `device ${st.account.deviceId}`, icon: "account", tooltip: `ACI ${st.account.aci}` });
      rows.push({
        id: "daemon", label: `Daemon ${st.version}`, description: `${st.connection}${st.error ? ` (${st.error})` : ""} · ${st.clients} client${st.clients === 1 ? "" : "s"}`,
        icon: st.connection === "connected" ? "pass" : "warning", tooltip: `Binary: ${this.binary()}`,
      });
      const h: HistoryStatus | undefined = st.history;
      if (h) {
        rows.push({ id: "history", label: "History transfer", description: h.state, tooltip: historyText(h), icon: h.state === "failed" ? "error" : "history" });
      }
      rows.push({ id: "previews", label: "Link previews", description: `account setting: ${st.linkPreviews === false ? "off" : "on"}`, icon: "link" });
    }
    const x = this.stats;
    if (this.error) {
      rows.push({ id: "err", label: "Stats unavailable", description: this.error, icon: "error", tooltip: "The daemon may be older than this extension; restart it to update." });
    }
    if (!x) {
      return rows;
    }
    const range = x.oldestTs ? `${day(x.oldestTs)} – ${day(x.newestTs ?? x.oldestTs)}` : "";
    rows.push({ id: "db", label: "Database", description: bytes(x.dbBytes), icon: "database", tooltip: x.dataDir });
    rows.push({ id: "messages", label: `${num(x.messages)} messages`, description: `${num(x.threads)} conversations${range ? ` · ${range}` : ""}`, icon: "comment-discussion" });
    rows.push({ id: "reactions", label: `${num(x.reactions)} reactions`, icon: "smiley" });
    const att: Row = { id: "attachments", label: `${num(x.attachmentFiles)} attachment files`, description: bytes(x.attachmentBytes), icon: "file-media", children: [] };
    if (x.attachmentsPending > 0) {
      att.children!.push({ id: "pending", label: `${num(x.attachmentsPending)} downloading`, icon: "sync~spin" });
    }
    if (x.attachmentsFailed > 0) {
      att.children!.push({
        id: "failed", label: `${num(x.attachmentsFailed)} not downloaded`, description: "retry", icon: "warning", context: "failedDownloads",
        tooltip: "Failed or skipped downloads (older transferred media, expired links). Click to try them again.",
        command: { command: "signalHeadless.retryFailedDownloads", title: "Retry" },
      });
    }
    rows.push(att);
    return rows;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ---- purge ---------------------------------------------------------------

const DAY = 86_400_000;

// purgeCommand asks for a cutoff, shows what would go, and deletes after
// confirmation. opts.before + opts.confirmed skip the questions (automation).
export async function purgeCommand(session: Session, thread?: string, opts?: { before?: number; confirmed?: boolean; allDevices?: boolean }): Promise<PurgeResult | undefined> {
  const where = thread ? ` in ${session.thread(thread)?.title ?? "this conversation"}` : "";
  let before = opts?.before;
  if (!before) {
    const now = Date.now();
    const picks: (vscode.QuickPickItem & { ms?: number })[] = [
      { label: "Older than 1 month", ms: now - 30 * DAY },
      { label: "Older than 3 months", ms: now - 91 * DAY },
      { label: "Older than 6 months", ms: now - 182 * DAY },
      { label: "Older than 1 year", ms: now - 365 * DAY },
      { label: "Older than 2 years", ms: now - 730 * DAY },
      { label: "Before a date…" },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
      title: `Delete old messages${where}`,
      placeHolder: "Next: this computer only, or all your devices",
    });
    if (!pick) {
      return undefined;
    }
    before = pick.ms;
    if (!before) {
      const input = await vscode.window.showInputBox({
        title: "Delete messages sent before",
        prompt: "Date (YYYY-MM-DD)",
        validateInput: (v) => (Number.isNaN(Date.parse(v)) ? "Use YYYY-MM-DD" : undefined),
      });
      if (!input) {
        return undefined;
      }
      before = new Date(`${input}T00:00:00`).getTime();
    }
  }
  let allDevices = opts?.allDevices ?? false;
  if (!opts?.confirmed) {
    const where2 = await vscode.window.showQuickPick([
      { label: "$(device-desktop) This computer only", description: "default", detail: "The phone and other linked devices keep their copies.", all: false },
      { label: "$(devices) All my devices", detail: "Also deletes them on the phone and other linked devices (Signal's “delete for me”). The people you talked with keep theirs.", all: true },
    ], { title: "Delete from where?" });
    if (!where2) {
      return undefined;
    }
    allDevices = where2.all;
  }
  const dry = await session.call<PurgeResult>("purge", { before, thread, dryRun: true }, 120_000);
  const when = new Date(before).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (dry.messages === 0) {
    if (!opts?.confirmed) {
      void vscode.window.showInformationMessage(`Signal: no messages before ${when}${where}.`);
    }
    return dry;
  }
  if (!opts?.confirmed) {
    const detail = `${num(dry.messages)} messages from ${dry.threads?.length ?? 0} conversation${dry.threads?.length === 1 ? "" : "s"}, ` +
      `${num(dry.attachments)} attachments (${bytes(dry.bytes)} of files).\n\n` +
      (allDevices
        ? "They are deleted here AND on the phone and every other linked device. The other people in these conversations keep their copies. This can't be undone."
        : "Only this computer's copy is deleted; the phone and other linked devices keep theirs. It can't be undone here.");
    const ok = await vscode.window.showWarningMessage(
      allDevices ? `Delete messages sent before ${when}${where} from ALL your devices?` : `Delete messages sent before ${when}${where}?`,
      { modal: true, detail }, allDevices ? "Delete Everywhere" : "Delete");
    if (ok !== "Delete" && ok !== "Delete Everywhere") {
      return undefined;
    }
  }
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Signal: deleting old messages…" }, () =>
    session.call<PurgeResult>("purge", { before, thread, allDevices }, 10 * 60_000));
  if (!opts?.confirmed) {
    void vscode.window.showInformationMessage(`Signal: deleted ${num(res.messages)} messages${allDevices ? " (here and on your other devices)" : ""} and ${bytes(res.bytes)} of attachments. Database: ${bytes(res.dbBytesAfter)}.`);
  }
  return res;
}

export function bytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function num(n: number): string {
  return n.toLocaleString();
}

function day(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
