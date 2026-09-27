// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coordinator makes sure an incoming message is announced once, even with
// several VS Code windows (each with its own extension host and daemon
// connection). The first window to bind a small unix socket is the leader;
// the others connect to it and report their focus. The leader routes each
// notification to the focused window, or — when no window is focused — to
// the desktop. If the leader goes away, a follower takes over.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";

export interface NotifyPayload {
  messageId: number;
  thread: string;
  title: string; // conversation title
  sender: string;
  text: string;
  group: boolean;
}

export type Route = "window" | "desktop";

export interface CoordinatorEvents {
  // This window should show the notification (in-editor or on the desktop).
  notify: [NotifyPayload, Route];
  role: ["leader" | "follower"];
}

interface Peer {
  sock: net.Socket;
  focused: boolean;
  focusedAt: number;
}

export class Coordinator extends EventEmitter<CoordinatorEvents> {
  private server?: net.Server;
  private upstream?: net.Socket;
  private peers = new Set<Peer>();
  private focused = false;
  private focusedAt = 0;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;
  private seen = new Map<number, number>(); // messageId → time routed

  constructor(private readonly path: string) {
    super();
  }

  get isLeader(): boolean {
    return this.server !== undefined;
  }

  start(): void {
    this.stopped = false;
    this.elect();
  }

  dispose(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.upstream?.destroy();
    this.upstream = undefined;
    for (const p of this.peers) {
      p.sock.destroy();
    }
    this.peers.clear();
    if (this.server) {
      this.server.close();
      this.server = undefined;
      try {
        fs.unlinkSync(this.path);
      } catch {
        // already gone
      }
    }
    this.removeAllListeners();
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) {
      return;
    }
    this.focused = focused;
    if (focused) {
      this.focusedAt = Date.now();
    }
    this.upstream?.write(JSON.stringify({ type: "focus", focused }) + "\n");
  }

  // offer is called by every window for every incoming message. Only the
  // leader acts; followers rely on the leader. Without any coordination
  // socket (e.g. it could not be created) the window acts alone.
  offer(p: NotifyPayload): void {
    if (this.upstream) {
      return;
    }
    const now = Date.now();
    if (this.seen.has(p.messageId)) {
      return;
    }
    this.seen.set(p.messageId, now);
    for (const [id, t] of this.seen) {
      if (now - t > 10 * 60_000) {
        this.seen.delete(id);
      }
    }
    // Most recently focused window wins, in case two briefly claim focus.
    let best: Peer | undefined;
    for (const peer of this.peers) {
      if (peer.focused && (!best || peer.focusedAt > best.focusedAt)) {
        best = peer;
      }
    }
    if (this.focused && (!best || this.focusedAt >= best.focusedAt)) {
      this.emit("notify", p, "window");
    } else if (best) {
      best.sock.write(JSON.stringify({ type: "notify", payload: p }) + "\n");
    } else {
      this.emit("notify", p, "desktop");
    }
  }

  private elect(): void {
    if (this.stopped) {
      return;
    }
    const server = net.createServer((sock) => this.onPeer(sock));
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        this.retryLater();
        return;
      }
      // Someone holds the path: follow them, or clear a stale socket.
      const sock = net.createConnection({ path: this.path });
      sock.once("connect", () => {
        sock.removeAllListeners("error");
        this.follow(sock);
      });
      sock.once("error", () => {
        try {
          fs.unlinkSync(this.path);
        } catch {
          // raced with another window
        }
        this.retryLater(50 + Math.random() * 200);
      });
    });
    server.listen(this.path, () => {
      if (this.stopped) {
        server.close();
        return;
      }
      try {
        fs.chmodSync(this.path, 0o600);
      } catch {
        // best effort
      }
      this.server = server;
      this.emit("role", "leader");
    });
  }

  private retryLater(ms = 1000): void {
    clearTimeout(this.retryTimer);
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => this.elect(), ms);
    }
  }

  private follow(sock: net.Socket): void {
    this.upstream = sock;
    this.emit("role", "follower");
    sock.write(JSON.stringify({ type: "focus", focused: this.focused }) + "\n");
    readLines(sock, (msg) => {
      if (msg.type === "notify" && msg.payload) {
        this.emit("notify", msg.payload as NotifyPayload, "window");
      }
    });
    const lost = () => {
      if (this.upstream !== sock) {
        return;
      }
      this.upstream = undefined;
      // Stagger takeovers so one follower wins cleanly.
      this.retryLater(50 + Math.random() * 300);
    };
    sock.on("close", lost);
    sock.on("error", lost);
  }

  private onPeer(sock: net.Socket): void {
    const peer: Peer = { sock, focused: false, focusedAt: 0 };
    this.peers.add(peer);
    readLines(sock, (msg) => {
      if (msg.type === "focus") {
        peer.focused = !!msg.focused;
        if (peer.focused) {
          peer.focusedAt = Date.now();
        }
      }
    });
    const gone = () => this.peers.delete(peer);
    sock.on("close", gone);
    sock.on("error", gone);
  }
}

function readLines(sock: net.Socket, onMsg: (msg: any) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        onMsg(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });
}
