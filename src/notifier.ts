// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Notifier turns incoming messages into notifications: in the focused VS
// Code window, or on the desktop when no window is focused. The
// Coordinator decides which window shows each one.
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";
import { Coordinator, NotifyPayload, Route } from "./coordinator";
import { emojize } from "./emoji";
import { Mutes } from "./mutes";
import { Session, cleanEnv, errText } from "./session";
import { Message, preview } from "./types";

export interface NotifierDeps {
  session: Session;
  coordinator: Coordinator;
  mutes: Mutes;
  openThread: (thread: string) => void;
  focusUri: (thread: string) => vscode.Uri; // opens VS Code at the thread
  windowFocused: () => boolean;
  log: (line: string) => void;
}

// Messages arriving within this window are announced together, so a burst
// (catching up after being offline) is one notification, not dozens.
const COALESCE_MS = 1200;

export interface Shown {
  route: Route;
  title: string;
  body: string;
  thread?: string;
}

export class Notifier implements vscode.Disposable {
  // Fires for every notification shown (logging and tests).
  readonly shown = new vscode.EventEmitter<Shown>();
  private pending: { p: NotifyPayload; route: Route }[] = [];
  private timer?: NodeJS.Timeout;
  private readonly off: () => void;

  constructor(private readonly d: NotifierDeps) {
    const onMessage = (m: Message) => this.onMessage(m);
    const onNotify = (p: NotifyPayload, route: Route) => this.enqueue(p, route);
    d.session.on("message", onMessage);
    d.coordinator.on("notify", onNotify);
    this.off = () => {
      d.session.off("message", onMessage);
      d.coordinator.off("notify", onNotify);
    };
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.off();
    this.shown.dispose();
  }

  private onMessage(m: Message): void {
    if (m.outgoing || m.read || m.author === this.d.session.me) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("signalHeadless");
    if (cfg.get<string>("notifications", "all") === "off" || this.d.mutes.has(m.thread)) {
      return;
    }
    const t = this.d.session.thread(m.thread);
    this.d.coordinator.offer({
      messageId: m.id,
      thread: m.thread,
      title: t?.title || m.authorName || "Signal",
      sender: m.authorName || this.d.session.name(m.author),
      text: preview(m),
      group: t?.kind === "group",
    });
  }

  private enqueue(p: NotifyPayload, route: Route): void {
    // Already on screen in this (focused) window: nothing to announce.
    if (route === "window" && ChatPanel.isWatching(p.thread, this.d.windowFocused())) {
      return;
    }
    this.pending.push({ p, route });
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), COALESCE_MS);
    }
  }

  private flush(): void {
    this.timer = undefined;
    const batch = this.pending.splice(0);
    if (batch.length === 0) {
      return;
    }
    // Messages may already have been read elsewhere (phone, another panel).
    const live = batch.filter(({ p }) => (this.d.session.thread(p.thread)?.unread ?? 1) > 0);
    if (live.length === 0) {
      return;
    }
    const route = live[live.length - 1].route;
    const showText = vscode.workspace.getConfiguration("signalHeadless").get("notificationPreview", true);
    const threads = [...new Set(live.map(({ p }) => p.thread))];
    let title: string;
    let body: string;
    if (live.length === 1) {
      const p = live[0].p;
      title = p.group ? p.title : p.sender;
      body = showText ? (p.group ? `${p.sender}: ${p.text}` : p.text) : p.group ? `Message from ${p.sender}` : "New message";
    } else {
      const titles = [...new Set(live.map(({ p }) => p.title))];
      title = `${live.length} new messages`;
      body = titles.length <= 3 ? titles.join(", ") : `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more`;
    }
    const target = threads.length === 1 ? threads[0] : undefined;
    const desktop = route === "desktop" && vscode.workspace.getConfiguration("signalHeadless").get("desktopNotifications", true);
    this.d.log(`notify (${desktop ? "desktop" : "window"}): ${live.length} message(s) in ${threads.length} conversation(s)`);
    this.shown.fire({ route: desktop ? "desktop" : "window", title, body, thread: target });
    if (desktop) {
      this.desktop(title, body, target ?? threads[threads.length - 1]);
    } else {
      void this.window(title, body, target);
    }
  }

  private async window(title: string, body: string, thread?: string): Promise<void> {
    const actions = thread ? ["Reply", "Open"] : ["Open"];
    const choice = await vscode.window.showInformationMessage(`${title}: ${body}`, ...actions);
    if (choice === "Open") {
      if (thread) {
        this.d.openThread(thread);
      } else {
        void vscode.commands.executeCommand("signalHeadless.nextUnread");
      }
    } else if (choice === "Reply" && thread) {
      await quickReply(this.d.session, thread, title);
    }
  }

  private desktop(title: string, body: string, thread: string): void {
    if (process.platform === "darwin") {
      // Notification Center via AppleScript (no click-through).
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      spawn("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], { stdio: "ignore" })
        .on("error", () => void this.window(title, body, thread));
      return;
    }
    if (process.platform !== "linux") {
      void this.window(title, body, thread); // no desktop notifier wired up yet
      return;
    }
    // notify-send waits for the action; clicking "Open" hands a vscode:// URI
    // to the desktop, which raises VS Code and routes it to our URI handler.
    const args = ["--app-name=Signal", "--category=im.received", "--icon=mail-message-new", "--action=default=Open", "--", title, markupEscape(body)];
    let out = "";
    try {
      const child = spawn("notify-send", args, { stdio: ["ignore", "pipe", "ignore"], env: cleanEnv(process.env) });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (out += d));
      child.on("error", (err) => {
        this.d.log(`notify-send: ${errText(err)}; showing in the editor instead`);
        void this.window(title, body, thread);
      });
      child.on("exit", () => {
        if (out.trim() === "default") {
          const uri = this.d.focusUri(thread).toString();
          spawn("xdg-open", [uri], { stdio: "ignore", detached: true, env: cleanEnv(process.env) }).on("error", () => this.d.openThread(thread)).unref();
        }
      });
    } catch (err) {
      this.d.log(`notify-send: ${errText(err)}`);
    }
  }
}

export async function quickReply(session: Session, thread: string, title: string): Promise<void> {
  const text = await vscode.window.showInputBox({
    title: `Reply to ${title}`,
    prompt: ":shortcodes: become emoji",
    placeHolder: "Message",
    ignoreFocusOut: true,
  });
  if (!text || text.trim() === "") {
    return;
  }
  try {
    await session.send({ thread, body: emojize(text) });
    await session.markRead(thread);
    vscode.window.setStatusBarMessage(`Signal: sent to ${title}`, 3000);
  } catch (err) {
    void vscode.window.showErrorMessage(`Signal: sending to ${title} failed: ${errText(err)}`);
  }
}

function markupEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
