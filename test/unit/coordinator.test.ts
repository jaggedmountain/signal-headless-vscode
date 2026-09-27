// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Coordinator, NotifyPayload, Route } from "../../src/coordinator";
import { waitFor } from "./helpers";

function payload(id: number): NotifyPayload {
  return { messageId: id, thread: "t", title: "T", sender: "S", text: `m${id}`, group: false };
}

function window(sock: string) {
  const c = new Coordinator(sock);
  const got: [number, Route][] = [];
  c.on("notify", (p, r) => got.push([p.messageId, r]));
  c.start();
  return { c, got };
}

test("one leader routes each message to exactly one window", async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shv-coord-")), "c.sock");
  const a = window(sock);
  await waitFor(() => a.c.isLeader, 2000, "a leads");
  const b = window(sock);
  const c = window(sock);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal([a, b, c].filter((w) => w.c.isLeader).length, 1);

  const offerAll = (id: number) => [a, b, c].forEach((w) => w.c.offer(payload(id)));
  const total = () => a.got.length + b.got.length + c.got.length;

  // Nobody focused: the desktop gets it, via the leader, once.
  offerAll(1);
  await waitFor(() => total() === 1, 1000, "desktop route");
  assert.deepEqual(a.got, [[1, "desktop"]]);

  // b focused: b shows it in-window.
  b.c.setFocused(true);
  await new Promise((r) => setTimeout(r, 100));
  offerAll(2);
  await waitFor(() => b.got.length === 1, 1000, "b notified");
  assert.deepEqual(b.got[0], [2, "window"]);

  // Focus moves to the leader.
  b.c.setFocused(false);
  a.c.setFocused(true);
  await new Promise((r) => setTimeout(r, 100));
  offerAll(3);
  await waitFor(() => a.got.length === 2, 1000, "a notified");
  assert.deepEqual(a.got[1], [3, "window"]);

  // The same message offered again is ignored.
  offerAll(3);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(total(), 3);

  // Leader closes: a follower takes over and routing continues.
  a.c.dispose();
  await waitFor(() => b.c.isLeader || c.c.isLeader, 3000, "takeover");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal([b, c].filter((w) => w.c.isLeader).length, 1);
  c.c.setFocused(true);
  await new Promise((r) => setTimeout(r, 100));
  [b, c].forEach((w) => w.c.offer(payload(4)));
  await waitFor(() => c.got.length === 1, 1000, "c notified");
  assert.deepEqual(c.got[0], [4, "window"]);
  b.c.dispose();
  c.c.dispose();
});

test("a stale socket file is replaced", async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shv-coord-")), "c.sock");
  fs.writeFileSync(sock, "");
  const a = window(sock);
  await waitFor(() => a.c.isLeader, 3000, "leader despite stale file");
  a.c.dispose();
  assert.equal(fs.existsSync(sock), false);
});
