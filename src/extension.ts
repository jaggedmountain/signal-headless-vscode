// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Signal in VS Code, as a client of the local signal-headless daemon.
//
// The extension runs on the UI side (extensionKind "ui"), so in Remote-SSH
// windows it still talks to this machine's daemon.
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChatContext, ChatPanel, localPath } from "./chatPanel";
import { Coordinator } from "./coordinator";
import { Mutes } from "./mutes";
import { Notifier, quickReply } from "./notifier";
import { LinkPanel } from "./linkPanel";
import { Binaries, INSTALL_DOCS } from "./daemonManager";
import { socketPath } from "./paths";
import { Session, SessionOptions, cleanEnv, errText } from "./session";
import { StatusBar } from "./statusBar";
import { DiagnosticsView, purgeCommand } from "./diagnosticsView";
import { SearchView } from "./searchView";
import { ThreadsView } from "./threadsView";
import { Thread, displayName } from "./types";

export interface Api {
  session: Session;
  coordinator: Coordinator;
  chat: ChatContext;
  notifier: Notifier;
  panels: () => ChatPanel[];
  linkPanel: () => LinkPanel | undefined;
  threadsView: ThreadsView;
  searchView: SearchView;
  binaries: Binaries;
  diagnosticsView: DiagnosticsView;
}

