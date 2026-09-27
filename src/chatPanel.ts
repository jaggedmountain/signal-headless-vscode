// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// ChatPanel is one conversation in a webview editor tab.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { emojize } from "./emoji";
import { HostToView, Staged, ViewMessage, ViewThread, ViewToHost, connectionText } from "./protocol";
import { RpcError } from "./rpc";
import { Session, errText } from "./session";
import { Message, OutgoingPreview, Thread } from "./types";

const PAGE = 50;

export interface ChatContext {
  extensionUri: vscode.Uri;
  session: Session;
  stagingDir: string;
  log: (line: string) => void;
  windowFocused: () => boolean;
}

export class ChatPanel {
  private static panels = new Map<string, ChatPanel>();
  // Drafts and staged files outlive their panel, like the TUI's per-thread drafts.
  private static drafts = new Map<string, string>();
  private static stagedFiles = new Map<string, Staged[]>();

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queue: HostToView[] = [];
  private typingSent = 0;
  private known = new Map<number, Message>(); // messages shown in the webview
  private _thread: string; // the conversation shown (changes in single-panel mode)
  private static lastActive?: ChatPanel;
  private fetched = new Map<string, OutgoingPreview | null>(); // link previews for the draft

  static show(ctx: ChatContext, threadId: string, opts: { reveal?: number; draft?: string; attach?: string[]; preserveFocus?: boolean } = {}): ChatPanel {
    let p = ChatPanel.panels.get(threadId);
    if (!p && vscode.workspace.getConfiguration("signalHeadless").get<string>("chatPanels", "perConversation") === "single") {
      // One tab for all conversations: switch the most recently used one.
      p = ChatPanel.lastActive && ChatPanel.panels.get(ChatPanel.lastActive.threadId) === ChatPanel.lastActive
        ? ChatPanel.lastActive : [...ChatPanel.panels.values()][0];
      p?.retarget(threadId);
    }
    if (p) {
      p.panel.reveal(undefined, opts.preserveFocus);
    } else {
      // Open next to other Signal panels, if any, else in the active group.
      const sibling = [...ChatPanel.panels.values()][0];
      const column = sibling?.panel.viewColumn ?? vscode.ViewColumn.Active;
      const panel = vscode.window.createWebviewPanel("signalHeadless.chat", ChatPanel.title(ctx, threadId), { viewColumn: column, preserveFocus: opts.preserveFocus }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: ChatPanel.roots(ctx),
      });
      p = new ChatPanel(ctx, panel, threadId);
    }
    if (opts.draft !== undefined) {
      p.post({ type: "draft", text: opts.draft, append: true });
    }
    if (opts.attach?.length) {
      p.stage(opts.attach);
    }
    if (opts.reveal !== undefined) {
      void p.reveal(opts.reveal);
    } else if (!opts.preserveFocus) {
      p.post({ type: "focus" });
    }
    return p;
  }

  static restore(ctx: ChatContext, panel: vscode.WebviewPanel, threadId: string): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: ChatPanel.roots(ctx) };
    new ChatPanel(ctx, panel, threadId);
  }

  static get(threadId: string): ChatPanel | undefined {
    return ChatPanel.panels.get(threadId);
  }

  static all(): ChatPanel[] {
    return [...ChatPanel.panels.values()];
  }

  // isWatching reports whether the thread is on screen in a focused window.
  static isWatching(threadId: string, windowFocused: boolean): boolean {
    const p = ChatPanel.panels.get(threadId);
    return !!p && windowFocused && p.panel.visible;
  }

  static disposeAll(): void {
    for (const p of [...ChatPanel.panels.values()]) {
      p.panel.dispose();
    }
  }

  private static title(ctx: ChatContext, threadId: string): string {
    return ctx.session.thread(threadId)?.title || "Signal";
  }

  private static roots(ctx: ChatContext): vscode.Uri[] {
    // Attachments live in the daemon's data dir; outgoing ones anywhere the
    // user picked them. Both are under home or the temp dir in practice.
    return [vscode.Uri.joinPath(ctx.extensionUri, "dist"), vscode.Uri.joinPath(ctx.extensionUri, "media"), vscode.Uri.file(os.homedir()), vscode.Uri.file(os.tmpdir()), vscode.Uri.file(ctx.stagingDir)];
  }

  private constructor(private readonly ctx: ChatContext, readonly panel: vscode.WebviewPanel, threadId: string) {
    this._thread = threadId;
    ChatPanel.panels.set(threadId, this);
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "signal.svg");
    panel.webview.html = this.html();
    const s = ctx.session;
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ViewToHost) => void this.handle(m).catch((err) => this.fail(err))),
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          ChatPanel.lastActive = this;
        }
        this.maybeMarkRead();
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    const onMsg = (m: Message) => {
      if (m.thread === this.threadId) {
        this.post({ type: "upsert", messages: [this.decorate(m)] });
        if (!m.outgoing) {
          this.maybeMarkRead();
        }
      }
    };
    const onHistory = (h: { thread: string }) => {
      if (h.thread === this.threadId && this.ready) {
        void this.load();
      }
    };
    const onRemoved = (r: { id: number; thread: string }) => {
      if (r.thread === this.threadId) {
        this.known.delete(r.id);
        this.post({ type: "remove", id: r.id });
      }
    };
    const onThreads = () => {
      const t = s.thread(this.threadId);
      if (t) {
        this.post({ type: "thread", thread: viewThread(t) });
      }
      this.updateTitle();
      // The daemon raises the unread count after announcing the message.
      this.maybeMarkRead();
    };
    const onTyping = (e: { thread: string; sender: string; name?: string; typing: boolean }) => {
      if (e.thread === this.threadId && e.sender !== s.me) {
        this.post({ type: "typing", sender: e.sender, name: e.name || s.name(e.sender), typing: e.typing });
      }
    };
    const onState = () => {
      this.post({ type: "connection", text: connectionText(s.state, s.status?.connection, s.status?.error) });
      if (s.state === "connected" && this.ready) {
        void this.load(); // may have missed events while disconnected
      }
    };
    s.on("message", onMsg);
    s.on("messageUpdate", onMsg);
    s.on("messageRemoved", onRemoved);
    s.on("history", onHistory);
    s.on("threads", onThreads);
    s.on("typing", onTyping);
    s.on("state", onState);
    s.on("status", onState);
    this.disposables.push({
      dispose: () => {
        s.off("message", onMsg);
        s.off("messageUpdate", onMsg);
        s.off("messageRemoved", onRemoved);
        s.off("history", onHistory);
        s.off("threads", onThreads);
        s.off("typing", onTyping);
        s.off("state", onState);
        s.off("status", onState);
      },
    });
  }

  post(m: HostToView): void {
    if (!this.ready && m.type !== "init") {
      this.queue.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  get threadId(): string {
    return this._thread;
  }

  // retarget shows another conversation in this panel (single-panel mode).
  // The webview saves the outgoing conversation's draft and reply on init.
  retarget(threadId: string): void {
    if (threadId === this._thread) {
      return;
    }
    if (this.typingSent) {
      void this.ctx.session.sendTyping(this._thread, false).catch(() => undefined);
      this.typingSent = 0;
    }
    ChatPanel.panels.delete(this._thread);
    this._thread = threadId;
    ChatPanel.panels.set(threadId, this);
    this.known.clear();
    this.fetched.clear();
    this.panel.title = ChatPanel.title(this.ctx, threadId);
    if (this.ready) {
      void this.load();
    }
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get isReady(): boolean {
    return this.ready;
  }

  // probe asks the webview what it renders (tests).
  probe(): Promise<{ messages: number; text: string; errors: string[]; hiddenButShown: string[]; openPopups: string[]; composer: string; input: string }> {
    return new Promise((resolve) => {
      const sub = this.panel.webview.onDidReceiveMessage((m: ViewToHost) => {
        if (m.type === "probe") {
          sub.dispose();
          resolve(m);
        }
      });
      this.post({ type: "probe" });
    });
  }

  maybeMarkRead(): void {
    const t = this.ctx.session.thread(this.threadId);
    if (this.panel.visible && this.ctx.windowFocused() && t && t.unread > 0) {
      this.ctx.session.markRead(this.threadId).catch((err) => this.ctx.log(`markRead: ${errText(err)}`));
    }
  }

  private updateTitle(): void {
    const t = this.ctx.session.thread(this.threadId);
    if (!t) {
      return;
    }
    const title = t.unread > 0 && !this.panel.active ? `(${t.unread}) ${t.title}` : t.title;
    if (this.panel.title !== title) {
      this.panel.title = title;
    }
  }

  private dispose(): void {
    ChatPanel.panels.delete(this.threadId);
    if (ChatPanel.lastActive === this) {
      ChatPanel.lastActive = undefined;
    }
    if (this.typingSent) {
      void this.ctx.session.sendTyping(this.threadId, false).catch(() => undefined);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async load(): Promise<void> {
    const s = this.ctx.session;
    let t = s.thread(this.threadId);
    let msgs: Message[] = [];
    if (s.state === "connected") {
      try {
        t = (await s.call<Thread>("getThread", { thread: this.threadId })) ?? t;
        msgs = await s.getMessages(this.threadId, undefined, PAGE);
      } catch (err) {
        this.ctx.log(`load ${this.threadId}: ${errText(err)}`);
      }
    }
    const thread: ViewThread = t ? viewThread(t) : { id: this.threadId, title: "Signal", kind: "direct" };
    this.post({
      type: "init",
      me: s.me,
      thread,
      messages: msgs.map((m) => this.decorate(m)),
      hasMore: msgs.length >= PAGE,
      draft: ChatPanel.drafts.get(this.threadId) ?? "",
      enterSends: vscode.workspace.getConfiguration("signalHeadless").get("enterSends", true),
      connection: connectionText(s.state, s.status?.connection, s.status?.error),
    });
    this.post({ type: "staged", files: ChatPanel.stagedFiles.get(this.threadId) ?? [] });
    this.updateTitle();
    this.maybeMarkRead();
  }

  // reveal loads history back to ts and scrolls to that message.
  private async reveal(ts: number): Promise<void> {
    const s = this.ctx.session;
    const all: Message[] = [];
    let before: number | undefined;
    for (let i = 0; i < 40; i++) {
      const page = await s.getMessages(this.threadId, before, 100);
      all.push(...page);
      if (page.length < 100 || page.some((m) => m.ts <= ts)) {
        break;
      }
      before = Math.min(...page.map((m) => m.ts));
    }
    this.post({ type: "older", messages: all.map((m) => this.decorate(m)), hasMore: true });
    this.post({ type: "reveal", ts });
  }

  private decorate(m: Message): ViewMessage {
    const s = this.ctx.session;
    this.known.set(m.id, m);
    const v: ViewMessage = { ...m };
    if (m.quote) {
      v.quoteName = m.quote.author === s.me ? "You" : s.name(m.quote.author);
    }
    if (m.reactions?.length) {
      v.reactionNames = m.reactions.map((r) => (r.reactor === s.me ? "You" : s.name(r.reactor)));
    }
    if (m.attachments?.length) {
      v.attachmentUris = m.attachments.map((a) => (a.state === "done" && a.path ? this.panel.webview.asWebviewUri(vscode.Uri.file(a.path)).toString() : null));
    }
    return v;
  }

  private stage(paths: string[]): void {
    const list = ChatPanel.stagedFiles.get(this.threadId) ?? [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) {
          list.push({ name: path.basename(p), path: p, size: st.size });
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Signal: can't attach ${p}: ${errText(err)}`);
      }
    }
    ChatPanel.stagedFiles.set(this.threadId, list);
    this.post({ type: "staged", files: list });
  }

  private fail(err: unknown): void {
    const text = errText(err);
    this.ctx.log(`chat ${this.threadId}: ${text}`);
    void vscode.window.showErrorMessage(`Signal: ${text}`);
  }

  // handle processes a message from the webview (public for tests).
  async handle(m: ViewToHost): Promise<void> {
    const s = this.ctx.session;
    switch (m.type) {
      case "ready":
        // Events arriving while loading queue up behind "init".
        await this.load();
        for (const q of this.queue.splice(0)) {
          void this.panel.webview.postMessage(q);
        }
        this.ready = true;
        break;
      case "send": {
        const staged = ChatPanel.stagedFiles.get(this.threadId) ?? [];
        ChatPanel.stagedFiles.delete(this.threadId);
        this.post({ type: "staged", files: [] });
        this.typingSent = 0;
        const preview = m.preview ? this.fetched.get(m.preview) : undefined;
        try {
          await s.send({
            thread: this.threadId,
            body: emojize(m.body),
            attachments: staged.map((f) => f.path),
            quote: m.quote,
            previews: preview ? [preview] : undefined,
          });
        } catch (err) {
          // The daemon records a failed delivery as a message with status
          // "failed" (it can be resent); when it refused the request or
          // was unreachable, give the draft back.
          if (!(err instanceof RpcError) || err.code === -32602 || err.code === -32600) {
            ChatPanel.stagedFiles.set(this.threadId, staged);
            this.post({ type: "staged", files: staged });
            this.post({ type: "sendFailed", body: m.body, error: errText(err) });
          }
          throw err;
        } finally {
          this.cleanupStaging(staged);
        }
        break;
      }
      case "loadOlder": {
        const msgs = await s.getMessages(this.threadId, m.before, PAGE);
        this.post({ type: "older", messages: msgs.map((x) => this.decorate(x)), hasMore: msgs.length >= PAGE });
        break;
      }
      case "react":
        await s.react(this.threadId, { author: m.author, ts: m.ts }, emojize(m.emoji), m.remove);
        break;
      case "delete": {
        const ok = await vscode.window.showWarningMessage("Delete this message for everyone?", { modal: true }, "Delete");
        if (ok === "Delete") {
          await s.remoteDelete(this.threadId, m.ts);
        }
        break;
      }
      case "attach": {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: "Attach",
          defaultUri: vscode.Uri.file(os.homedir()),
        });
        if (uris) {
          this.stage(await Promise.all(uris.map((u) => localPath(u, this.ctx.stagingDir))));
        }
        break;
      }
      case "attachData": {
        const p = uniquePath(this.ctx.stagingDir, m.name);
        fs.mkdirSync(this.ctx.stagingDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(p, Buffer.from(m.data, "base64"), { mode: 0o600 });
        this.stage([p]);
        break;
      }
      case "detach": {
        const list = ChatPanel.stagedFiles.get(this.threadId) ?? [];
        const [removed] = list.splice(m.index, 1);
        if (removed) {
          this.cleanupStaging([removed]);
        }
        this.post({ type: "staged", files: list });
        break;
      }
      case "resend": {
        const old = this.known.get(m.id);
        if (old?.outgoing && old.status === "failed") {
          await s.send({
            thread: this.threadId,
            body: old.body,
            attachments: (old.attachments ?? []).map((a) => a.path).filter((p): p is string => !!p),
            quote: old.quote,
          });
        }
        break;
      }
      case "open": {
        const msg = this.known.get(m.id) ?? (await this.findMessage(m.id));
        const a = msg?.attachments?.[m.index];
        if (a?.path) {
          await openFile(a.path, a.contentType);
        }
        break;
      }
      case "retry":
        await s.retryAttachment(m.id);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage("Signal: message copied", 2000);
        break;
      case "openLink":
        if (/^(https?|mailto):/i.test(m.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url, true));
        }
        break;
      case "typing": {
        const now = Date.now();
        if (m.typing && now - this.typingSent < 8000) {
          break; // Signal clients expect a refresh every ~10s, not per key
        }
        this.typingSent = m.typing ? now : 0;
        await s.sendTyping(this.threadId, m.typing).catch(() => undefined);
        break;
      }
      case "draft": {
        const t = m.thread ?? this.threadId;
        if (m.text === "") {
          ChatPanel.drafts.delete(t);
        } else {
          ChatPanel.drafts.set(t, m.text);
        }
        break;
      }
      case "search":
        await vscode.commands.executeCommand("signalHeadless.searchInConversation", this.threadId);
        break;
      case "wantPreview":
        await this.draftPreview(m.url);
        break;
      case "markRead":
        this.maybeMarkRead();
        break;
      case "probe":
        break;
    }
  }

  // previewsEnabled applies the setting ("account" follows the Signal
  // account's "Generate link previews").
  private previewsEnabled(): boolean {
    const mode = vscode.workspace.getConfiguration("signalHeadless").get<string>("sendLinkPreviews", "account");
    return mode === "on" || (mode === "account" && this.ctx.session.status?.linkPreviews !== false);
  }

  // draftPreview fetches the preview for a link typed in the compose box
  // and shows it there.
  private async draftPreview(url: string): Promise<void> {
    if (!this.previewsEnabled() || !/^https:\/\//.test(url)) {
      this.post({ type: "draftPreview", url, preview: null });
      return;
    }
    let p = this.fetched.get(url);
    if (p === undefined) {
      p = await this.ctx.session.call<OutgoingPreview>("linkPreview", { url }).catch(() => null);
      this.fetched.set(url, p);
    }
    if (!p) {
      this.post({ type: "draftPreview", url, preview: null });
      return;
    }
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      // keep the URL
    }
    this.post({
      type: "draftPreview", url,
      preview: { title: p.title, description: p.description, host, imageUri: p.image ? this.panel.webview.asWebviewUri(vscode.Uri.file(p.image)).toString() : undefined },
    });
  }

  private async findMessage(id: number): Promise<Message | undefined> {
    // Page back through history until the message turns up (it is on screen,
    // so normally within the first pages).
    let before: number | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await this.ctx.session.getMessages(this.threadId, before, 200);
      const hit = page.find((x) => x.id === id);
      if (hit || page.length < 200) {
        return hit;
      }
      before = Math.min(...page.map((x) => x.ts));
    }
    return undefined;
  }

  private cleanupStaging(files: Staged[]): void {
    // Files copied into the staging dir are ours to delete once sent; the
    // daemon has already read them by the time send returns.
    for (const f of files) {
      if (path.dirname(f.path) === this.ctx.stagingDir) {
        fs.rm(f.path, { force: true }, () => undefined);
      }
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "chat.js"));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} data:`,
      `media-src ${w.cspSource}`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="banner"></div>
<div id="info"></div>
<div id="log" tabindex="0" aria-label="Messages"></div>
<div id="typing" aria-live="polite"></div>
<div id="composer">
  <div id="replying" hidden></div>
  <div id="draftPreview" hidden></div>
  <div id="staged"></div>
  <div class="row">
    <button id="attach" class="secondary" title="Attach files (a in the message list; paste or Shift+drop also work)">📎</button>
    <textarea id="input" rows="1" placeholder="Message"></textarea>
    <button id="send" class="primary" title="Send">Send</button>
  </div>
  <div id="hint" class="hint"></div>
</div>
<div id="emojipop" class="popup" hidden></div>
<div id="reactpop" class="popup" hidden></div>
<div id="drop">Drop to attach</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function viewThread(t: Thread): ViewThread {
  return { id: t.id, title: t.title, kind: t.kind, noteToSelf: t.noteToSelf, expireTimer: t.expireTimer };
}

// localPath returns a path the daemon can read: local files as they are,
// anything else (remote workspaces, virtual file systems) copied into the
// staging dir first.
export async function localPath(uri: vscode.Uri, stagingDir: string): Promise<string> {
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  const data = await vscode.workspace.fs.readFile(uri);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const p = uniquePath(stagingDir, path.posix.basename(uri.path) || "file");
  fs.writeFileSync(p, data, { mode: 0o600 });
  return p;
}

function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[/\\\0]/g, "_").slice(0, 200) || "file";
  let p = path.join(dir, safe);
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  for (let i = 1; fs.existsSync(p); i++) {
    p = path.join(dir, `${base}-${i}${ext}`);
  }
  return p;
}

// openFile shows an attachment: in VS Code when the window is local (images,
// PDFs, text), else with the desktop's default application — in a remote
// window a file: URI would name a file on the remote host.
export async function openFile(p: string, contentType?: string): Promise<void> {
  const uri = vscode.Uri.file(p);
  const inEditor = vscode.env.remoteName === undefined && /^(image\/|text\/|application\/(pdf|json))/.test(contentType ?? "");
  if (inEditor) {
    await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
  } else {
    await vscode.env.openExternal(uri);
  }
}
