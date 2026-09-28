// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Session keeps one connection to the daemon: it connects (starting the
// daemon if allowed), subscribes to native events, caches threads and
// contacts, and reconnects with backoff. No vscode imports, so tests can
// drive it against a --fake daemon.
import { EventEmitter } from "node:events";
import { Launcher, NotLinkedError } from "./launcher";
import { RpcClient } from "./rpc";
import {
  Contact, GroupInfo, Message, MessageRef, SendParams, SendResult, StatusResult, Thread, TypingEvent, displayName,
} from "./types";

export interface SessionOptions {
  socket: string;
  // executable finds (or fetches) the signal-headless binary, for the
  // linked check and auto-start; called only when no daemon is running.
  executable?: () => Promise<string | undefined>;
  autoStart: boolean;
  systemctl?: string; // for tests
  log: (line: string) => void;
}

// "unlinked": no daemon, and this host has no linked device (offer linking).
export type SessionState = "connecting" | "connected" | "disconnected" | "unlinked";

export interface SessionEvents {
  state: [SessionState];
  status: [StatusResult];
  threads: [];
  message: [Message];
  messageUpdate: [Message];
  messageRemoved: [{ id: number; thread: string }];
  history: [{ thread: string; messages: number }];
  typing: [TypingEvent];
  contacts: [];
}

export class Session extends EventEmitter<SessionEvents> {
  private client?: RpcClient;
  private _state: SessionState = "disconnected";
  private _status?: StatusResult;
  private _lastError = "";
  private threadMap = new Map<string, Thread>();
  private contactMap = new Map<string, Contact>();
  private groupList: GroupInfo[] = [];
  private retryTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private stopped = false;
  private startAttempted = false;
  private generation = 0;

  constructor(private opts: SessionOptions) {
    super();
    this.setMaxListeners(50);
  }

  get state(): SessionState {
    return this._state;
  }
  get status(): StatusResult | undefined {
    return this._status;
  }
  get lastError(): string {
    return this._lastError;
  }
  get me(): string {
    return this._status?.account.aci ?? "";
  }
  get threads(): Thread[] {
    return [...this.threadMap.values()].sort((a, b) => b.lastTs - a.lastTs);
  }
  thread(id: string): Thread | undefined {
    return this.threadMap.get(id);
  }
  get contacts(): Contact[] {
    return [...this.contactMap.values()];
  }
  get groups(): GroupInfo[] {
    return this.groupList;
  }
  get totalUnread(): number {
    let n = 0;
    for (const t of this.threadMap.values()) {
      if (!t.archived) {
        n += t.unread;
      }
    }
    return n;
  }

  name(id: string): string {
    if (id === this.me) {
      return "Me";
    }
    const c = this.contactMap.get(id);
    return c ? displayName(c) : id.slice(0, 8);
  }