export function activate(context: vscode.ExtensionContext): Api {
  const log = vscode.window.createOutputChannel("Signal", { log: true });
  context.subscriptions.push(log);
  const say = (line: string) => log.info(line);

  const binaries = new Binaries(context, say);
  const options = (): SessionOptions => {
    const cfg = vscode.workspace.getConfiguration("signalHeadless");
    return {
      socket: socketPath(cfg.get("socketPath", "")),
      executable: () => binaries.resolve(),
      autoStart: cfg.get("autoStartDaemon", true),
      log: say,
    };
  };
  const opts = options();
  const session = new Session(opts);
  context.subscriptions.push({ dispose: () => session.dispose() });

  // Windows talking to the same daemon coordinate over a socket next to it.
  const coordinator = new Coordinator(`${opts.socket}.vscode`);
  context.subscriptions.push({ dispose: () => coordinator.dispose() });
  coordinator.on("role", (r) => say(`notification routing: ${r}`));
  const windowFocused = () => vscode.window.state.focused;
  coordinator.setFocused(windowFocused());
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      coordinator.setFocused(s.focused);
      if (s.focused) {
        for (const p of ChatPanel.all()) {
          p.maybeMarkRead();
        }
      }
    }),
  );

  const mutes = new Mutes(path.join(context.globalStorageUri.fsPath, "muted.json"));
  const chat: ChatContext = {
    extensionUri: context.extensionUri,
    session,
    stagingDir: path.join(context.globalStorageUri.fsPath, "outgoing"),
    log: say,
    windowFocused,
  };
  const open = (thread: string, o?: Parameters<typeof ChatPanel.show>[2]) => ChatPanel.show(chat, thread, o);

  const threadsView = new ThreadsView(session, mutes, context.globalState);
  const searchView = new SearchView(session);
  const diagnosticsView = new DiagnosticsView(session, () => binaries.describe());
  context.subscriptions.push(searchView, diagnosticsView);
  const statusBar = new StatusBar(session);
  const notifier = new Notifier({
    session,
    coordinator,
    mutes,
    openThread: (t) => open(t),
    focusUri: (t) => vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/open?thread=${encodeURIComponent(t)}`),
    windowFocused,
    log: say,
  });
  context.subscriptions.push(threadsView, statusBar, notifier);

  const setConnected = () => {
    void vscode.commands.executeCommand("setContext", "signalHeadless.connected", session.state === "connected");
    void vscode.commands.executeCommand("setContext", "signalHeadless.unlinked", session.state === "unlinked");
  };
  session.on("state", setConnected);
  setConnected();
  // First time this host turns out to be unlinked, offer linking once.
  session.on("state", (st) => {
    if (st !== "unlinked" || context.globalState.get("linkOffered") || LinkPanel.active) {
      return;
    }
    void context.globalState.update("linkOffered", true);
    void vscode.window.showInformationMessage("Signal: this computer isn't linked to a Signal account yet.", "Link…", "Not now").then((c) => {
      if (c === "Link…") {
        void vscode.commands.executeCommand("signalHeadless.link");
      }
    });
  });
  // The daemon keeps running across upgrades: when it's older than this
  // extension needs, offer a restart (the new start picks a new-enough binary).
  let warnedOld = "";
  session.on("status", (st) => {
    const have = st.protocol ?? 0;
    if (have >= binaries.pinned.minProtocol || warnedOld === st.version) {
      return;
    }
    warnedOld = st.version;
    say(`daemon ${st.version} speaks protocol ${have}; this extension needs ${binaries.pinned.minProtocol}`);
    void vscode.window.showWarningMessage(
      `Signal: the running daemon (${st.version}) is older than this extension needs; some features won't work until it restarts.`,
      "Restart Daemon", "Update Instructions",
    ).then(async (c) => {
      if (c === "Update Instructions") {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
      } else if (c === "Restart Daemon") {
        try {
          await session.call("shutdown");
          binaries.reset();
        } catch {
          // Daemons before protocol 1 have no shutdown.
          const pick = await vscode.window.showWarningMessage("Signal: this daemon can't be restarted from here. Stop it with `pkill -x signal-headless`; it starts again on the new version.", "Copy Command");
          if (pick) {
            await vscode.env.clipboard.writeText("pkill -x signal-headless");
          }
        }
      }
    });
  });
  let warnedLoggedOut = false;
  session.on("status", (st) => {
    if (st.connection === "logged-out" && !warnedLoggedOut) {
      warnedLoggedOut = true;
      void vscode.window.showWarningMessage("Signal: this device is no longer linked to the account. Run `signal-headless --link` to link it again.");
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("signalHeadless.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        // The webview saves its thread id (and draft) in its state.
        const thread = (state as { thread?: string } | undefined)?.thread;
        if (thread) {
          ChatPanel.restore(chat, panel, thread);
        } else {
          panel.dispose();
        }
      },
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const thread = new URLSearchParams(uri.query).get("thread");
        if (uri.path === "/open" && thread) {
          open(thread);
        }
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("signalHeadless")) {
        binaries.reset();
        session.updateOptions(options());
        threadsView.refresh();
      }
    }),
  );

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        say(`${id}: ${errText(err)}`);
        void vscode.window.showErrorMessage(`Signal: ${errText(err)}`);
        return undefined;
      }
    }));
  const threadArg = (a: unknown): string | undefined => (typeof a === "string" ? a : (a as Thread | undefined)?.id);

  cmd("signalHeadless.open", (thread: string, o?: Parameters<typeof ChatPanel.show>[2]) => open(thread, o));
  cmd("signalHeadless.openThread", async () => {
    const t = await pickThread(session, "Open conversation");
    if (t) {
      open(t);
    }
  });
  cmd("signalHeadless.nextUnread", () => {
    const t = session.threads.find((x) => x.unread > 0 && !mutes.has(x.id)) ?? session.threads.find((x) => x.unread > 0);
    if (t) {
      open(t.id);
    } else {
      vscode.window.setStatusBarMessage("Signal: no unread messages", 2500);
    }
  });
  cmd("signalHeadless.newConversation", async () => {
    const t = await pickRecipient(session);
    if (t) {
      open(t);
    }
  });
  // search(query?, scope?): with a query (tests, other extensions) it goes
  // straight to the Search Results panel.
  cmd("signalHeadless.search", async (query?: unknown, scope?: string) =>
    typeof query === "string" ? searchView.run(query, scope) : search(session, open, searchView));
  cmd("signalHeadless.searchInConversation", async (a?: unknown) => {
    const t = threadArg(a) ?? ChatPanel.all().find((p) => p.panel.active)?.threadId;
    if (!t) {
      return search(session, open, searchView);
    }
    return search(session, open, searchView, t);
  });
  cmd("signalHeadless.searchAgain", () => {
    const { query, scope } = searchView.lastQuery;
    return query ? searchView.run(query, scope) : search(session, open, searchView);
  });
  cmd("signalHeadless.clearSearch", () => searchView.clear());
  cmd("signalHeadless.refreshDiagnostics", () => diagnosticsView.refresh());
  cmd("signalHeadless.purge", async (a?: unknown, opts?: { before?: number; confirmed?: boolean; allDevices?: boolean }) => {
    const res = await purgeCommand(session, threadArg(a), opts);
    void diagnosticsView.refresh();
    return res;
  });
  cmd("signalHeadless.retryFailedDownloads", async (opts?: { confirmed?: boolean }) => {
    const n = diagnosticsView.current?.attachmentsFailed ?? 0;
    if (!opts?.confirmed && n > 20) {
      const ok = await vscode.window.showWarningMessage(`Try downloading ${n.toLocaleString()} attachments again?`, {
        modal: true, detail: "Many may be older transferred media that Signal no longer stores; those fail again quickly.",
      }, "Retry");
      if (ok !== "Retry") {
        return undefined;
      }
    }
    const r = await session.call<{ count: number }>("retryFailedAttachments");
    void diagnosticsView.refresh();
    return r.count;
  });
  cmd("signalHeadless.sendFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    let targets = uris?.length ? uris : uri ? [uri] : [];
    if (targets.length === 0 && vscode.window.activeTextEditor) {
      targets = [vscode.window.activeTextEditor.document.uri];
    }
    if (targets.length === 0) {
      targets = (await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Send", defaultUri: vscode.Uri.file(os.homedir()) })) ?? [];
    }
    if (targets.length === 0) {
      return;
    }
    const names = targets.map((u) => path.posix.basename(u.path)).join(", ");
    const t = await pickThread(session, `Send ${names} to…`, true);
    if (!t) {
      return;
    }
    const paths = await Promise.all(targets.map((u) => localPath(u, chat.stagingDir)));
    open(t, { attach: paths });
  });
  cmd("signalHeadless.sendSelection", async () => {
    const ed = vscode.window.activeTextEditor;
    const text = ed?.document.getText(ed.selection) ?? "";
    if (text.trim() === "") {
      return;
    }
    const t = await pickThread(session, "Send selection to…", true);
    if (t) {
      open(t, { draft: text });
    }
  });
  cmd("signalHeadless.showAllThreads", () => threadsView.setActiveOnly(false));
  cmd("signalHeadless.showActiveThreads", () => threadsView.setActiveOnly(true));
  cmd("signalHeadless.showArchived", () => threadsView.setShowArchived(true));
  cmd("signalHeadless.hideArchived", () => threadsView.setShowArchived(false));
  cmd("signalHeadless.archive", async (a) => {
    const t = threadArg(a);
    if (t) {
      await session.archive(t, true);
    }
  });
  cmd("signalHeadless.unarchive", async (a) => {
    const t = threadArg(a);
    if (t) {
      await session.archive(t, false);
    }
  });
  cmd("signalHeadless.mute", (a) => {
    const t = threadArg(a);
    if (t) {
      mutes.set(t, true);
      threadsView.refresh();
    }
  });
  cmd("signalHeadless.unmute", (a) => {
    const t = threadArg(a);
    if (t) {
      mutes.set(t, false);
      threadsView.refresh();
    }
  });
  cmd("signalHeadless.markRead", async (a) => {
    const t = threadArg(a);
    if (t) {
      await session.markRead(t);
    }
  });
  cmd("signalHeadless.markAllRead", async () => {
    await Promise.all(session.threads.filter((t) => t.unread > 0).map((t) => session.markRead(t.id)));
  });
  cmd("signalHeadless.reply", async (a) => {
    const t = threadArg(a);
    if (t) {
      await quickReply(session, t, session.thread(t)?.title ?? "Signal");
    }
  });
  cmd("signalHeadless.reconnect", () => {
    binaries.reset();
    session.updateOptions(options());
    session.reconnect();
  });
  cmd("signalHeadless.showLog", () => log.show());
  cmd("signalHeadless.link", () => {
    if (session.state === "connected" && session.status?.connection !== "logged-out") {
      void vscode.window.showInformationMessage(`Signal: already linked as ${session.status?.account.number} (device ${session.status?.account.deviceId}).`);
      return;
    }
    if (session.state === "connected") {
      void vscode.window.showWarningMessage("Signal: the phone removed this device. Run `signal-headless --unlink --force` (with the daemon stopped) to clear the old link, then link again.");
      return;
    }
    LinkPanel.show(session, () => binaries.resolve(true), () => options().socket);
  });
  cmd("signalHeadless.openShell", async () => {
    const exe = await binaries.resolve(true);
    if (!exe) {
      return;
    }
    const term = vscode.window.createTerminal({
      name: "Signal",
      shellPath: exe,
      shellArgs: ["--shell", "--socket", options().socket],
      env: cleanEnv({}),
      iconPath: vscode.Uri.joinPath(context.extensionUri, "media", "signal.svg"),
      location: vscode.TerminalLocation.Editor,
    });
    term.show();
  });

  coordinator.start();
  session.start();
  say(`socket ${opts.socket}; daemon ${binaries.pinned.version} (protocol ≥ ${binaries.pinned.minProtocol}) expected; ${vscode.env.remoteName ? `remote window (${vscode.env.remoteName})` : "local window"}`);

  return { session, coordinator, chat, notifier, panels: () => ChatPanel.all(), linkPanel: () => LinkPanel.active, threadsView, searchView, diagnosticsView, binaries };
}

