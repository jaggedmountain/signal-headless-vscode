// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Newline-delimited JSON-RPC 2.0 client for the daemon's unix socket.
import * as net from "node:net";
import { EventEmitter } from "node:events";

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface RpcClientEvents {
  notification: [method: string, params: any];
  close: [err?: Error];
}

export class RpcClient extends EventEmitter<RpcClientEvents> {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;

  private constructor(private readonly sock: net.Socket) {
    super();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", (err) => this.shutdown(err));
    sock.on("close", () => this.shutdown());
  }

  static connect(path: string, timeoutMs = 5000): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connecting to ${path}: timed out`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.removeAllListeners("error");
        resolve(new RpcClient(sock));
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("not connected"));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      msg.params = params;
    }
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method}: timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.sock.write(JSON.stringify(msg) + "\n");
    });
  }

  close(): void {
    this.sock.end();
    this.sock.destroy();
    this.shutdown();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line !== "") {
        this.onLine(line);
      }
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) {
        return;
      }
      this.pending.delete(msg.id);
      if (p.timer) {
        clearTimeout(p.timer);
      }
      if (msg.error) {
        p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        p.resolve(msg.result);
      }
    } else if (typeof msg.method === "string") {
      this.emit("notification", msg.method, msg.params);
    }
  }

  private shutdown(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer) {
        clearTimeout(p.timer);
      }
      p.reject(err ?? new Error("connection closed"));
    }
    this.pending.clear();
    this.emit("close", err);
  }
}
