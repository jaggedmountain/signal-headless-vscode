// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// End-to-end tests inside VS Code against the --fake daemon started by
// runVSCode.ts.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Api } from "../../src/extension";
import type { Shown } from "../../src/notifier";
import { linkWrapper, pidsWithArg } from "../unit/helpers";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const ECHO = "00000000-0000-4000-8000-00000000000e";
const GROUP = "Z3JvdXBncm91cGdyb3VwZ3JvdXBncm91cGdyb3VwMDA=";

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// With SHV_SCREENSHOTS=DIR, capture the (xvfb) screen at interesting points.
async function shot(name: string, settle = 800): Promise<void> {
  const dir = process.env.SHV_SCREENSHOTS;
  if (!dir) {
    return;
  }
  await sleep(settle);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("import", ["-window", "root", path.join(dir, `${name}.png`)]);
}

describe("signal-headless extension", () => {
  let api: Api;
  const shown: Shown[] = [];

  before(async () => {
    const ext = vscode.extensions.getExtension<Api>("jaggedmountain.signal-headless");
    assert.ok(ext, "extension not found");
    api = await ext.activate();
    api.notifier.shown.event((s) => shown.push(s));
    await waitFor(() => api.session.state === "connected", 10_000, "connection to the fake daemon");
    assert.equal(api.session.status?.account.number, "+15550000000", "connected to the fake daemon, not a real one");
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("connects to the configured socket and lists conversations", async () => {
    assert.ok(api.session.threads.some((t) => t.id === GROUP && t.title === "Tea Party"));
    await vscode.commands.executeCommand("workbench.view.extension.signalHeadless");
    assert.ok(api.coordinator.isLeader, "the only window leads notification routing");
  });

  it("opens a chat panel whose webview renders the history", async () => {
    await vscode.commands.executeCommand("signalHeadless.open", GROUP);
    const p = api.panels().find((x) => x.threadId === GROUP);
    assert.ok(p);
    await waitFor(() => p.isReady, 10_000, "webview ready");
    const probe = await p.probe();
    assert.deepEqual(probe.errors, []);
    assert.equal(probe.messages, 2);
    assert.match(probe.text, /No room! No room!/);
    assert.match(probe.text, /plenty of room/);
    assert.match(probe.text, /😤/, "reaction shown");
    assert.deepEqual(probe.hiddenButShown, [], "hidden elements must not be displayed");
    assert.equal(p.panel.title, "Tea Party");
    await shot("1-group");
  });

  it("sends from the panel with :shortcodes: and shows the reply", async () => {
    await vscode.commands.executeCommand("signalHeadless.open", ECHO);
    const p = api.panels().find((x) => x.threadId === ECHO)!;
    await waitFor(() => p.isReady, 10_000, "webview ready");
    await p.handle({ type: "send", body: "hello :tada:" });
    await waitFor(async () => /echo: hello 🎉/.test((await p.probe()).text), 8000, "echo reply rendered");
    const probe = await p.probe();
    assert.deepEqual(probe.errors, []);
    assert.match(probe.text, /hello 🎉/);
  });

  it("reaction picker closes after picking", async () => {
    const p = api.panels().find((x) => x.threadId === ECHO)!;
    assert.deepEqual((await p.probe()).openPopups, [], "no popup before");
    p.post({ type: "probeReact" });
    assert.deepEqual((await p.probe()).openPopups, ["reactpop"], "picker open");
    const reacted = new Promise<string>((resolve) => {
      const sub = p.panel.webview.onDidReceiveMessage((m: { type: string; emoji?: string }) => {
        if (m.type === "react") {
          sub.dispose();
          resolve(m.emoji!);
        }
      });
    });
    p.post({ type: "probePick" });
    assert.equal(await reacted, "👍");
    const after = await p.probe();
    assert.deepEqual(after.openPopups, [], "picker closed after picking");
    assert.deepEqual(after.hiddenButShown, []);
  });

  it("shows a deleted message's placeholder, then drops it", async () => {
    const p = api.panels().find((x) => x.threadId === ECHO)!;
    const res = await api.session.send({ thread: ECHO, body: "regret this" });
    await waitFor(async () => /regret this/.test((await p.probe()).text), 5000, "sent message shown");
    await api.session.remoteDelete(ECHO, res.timestamp);
    await waitFor(async () => /This message was deleted\./.test((await p.probe()).text), 5000, "placeholder shown");
    // The test daemon runs with --deleted-ttl 2s.
    await waitFor(async () => !/This message was deleted\./.test((await p.probe()).text), 8000, "placeholder removed");
    // Gone as a message and from the echo bot's quote; only the bot's own
    // words ("echo: regret this") remain.
    const probe = await p.probe();
    assert.doesNotMatch(probe.text, /(^|\n)regret this/);
    assert.match(probe.text, /echo: regret this/);
    assert.deepEqual(probe.errors, []);
  });

  it("shows the sender's link preview as a card", async () => {
    const url = "https://tea.example/brewing";
    await api.session.call("debugInject", {
      message: {
        thread: ALICE, author: ALICE, body: `How to brew it properly: ${url}`,
        attachments: [{ filename: "preview.png", contentType: "image/png", kind: "preview", state: "pending" }],
        previews: [{ url, title: "The Mad Hatter's Guide to Tea", description: "Six o'clock, always. Clean cups optional; move down one place.", image: 0 }],
      },
      attachmentData: ["base64:iVBORw0KGgoAAAANSUhEUgAAAPAAAAB+CAIAAACVjQttAAACSElEQVR4nO3dTWrbUBhAUUdkE91EDTW0Owp4EfWgmzB0Ryl00FV0G52Epgl27NQm0rs5Z2oNHvblQz+WdPPx66cVVExzLwCuSdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJqU27kXsCy/vv2cewn/Y73bzL2EpTChSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYIm5dX3FH7f7o99dLffJrdZvktuhVzvNgv5nq+yzc2ZL94c+vc+35cPn+dewlu7//1j7iVc0+kJ/U5SpuGloKXMcI4eFKqZER2e0Goe18l94vZxwoEJrWbG9TxoNTO0J0GrmdE9Bq1mAlz6JuUhaOOZBhOalGllPBNiQpMiaFIm+xuUmNCkCJoUQZMiaFIETYqgSRE0KYImZfr75A4IePWTk1i49j2wJ9nlIGVa/fO8MBidCU3KQ9CGNA0OCgtiTxC9xOMuhyFNwJN9aE0zuucHhZpmaAfOcmiacR0+badpBnX0PLSmGdFLF1bu9ltZM5bTVwplzUDOvbCyqHfRvfE2I1rad7i49xS+E5e8wXJG691m7iUshT8nkSJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNinsKSTGhSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETcof0qWKF5D9GT8AAAAASUVORK5CYII="],
    });
    await vscode.commands.executeCommand("signalHeadless.open", ALICE);
    const p = api.panels().find((x) => x.threadId === ALICE)!;
    await waitFor(() => p.isReady, 10_000, "webview ready");
    await waitFor(async () => /Mad Hatter's Guide to Tea/.test((await p.probe()).text), 8000, "preview card shown");
    const probe = await p.probe();
    assert.match(probe.text, /tea\.example/);
    assert.deepEqual(probe.errors, []);
    await shot("7-preview", 1500);
  });

  it("offers a preview for a typed link and sends it", async () => {
    await vscode.commands.executeCommand("signalHeadless.open", BOB);
    const p = api.panels().find((x) => x.threadId === BOB)!;
    await waitFor(() => p.isReady, 10_000, "webview ready");
    p.post({ type: "probeInput", text: "brewing guide: https://tea.example/brew" });
    await waitFor(async () => /Preview of tea\.example/.test((await p.probe()).composer), 8000, "draft preview card");
    await shot("8-draft-preview", 300);
    p.post({ type: "probeSend" });
    await waitFor(async () => {
      const msgs = await api.session.getMessages(BOB, undefined, 5);
      return msgs.some((m) => m.body.includes("tea.example/brew") && m.previews?.[0]?.title === "Preview of tea.example");
    }, 8000, "sent with its preview");
    await waitFor(async () => /Preview of tea\.example/.test((await p.probe()).text), 5000, "sent card shown");
    assert.doesNotMatch((await p.probe()).composer, /Preview of/, "draft card cleared after sending");

    // Off: no fetching at all.
    await vscode.workspace.getConfiguration("signalHeadless").update("sendLinkPreviews", "off", vscode.ConfigurationTarget.Global);
    try {
      p.post({ type: "probeInput", text: "another https://tea.example/second" });
      await sleep(1500);
      assert.doesNotMatch((await p.probe()).composer, /Preview of/);
    } finally {
      await vscode.workspace.getConfiguration("signalHeadless").update("sendLinkPreviews", undefined, vscode.ConfigurationTarget.Global);
      p.post({ type: "probeInput", text: "" });
    }
  });

  it("sends staged attachments", async () => {
    const file = path.join(process.env.SHV_TEST_DIR!, "note.txt");
    fs.writeFileSync(file, "attachment body");
    await vscode.commands.executeCommand("signalHeadless.open", ECHO, { attach: [file] });
    const p = api.panels().find((x) => x.threadId === ECHO)!;
    const got: string[] = [];
    const on = (m: { body: string; thread: string }) => m.thread === ECHO && got.push(m.body);
    api.session.on("message", on);
    await p.handle({ type: "send", body: "with file" });
    await waitFor(() => got.includes("echo: with file (+1 attachments)"), 8000, "echo of attachment");
    api.session.off("message", on);
    const probe = await p.probe();
    assert.match(probe.text, /note\.txt/);
    await shot("2-echo");
  });

  it("restores the draft when the daemon refuses a send", async () => {
    const p = api.panels().find((x) => x.threadId === ECHO)!;
    await p.handle({ type: "attachData", name: "gone.txt", data: Buffer.from("x").toString("base64") });
    // Remove the staged copy behind the panel's back: the daemon rejects it.
    fs.rmSync(path.join(api.chat.stagingDir, "gone.txt"));
    await assert.rejects(p.handle({ type: "send", body: "keep me" }));
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("notifies about incoming messages, once, and coalesces bursts", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(1500); // let earlier echo replies flush
    shown.length = 0;
    await api.session.call("debugInject", { message: { thread: ALICE, author: ALICE, body: "Off with their heads" } });
    await waitFor(() => shown.length === 1, 5000, "notification");
    assert.equal(shown[0].title, "Alice Liddell");
    assert.equal(shown[0].body, "Off with their heads");
    assert.equal(shown[0].thread, ALICE);

    shown.length = 0;
    for (const body of ["one", "two", "three"]) {
      await api.session.call("debugInject", { message: { thread: BOB, author: BOB, body } });
    }
    await api.session.call("debugInject", { message: { thread: GROUP, author: BOB, body: "four" } });
    await waitFor(() => shown.length >= 1, 5000, "burst notification");
    await sleep(1500);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, "4 new messages");
    assert.match(shown[0].body, /Bob/);
    assert.match(shown[0].body, /Tea Party/);
  });

  it("does not notify for the conversation on screen", async function () {
    if (!vscode.window.state.focused) {
      this.skip(); // "on screen" needs a focused window
    }
    await vscode.commands.executeCommand("signalHeadless.open", GROUP);
    const p = api.panels().find((x) => x.threadId === GROUP)!;
    await waitFor(() => p.isReady && p.visible, 10_000, "group panel visible");
    await sleep(1500);
    shown.length = 0;
    await api.session.call("debugInject", { message: { thread: GROUP, author: ALICE, body: "seen already" } });
    await api.session.call("debugInject", { message: { thread: BOB, author: BOB, body: "not on screen" } });
    await waitFor(() => shown.length === 1, 5000, "notification");
    await sleep(1500);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].thread, BOB);
    await waitFor(() => api.session.thread(GROUP)?.unread === 0, 5000, "group marked read while watched");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("stays quiet for muted conversations and outgoing messages", async () => {
    await vscode.commands.executeCommand("signalHeadless.mute", ALICE);
    shown.length = 0;
    await api.session.call("debugInject", { message: { thread: ALICE, author: ALICE, body: "muted" } });
    await api.session.send({ thread: ECHO, body: "outgoing only" });
    await sleep(2500);
    // The echo contact answers, which is incoming and does notify.
    assert.ok(shown.every((s) => s.thread !== ALICE), JSON.stringify(shown));
    await vscode.commands.executeCommand("signalHeadless.unmute", ALICE);
  });

  it("marks a conversation read when its panel is watched", async function () {
    await api.session.call("debugInject", { message: { thread: BOB, author: BOB, body: "read me" } });
    await waitFor(() => (api.session.thread(BOB)?.unread ?? 0) > 0, 5000, "unread");
    if (!vscode.window.state.focused) {
      // Under xvfb the window may never get focus; reading needs a focused window.
      await vscode.commands.executeCommand("signalHeadless.markRead", BOB);
    } else {
      await vscode.commands.executeCommand("signalHeadless.open", BOB);
    }
    await waitFor(() => api.session.thread(BOB)?.unread === 0, 5000, "read");
  });

  it("filters the conversation list to the last signalHeadless.activeDays days", async () => {
    const tv = api.threadsView;
    const old = "00000000-0000-4000-8000-0000000000ff";
    await api.session.call("debugInject", { message: { thread: old, author: old, body: "long ago", ts: Date.now() - 60 * 86_400_000 } });
    await waitFor(() => api.session.thread(old) !== undefined, 5000, "old conversation listed");
    await api.session.markRead(old);
    await waitFor(() => api.session.thread(old)?.unread === 0, 5000, "read");
    assert.ok(tv.isActiveOnly, "active is the default");
    const ids = () => tv.getChildren().map((t) => t.id);
    assert.ok(!ids().includes(old), "old conversation hidden");
    assert.ok(ids().includes(ALICE));
    await vscode.commands.executeCommand("signalHeadless.showAllThreads");
    assert.ok(ids().includes(old), "shown with All");
    await vscode.commands.executeCommand("signalHeadless.showActiveThreads");
    assert.ok(!ids().includes(old));
    assert.equal(tv.view.description, "last 30 days");
    // A longer active period brings the 60-day-old conversation back.
    const cfg = vscode.workspace.getConfiguration("signalHeadless");
    await cfg.update("activeDays", 90, vscode.ConfigurationTarget.Global);
    try {
      await waitFor(() => ids().includes(old), 5000, "shown with activeDays 90");
      assert.equal(tv.view.description, "last 90 days");
    } finally {
      await cfg.update("activeDays", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => !ids().includes(old), 5000, "hidden again at 30 days");
    // Unread keeps even an old conversation visible.
    await api.session.call("debugInject", { message: { thread: old, author: old, body: "still old", ts: Date.now() - 59 * 86_400_000 } });
    await waitFor(() => ids().includes(old), 5000, "unread old conversation shown");
  });

  it("lists search results in the Search Results panel", async () => {
    const n = await vscode.commands.executeCommand<number>("signalHeadless.search", "room");
    assert.equal(n, 2, "both Tea Party messages mention room");
    const sv = api.searchView;
    const groups = sv.getChildren();
    assert.equal(groups.length, 1);
    const item = sv.getTreeItem(groups[0]);
    assert.equal(item.label, "Tea Party");
    assert.equal(item.description, "2");
    const hits = sv.getChildren(groups[0]);
    const hitItem = sv.getTreeItem(hits[0]);
    const label = hitItem.label as vscode.TreeItemLabel;
    assert.match(label.label, /room/i);
    assert.ok(label.highlights && label.highlights.length > 0, "match highlighted");
    // Selecting a result opens the conversation at that message.
    await vscode.commands.executeCommand(hitItem.command!.command, ...(hitItem.command!.arguments ?? []));
    const p = api.panels().find((x) => x.threadId === GROUP)!;
    await waitFor(() => p.isReady && p.visible, 10_000, "conversation opened");
    await shot("9-search", 800);
    // Scoped to one conversation.
    assert.equal(await vscode.commands.executeCommand<number>("signalHeadless.search", "room", ALICE), 0);
    await vscode.commands.executeCommand("signalHeadless.clearSearch");
    assert.equal(sv.getChildren().length, 0);
  });

  it("shows diagnostics and deletes old local history", async () => {
    const dv = api.diagnosticsView;
    await vscode.commands.executeCommand("signalHeadless.diagnostics.focus");
    await dv.refresh();
    const labels = () => dv.getChildren().map((r) => `${r.label} ${r.description ?? ""}`).join("\n");
    assert.match(labels(), /\+15550000000/);
    assert.match(labels(), /messages/);
    const before = dv.current!.messages;
    await shot("10-diagnostics", 500);
    // An old message in Echo's conversation, then delete everything there
    // older than 30 days.
    await api.session.call("debugInject", { message: { thread: ECHO, author: ECHO, body: "from last year", ts: Date.now() - 365 * 86_400_000 } });
    await dv.refresh();
    assert.equal(dv.current!.messages, before + 1);
    const res = await vscode.commands.executeCommand<{ messages: number }>("signalHeadless.purge", ECHO, { before: Date.now() - 30 * 86_400_000, confirmed: true });
    assert.equal(res.messages, 1);
    await dv.refresh();
    assert.equal(dv.current!.messages, before);
    const left = await api.session.getMessages(ECHO, undefined, 200);
    assert.ok(!left.some((m) => m.body === "from last year"));
    // All devices: the daemon syncs "delete for me" first (the fake accepts it).
    await api.session.call("debugInject", { message: { thread: ECHO, author: ECHO, body: "older still", ts: Date.now() - 400 * 86_400_000 } });
    const all = await vscode.commands.executeCommand<{ messages: number }>("signalHeadless.purge", ECHO, { before: Date.now() - 30 * 86_400_000, confirmed: true, allDevices: true });
    assert.equal(all.messages, 1);
  });

  it("single-panel mode switches one tab and keeps drafts per conversation", async () => {
    const cfg = () => vscode.workspace.getConfiguration("signalHeadless");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await cfg().update("chatPanels", "single", vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("signalHeadless.open", ALICE);
      const p = api.panels().find((x) => x.threadId === ALICE)!;
      await waitFor(() => p.isReady, 10_000, "webview ready");
      p.post({ type: "probeInput", text: "for alice" });
      await waitFor(async () => (await p.probe()).input === "for alice", 3000, "typed");
      await vscode.commands.executeCommand("signalHeadless.open", BOB);
      assert.equal(api.panels().length, 1, "one tab");
      assert.equal(p.threadId, BOB);
      await waitFor(async () => /read me/.test((await p.probe()).text), 8000, "Bob's messages shown");
      assert.equal((await p.probe()).input, "", "Bob's own (empty) draft");
      assert.equal(p.panel.title.replace(/^\(\d+\) /, ""), "Bob");
      p.post({ type: "probeInput", text: "for bob" });
      await waitFor(async () => (await p.probe()).input === "for bob", 3000, "typed");
      await vscode.commands.executeCommand("signalHeadless.open", ALICE);
      await waitFor(async () => (await p.probe()).input === "for alice", 8000, "Alice's draft back");
      await vscode.commands.executeCommand("signalHeadless.open", BOB);
      await waitFor(async () => (await p.probe()).input === "for bob", 8000, "Bob's draft back");
      p.post({ type: "probeInput", text: "" });
    } finally {
      await cfg().update("chatPanels", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  it("archives and unarchives", async () => {
    await vscode.commands.executeCommand("signalHeadless.archive", ALICE);
    await waitFor(() => api.session.thread(ALICE)?.archived === true, 5000, "archived");
    await vscode.commands.executeCommand("signalHeadless.unarchive", ALICE);
    await waitFor(() => api.session.thread(ALICE)?.archived !== true, 5000, "unarchived");
  });

  it("reveals a message found by search", async () => {
    const hits = await api.session.search("Would you like some tea");
    assert.equal(hits.length, 1);
    await vscode.commands.executeCommand("signalHeadless.open", ALICE, { reveal: hits[0].ts });
    const p = api.panels().find((x) => x.threadId === ALICE)!;
    await waitFor(() => p.isReady, 10_000, "webview ready");
    await waitFor(async () => /Would you like some tea/.test((await p.probe()).text), 5000, "revealed");
    await shot("3-alice");
  });

  it("downloads the daemon release when none is installed", async () => {
    // The "release" holds the scratch-store wrapper, so whatever it starts
    // stays away from any real account.
    const dir = fs.mkdtempSync(path.join(process.env.SHV_TEST_DIR!, "dl-"));
    fs.mkdirSync(path.join(dir, "stage", "signal-headless"), { recursive: true });
    fs.copyFileSync(linkWrapper(path.join(dir, "host")), path.join(dir, "stage", "signal-headless", "signal-headless"));
    const asset = "signal-headless-linux-x64.tar.gz";
    execFileSync("tar", ["-C", path.join(dir, "stage"), "-czf", path.join(dir, asset), "signal-headless"]);
    const tgz = fs.readFileSync(path.join(dir, asset));
    const sums = `${crypto.createHash("sha256").update(tgz).digest("hex")}  ${asset}\n`;
    const version = api.binaries.pinned.version;
    const srv = http.createServer((req, res) => {
      if (req.url === `/download/${version}/${asset}`) {
        res.end(tgz);
      } else if (req.url === `/download/${version}/SHA256SUMS`) {
        res.end(sums);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const socket = path.join(dir, "s.sock");
    const cfg = () => vscode.workspace.getConfiguration("signalHeadless");
    const G = vscode.ConfigurationTarget.Global;
    try {
      await cfg().update("releasesUrl", `http://127.0.0.1:${(srv.address() as { port: number }).port}`, G);
      await cfg().update("downloadDaemon", "always", G);
      await cfg().update("autoStartDaemon", true, G);
      await cfg().update("executablePath", "", G);
      await cfg().update("socketPath", socket, G);
      // No daemon at the new socket: the extension needs a binary, finds
      // none, downloads the release, and runs it (an unlinked scratch host).
      await waitFor(() => api.session.state === "unlinked", 20_000, "downloaded binary in use");
      assert.match(api.binaries.describe(), /managed/);
      assert.match(api.binaries.describe(), new RegExp(version.replace(/\./g, "\\.")));
    } finally {
      srv.close();
      await cfg().update("executablePath", "/nonexistent", G);
      await cfg().update("downloadDaemon", "never", G);
      await cfg().update("releasesUrl", undefined, G);
      await cfg().update("autoStartDaemon", false, G);
      for (const pid of pidsWithArg(socket)) {
        process.kill(pid, "SIGTERM");
      }
    }
  });

  // Last: it points the extension at a different (unlinked) host.
  it("links an unlinked host from the link panel and connects", async () => {
    const dir = fs.mkdtempSync(path.join(process.env.SHV_TEST_DIR!, "link-"));
    const socket = path.join(dir, "s.sock");
    const exe = linkWrapper(dir);
    const cfg = vscode.workspace.getConfiguration("signalHeadless");
    await cfg.update("executablePath", exe, vscode.ConfigurationTarget.Global);
    await cfg.update("autoStartDaemon", true, vscode.ConfigurationTarget.Global);
    await cfg.update("socketPath", socket, vscode.ConfigurationTarget.Global);
    try {
      await waitFor(() => api.session.state === "unlinked", 15_000, "unlinked state");
      await vscode.commands.executeCommand("signalHeadless.link");
      const panel = api.linkPanel();
      assert.ok(panel, "link panel open");
      const phases: string[] = [];
      panel.onPhase.event((p) => phases.push(p));
      panel.start("test-device");
      await waitFor(() => phases.includes("waiting"), 5000, "waiting for scan");
      await shot("4-link", 400);
      const history: string[] = [];
      panel.onHistory.event((h) => history.push(h));
      await waitFor(() => panel.phase === "connected", 20_000, "connected after linking");
      assert.deepEqual(phases, ["waiting", "linked", "connected"]);
      assert.equal(api.session.status?.account.number, "+15550000000");
      assert.match(fs.readFileSync(path.join(dir, "calls"), "utf8"), /--link --json --name test-device/);
      // The fake daemon plays a history transfer: waiting → … → done.
      await waitFor(() => history.includes("downloading") || history.includes("importing"), 10_000, "transfer in progress");
      await shot("5-history", 200);
      await waitFor(() => history.includes("done"), 10_000, "transfer done");
      assert.equal(api.session.status?.history?.messages, 3);
      const dormouse = "00000000-0000-4000-8000-00000000000d";
      await waitFor(() => api.session.thread(dormouse) !== undefined, 5000, "imported conversation listed");
      const msgs = await api.session.getMessages(dormouse);
      assert.deepEqual(msgs.map((m) => m.body), ["Twinkle, twinkle, little bat!", "How I wonder what you're at!", "Up above the world you fly"]);
      await shot("6-linked");
    } finally {
      for (const pid of pidsWithArg(socket)) {
        process.kill(pid, "SIGTERM");
      }
    }
  });
});