export function deactivate(): void {
  ChatPanel.disposeAll();
}

// ---- pickers -------------------------------------------------------------

interface ThreadItem extends vscode.QuickPickItem {
  thread?: string;
  recipient?: string;
}

async function pickThread(session: Session, title: string, includeContacts = false): Promise<string | undefined> {
  const threads = [...session.threads].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastTs - a.lastTs);
  const items: ThreadItem[] = threads.filter((t) => !t.archived || t.unread > 0).map((t) => threadItem(session, t));
  const archived = threads.filter((t) => t.archived && t.unread === 0);
  if (archived.length) {
    items.push({ label: "Archived", kind: vscode.QuickPickItemKind.Separator }, ...archived.map((t) => threadItem(session, t)));
  }
  if (includeContacts) {
    items.push(...contactItems(session));
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(add) New conversation…", recipient: "" });
  const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true, placeHolder: "Type a name" });
  if (!pick) {
    return undefined;
  }
  if (pick.thread) {
    return pick.thread;
  }
  if (pick.recipient) {
    return (await session.resolve(pick.recipient)).thread;
  }
  return pickRecipient(session);
}

function threadItem(session: Session, t: Thread): ThreadItem {
  const icon = t.noteToSelf ? "$(note)" : t.kind === "group" ? "$(organization)" : "$(account)";
  const author = t.lastAuthor && t.kind === "group" && t.lastAuthor !== session.me ? `${session.name(t.lastAuthor)}: ` : "";
  return {
    label: `${icon} ${t.title}`,
    description: t.unread > 0 ? `${t.unread} unread` : t.lastTs ? relTime(t.lastTs) : "",
    detail: t.lastPreview ? author + t.lastPreview : undefined,
    thread: t.id,
  };
}

