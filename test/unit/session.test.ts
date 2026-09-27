// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Session and RpcClient against a real --fake daemon.
import { after, before, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Session } from "../../src/session";
import { RpcClient, RpcError } from "../../src/rpc";
import { Message } from "../../src/types";
import { FakeDaemon, binary, pidsWithArg, startFake, waitFor } from "./helpers";

const ECHO = "00000000-0000-4000-8000-00000000000e";
const ALICE = "00000000-0000-4000-8000-00000000000a";
const SELF = "00000000-0000-4000-8000-000000000001";

let fake: FakeDaemon;
before(async () => {
  fake = await startFake();
});
after(async () => {
  await fake.stop();
});

function session(socket = fake.socket, extra: Partial<ConstructorParameters<typeof Session>[0]> = {}): Session {
  return new Session({ socket, autoStart: false, log: () => undefined, ...extra });
}

test("rpc: calls, errors and notifications", async () => {
  const c = await RpcClient.connect(fake.socket);
  const v = await c.call<{ version: string }>("version");
  assert.ok(v.version);
  await assert.rejects(c.call("noSuchMethod"), (e: unknown) => e instanceof RpcError && e.code === -32601);
  c.close();
  await assert.rejects(c.call("version"), /not connected/);
});

test("session loads seeded state and follows a conversation", async () => {
  const s = session();
  s.start();
  await waitFor(() => s.state === "connected" && s.threads.length >= 4, 5000, "seeded threads");
  assert.equal(s.me, SELF);
  const titles = s.threads.map((t) => t.title);
  for (const t of ["Alice Liddell", "Tea Party", "Echo Bot", "Note to Self"]) {
    assert.ok(titles.includes(t), `missing ${t} in ${titles}`);
  }
  assert.equal(s.name(ALICE), "Alice Liddell");
  assert.ok(s.totalUnread > 0);

  const got: Message[] = [];
  s.on("message", (m) => got.push(m));
  const updates: Message[] = [];
  s.on("messageUpdate", (m) => updates.push(m));
  const res = await s.send({ thread: ECHO, body: "ping 🎉" });
  assert.ok(res.timestamp > 0);
  await waitFor(() => got.some((m) => !m.outgoing && m.body === "echo: ping 🎉"), 5000, "echo reply");
  const mine = got.find((m) => m.outgoing)!;
  assert.equal(mine.body, "ping 🎉");
  await waitFor(() => updates.some((m) => m.id === mine.id && m.status === "read"), 5000, "read receipt");
  const reply = got.find((m) => !m.outgoing)!;
  assert.equal(reply.quote?.ts, mine.ts);

  await waitFor(() => (s.thread(ECHO)?.unread ?? 0) > 0, 3000, "unread echo");
  await s.markRead(ECHO);
  assert.equal(s.thread(ECHO)?.unread, 0);

  const hist = await s.getMessages(ECHO, undefined, 10);
  assert.ok(hist.some((m) => m.id === reply.id));
  const hits = await s.search("ping");
  assert.ok(hits.some((m) => m.id === mine.id));

  await s.react(ECHO, { author: reply.author, ts: reply.ts }, "👍");
  await s.archive(ECHO, true);
  await waitFor(() => s.thread(ECHO)?.archived === true, 3000, "archived");
  await s.archive(ECHO, false);
  s.dispose();
});

test("session reconnects when the daemon restarts", async () => {
  const s = session();
  s.start();
  await waitFor(() => s.state === "connected", 5000, "connected");
  await fake.stop();
  await waitFor(() => s.state !== "connected", 5000, "disconnect");
  fake = await startFake(fake.dir);
  await waitFor(() => s.state === "connected", 10_000, "reconnected");
  s.dispose();
});

test("session auto-starts the daemon when allowed", async () => {
  // A wrapper that forces --fake and a scratch store: the real binary with
  // the arguments the extension passes would open the real account.
  const dir = fs.mkdtempSync(path.join(fake.dir, "auto-"));
  const socket = path.join(dir, "auto.sock");
  const wrapper = path.join(dir, "signal-headless");
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" > ${dir}/args\nexec ${binary} "$@" --fake --data ${dir}\n`, { mode: 0o755 });
  const s = session(socket, { autoStart: true, executable: async () => wrapper });
  s.start();
  try {
    await waitFor(() => s.state === "connected", 15_000, "auto-started daemon");
    assert.equal(fs.readFileSync(path.join(dir, "args"), "utf8").trim(), `--daemon --foreground=false --socket ${socket}`);
  } finally {
    s.dispose();
    // The daemon outlives its starter (setsid); stop it.
    for (const pid of pidsWithArg(socket)) {
      process.kill(pid, "SIGTERM");
    }
  }
});

test("without auto-start a missing daemon is reported and retried", async () => {
  const s = session(path.join(fake.dir, "nothing.sock"));
  s.start();
  await waitFor(() => s.lastError !== "", 3000, "error");
  assert.equal(s.state, "disconnected");
  await assert.rejects(s.send({ thread: ECHO, body: "x" }), /not connected/);
  s.dispose();
});