  updateOptions(opts: SessionOptions): void {
    const reconnect = opts.socket !== this.opts.socket;
    this.opts = opts;
    if (reconnect) {
      this.reconnect();
    }
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  // reconnect drops the current connection and connects again now; an
  // explicit reconnect may auto-start the daemon again.
  reconnect(): void {
    this.stopped = false;
    this.startAttempted = false;
    this.backoff = 1000;
    this.dropClient();
    clearTimeout(this.retryTimer);
    void this.connect();
  }

  // pause disconnects and stops reconnecting (and auto-starting) until
  // reconnect(): while signal-headless is being removed.
  pause(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.dropClient();
    this.setState("disconnected");
  }

  dispose(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.dropClient();
    this.removeAllListeners();
  }

  // ---- daemon methods -------------------------------------------------

  call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.client || this.client.isClosed) {
      return Promise.reject(new Error(this._lastError ? `not connected: ${this._lastError}` : "not connected to the daemon"));
    }
    return this.client.call<T>(method, params, timeoutMs);
  }

  getMessages(thread: string, before?: number, limit = 50): Promise<Message[]> {
    return this.call("getMessages", { thread, before, limit });
  }
  send(p: SendParams): Promise<SendResult> {
    return this.call("send", p, 10 * 60_000);
  }
  react(thread: string, target: MessageRef, emoji: string, remove = false): Promise<void> {
    return this.call("sendReaction", { thread, target, emoji, remove });
  }
  remoteDelete(thread: string, targetTs: number): Promise<void> {
    return this.call("remoteDelete", { thread, targetTs });
  }
  sendTyping(thread: string, typing: boolean): Promise<void> {
    return this.call("sendTyping", { thread, typing });
  }
  markRead(thread: string): Promise<void> {
    const t = this.threadMap.get(thread);
    if (t && t.unread > 0) {
      // Optimistic: the daemon confirms with a thread event.
      this.threadMap.set(thread, { ...t, unread: 0 });
      this.emit("threads");
    }
    return this.call("markRead", { thread });
  }
  archive(thread: string, archived: boolean): Promise<void> {
    return this.call("archiveThread", { thread, archived });
  }
  search(query: string, thread?: string, limit = 100): Promise<Message[]> {
    return this.call("search", { query, thread, limit });
  }
  resolve(recipient: string): Promise<{ thread: string; title: string }> {
    return this.call("resolve", { recipient });
  }
  retryAttachment(messageId: number): Promise<void> {
    return this.call("retryAttachment", { messageId });
  }
  async refreshGroups(): Promise<GroupInfo[]> {
    this.groupList = await this.call<GroupInfo[]>("listGroups", undefined, 60_000);
    return this.groupList;
  }

  // ---- connection -----------------------------------------------------

  private setState(s: SessionState): void {
    if (this._state !== s) {
      this._state = s;
      this.emit("state", s);
    }
  }

  private dropClient(): void {
    this.generation++;
    const c = this.client;
    this.client = undefined;
    c?.removeAllListeners();
    c?.close();
    this.setState("disconnected");
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private async connect(): Promise<void> {
    if (this.stopped || (this.client && !this.client.isClosed)) {
      return;
    }
    const gen = ++this.generation;
    this.setState("connecting");
    let client: RpcClient;
    try {
      client = await this.dial();
    } catch (err) {
      if (gen !== this.generation) {
        return;
      }
      this._lastError = errText(err);
      this.opts.log(`connect: ${this._lastError}`);
      this.setState(err instanceof NotLinkedError ? "unlinked" : "disconnected");
      this.scheduleRetry();
      return;
    }
    if (gen !== this.generation || this.stopped) {
      client.close();
      return;
    }
    this.client = client;
    client.on("notification", (method, params) => this.onNotification(method, params));
    client.on("close", (err) => {
      if (this.client !== client) {
        return;
      }
      this.client = undefined;
      this._lastError = err ? errText(err) : "daemon closed the connection";
      this.opts.log(`disconnected: ${this._lastError}`);
      this.setState("disconnected");
      this.scheduleRetry();
    });
    try {
      const st = await client.call<StatusResult>("subscribe");
      const [threads, contacts] = await Promise.all([
        client.call<Thread[]>("listThreads"),
        client.call<Contact[]>("listContacts", undefined, 60_000),
      ]);
      if (this.client !== client) {
        return;
      }
      this._status = st;
      this.threadMap = new Map(threads.map((t) => [t.id, t]));
      this.contactMap = new Map(contacts.map((c) => [c.id, c]));
      this._lastError = "";
      this.backoff = 1000;
      this.startAttempted = false;
      this.opts.log(`connected: ${st.account.number} (device ${st.account.deviceId}), daemon ${st.version}, ${st.connection}`);
      this.setState("connected");
      this.emit("status", st);
      this.emit("threads");
      this.emit("contacts");
    } catch (err) {
      this._lastError = errText(err);
      this.opts.log(`subscribe: ${this._lastError}`);
      if (this.client === client) {
        this.dropClient();
        this.scheduleRetry();
      }
    }
  }

  private async dial(): Promise<RpcClient> {
    try {
      return await RpcClient.connect(this.opts.socket);
    } catch (err: any) {
      const absent = err?.code === "ENOENT" || err?.code === "ECONNREFUSED";
      const exe = absent ? await this.opts.executable?.() : undefined;
      if (!exe) {
        throw err;
      }
      const launcher = new Launcher({ executable: exe, socket: this.opts.socket, systemctl: this.opts.systemctl, log: this.opts.log });
      if (!this.opts.autoStart || this.startAttempted) {
        // Still tell "not linked" apart from "not running".
        const check = await launcher.check().catch(() => undefined);
        throw check && !check.linked ? new NotLinkedError() : err;
      }
      try {
        await launcher.start();
      } catch (e) {
        // Keep checking while unlinked, so linking from a terminal is noticed
        // too; after a real start failure, wait for an explicit reconnect.
        if (!(e instanceof NotLinkedError)) {
          this.startAttempted = true;
        }
        throw e;
      }
    }
    return RpcClient.connect(this.opts.socket);
  }

  // linked reports that linking finished: start the daemon now.
  linked(): void {
    this.reconnect();
  }

  private onNotification(method: string, params: any): void {
    switch (method) {
      case "message":
        this.emit("message", params as Message);
        break;
      case "messageUpdate":
        this.emit("messageUpdate", params as Message);
        break;
      case "history":
        this.emit("history", params as { thread: string; messages: number });
        break;
      case "messageRemoved":
        this.emit("messageRemoved", params as { id: number; thread: string });
        break;
      case "thread": {
        const t = params as Thread;
        this.threadMap.set(t.id, t);
        this.emit("threads");
        break;
      }
      case "typing":
        this.emit("typing", params as TypingEvent);
        break;
      case "connection":
        this._status = params as StatusResult;
        this.emit("status", this._status);
        break;
      case "contacts":
        void this.refetch();
        break;
    }
  }

  private async refetch(): Promise<void> {
    try {
      const [threads, contacts] = await Promise.all([
        this.call<Thread[]>("listThreads"),
        this.call<Contact[]>("listContacts", undefined, 60_000),
      ]);
      this.threadMap = new Map(threads.map((t) => [t.id, t]));
      this.contactMap = new Map(contacts.map((c) => [c.id, c]));
      this.emit("threads");
      this.emit("contacts");
    } catch (err) {
      this.opts.log(`refetch: ${errText(err)}`);
    }
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { cleanEnv } from "./env";