function contactItems(session: Session): ThreadItem[] {
  const have = new Set(session.threads.map((t) => t.id));
  const contacts = session.contacts.filter((c) => !c.blocked && !have.has(c.id)).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const groups = session.groups.filter((g) => !have.has(g.id));
  const items: ThreadItem[] = [];
  if (contacts.length || groups.length) {
    items.push({ label: "Contacts and groups", kind: vscode.QuickPickItemKind.Separator });
  }
  for (const g of groups) {
    items.push({ label: `$(organization) ${g.title}`, description: `${g.members?.length ?? 0} members`, thread: g.id });
  }
  for (const c of contacts) {
    items.push({ label: `$(account) ${displayName(c)}`, description: c.number, thread: c.id });
  }
  return items;
}

async function pickRecipient(session: Session): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<ThreadItem>();
  qp.title = "New conversation";
  qp.placeholder = "Name, +number or group — Enter on typed text resolves it";
  qp.matchOnDescription = true;
  const base = (): ThreadItem[] => [...session.threads.map((t) => threadItem(session, t)), ...contactItems(session)];
  qp.items = base();
  qp.busy = true;
  session.refreshGroups().then(() => (qp.items = base()), () => undefined).finally(() => (qp.busy = false));
  qp.onDidChangeValue((v) => {
    const typed: ThreadItem[] = v.trim() ? [{ label: `$(send) ${v.trim()}`, description: "resolve this name or number", recipient: v.trim(), alwaysShow: true }] : [];
    qp.items = [...typed, ...base()];
  });
  const pick = await new Promise<ThreadItem | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!pick) {
    return undefined;
  }
  if (pick.thread) {
    return pick.thread;
  }
  if (pick.recipient) {
    return (await session.resolve(pick.recipient)).thread;
  }
  return undefined;
}

type SearchItem = ThreadItem & { ts?: number; panel?: boolean };

// search: a quick pick with live results; the first entry (Enter) sends
// the query to the Search Results panel instead.
async function search(session: Session, open: (t: string, o?: { reveal?: number }) => void, panel: SearchView, scope?: string): Promise<void> {
  const where = scope ? session.thread(scope)?.title ?? "this conversation" : "";
  const qp = vscode.window.createQuickPick<SearchItem>();
  qp.title = scope ? `Search in ${where}` : "Search messages";
  qp.placeholder = scope ? `Search text in ${where}` : "Search text in all conversations — Enter shows all results in the Search panel";
  qp.matchOnDetail = true;
  qp.matchOnDescription = true;
  const panelItem = (v: string): SearchItem => ({ label: `$(list-tree) Show all results for “${v}” in the Search panel`, panel: true, alwaysShow: true });
  let seq = 0;
  let timer: NodeJS.Timeout | undefined;
  qp.onDidChangeValue((v) => {
    clearTimeout(timer);
    const q = v.trim();
    if (q.length < 2) {
      qp.items = q ? [panelItem(q)] : [];
      return;
    }
    qp.items = [panelItem(q)];
    timer = setTimeout(async () => {
      const my = ++seq;
      qp.busy = true;
      try {
        const res = await session.search(q, scope, 50);
        if (my !== seq) {
          return;
        }
        qp.items = [panelItem(q), { label: "", kind: vscode.QuickPickItemKind.Separator }, ...res.map((m) => ({
          label: `${session.thread(m.thread)?.title ?? "?"}`,
          description: `${m.outgoing ? "Me" : m.authorName || session.name(m.author)} · ${new Date(m.ts).toLocaleString()}`,
          detail: m.body.replace(/\s+/g, " "),
          thread: m.thread,
          ts: m.ts,
          alwaysShow: true,
        }))];
      } catch (err) {
        qp.items = [panelItem(q), { label: `$(error) ${errText(err)}` }];
      } finally {
        if (my === seq) {
          qp.busy = false;
        }
      }
    }, 250);
  });
  const last = panel.lastQuery;
  if (last.query && last.scope === scope) {
    qp.value = last.query;
  }
  const pick = await new Promise<SearchItem | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  const value = qp.value.trim();
  qp.dispose();
  if (pick?.panel && value) {
    await panel.run(value, scope);
  } else if (pick?.thread && pick.ts) {
    open(pick.thread, { reveal: pick.ts });
  }
}

function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) {
    return "now";
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h`;
  }
  if (s < 7 * 86400) {
    return `${Math.floor(s / 86400)}d`;
  }
  return new Date(ts).toLocaleDateString();
}
