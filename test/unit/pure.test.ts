// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emojize } from "../../src/emoji";
import { dataDir, socketPath } from "../../src/paths";
import { cleanEnv } from "../../src/session";
import { Mutes } from "../../src/mutes";
import { preview } from "../../src/types";
import { snippet } from "../../src/snippet";
import { esc, linkify, renderMessage } from "../../webview/render";

test("emojize matches the TUI's rules", () => {
  const cases: Record<string, string> = {
    "haha :joy:": "haha 😂",
    ":JOY::+1:": "😂👍",
    "meet at 12:30:45": "meet at 12:30:45",
    ":not_an_emoji: stays": ":not_an_emoji: stays",
    "a:b:c": "a:b:c",
    "party :tada: :thumbsup:": "party 🎉 👍",
    "x::joy:": "x:😂",
    "no colons": "no colons",
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.equal(emojize(input), want, input);
  }
});

test("socket path precedence", () => {
  assert.equal(socketPath("/x/y.sock", { SIGNAL_HEADLESS_SOCKET: "/env.sock" }), "/x/y.sock");
  assert.equal(socketPath("", { SIGNAL_HEADLESS_SOCKET: "/env.sock", XDG_RUNTIME_DIR: "/tmp" }), "/env.sock");
  assert.equal(socketPath("", { XDG_RUNTIME_DIR: os.tmpdir() }), path.join(os.tmpdir(), "signal-headless.sock"));
  assert.equal(socketPath("~/s.sock", {}), path.join(os.homedir(), "s.sock"));
});

test("cleanEnv restores the snap's saved variables", () => {
  const env = cleanEnv({ GTK_PATH: "/snap/x", GTK_PATH_VSCODE_SNAP_ORIG: "", XDG_DATA_DIRS: "/snap", XDG_DATA_DIRS_VSCODE_SNAP_ORIG: "/usr/share", HOME: "/h" });
  assert.deepEqual(env, { XDG_DATA_DIRS: "/usr/share", HOME: "/h" });
});

test("mutes persist across instances", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shv-mutes-")), "sub", "muted.json");
  const a = new Mutes(f);
  const b = new Mutes(f);
  assert.equal(a.has("t1"), false);
  a.set("t1", true);
  assert.equal(b.has("t1"), true);
  b.set("t1", false);
  assert.equal(a.has("t1"), false);
});

test("preview", () => {
  assert.equal(preview({ id: 1, thread: "t", author: "a", ts: 1, body: " hi\n there " }), "hi there");
  assert.equal(preview({ id: 1, thread: "t", author: "a", ts: 1, body: "x", deleted: true }), "(deleted)");
  assert.equal(preview({ id: 1, thread: "t", author: "a", ts: 1, body: "look", attachments: [{ index: 0, state: "done", filename: "a.png" }] }), "[a.png] look");
});

test("rendering escapes everything from the network", () => {
  const evil = `<img src=x onerror=alert(1)> "quoted" 'single' & more`;
  assert.ok(!esc(evil).includes("<"));
  const html = renderMessage({
    id: 1, thread: "t", author: "a\"><script>", authorName: "<b>Mallory</b>", ts: Date.now(), body: evil,
    quote: { author: "b", ts: 1, text: "<script>x</script>" }, quoteName: "<i>Q</i>",
    attachments: [{ index: 0, state: "done", filename: "<x>.png", contentType: "image/png", path: "/p" }],
    attachmentUris: ["https://file+.vscode-resource/p\"onload=\"x"],
    reactions: [{ reactor: "r", emoji: "<3" }], reactionNames: ["<Eve>"],
  }, { group: true, showAuthor: true });
  for (const bad of ["<script", "<img src=x", "<b>Mallory", "<i>Q", "<x>.png", "<Eve>", '"onload="']) {
    assert.ok(!html.includes(bad), `unescaped ${bad}`);
  }
});

test("linkify only links http(s) and escapes", () => {
  assert.equal(linkify("see https://a.example/x?y=1&z=2."), 'see <a href="https://a.example/x?y=1&amp;z=2" data-link="https://a.example/x?y=1&amp;z=2">https://a.example/x?y=1&amp;z=2</a>.');
  assert.equal(linkify("javascript:alert(1) <b>"), "javascript:alert(1) &lt;b&gt;");
  assert.ok(!linkify('https://x.example/"onmouseover="alert(1)').includes('"onmouseover'));
});

test("outgoing status rendering", () => {
  const html = renderMessage({ id: 2, thread: "t", author: "me", ts: Date.now(), body: "hi", outgoing: true, status: "failed" }, { group: false, showAuthor: false });
  assert.match(html, /class="msg out"/);
  assert.match(html, /status failed/);
});

test("link preview cards: escaped, http(s) only, image from the attachment", () => {
  const base = { id: 3, thread: "t", author: "a", ts: Date.now(), body: "x https://tea.example/<b>" };
  const html = renderMessage({
    ...base,
    attachments: [{ index: 0, state: "done", kind: "preview", path: "/p/img" }],
    attachmentUris: ["https://file+.vscode-resource/p/img"],
    previews: [{ url: "https://www.tea.example/<b>", title: "<script>t</script>", description: "\"quoted\" & <i>", image: 0 }],
  }, { group: false, showAuthor: false });
  assert.match(html, /class="lp"/);
  assert.match(html, /<span class="lp-host">tea\.example<\/span>/);
  assert.match(html, /<img class="lp-img" src="https:\/\/file\+\.vscode-resource\/p\/img"/);
  assert.ok(!html.includes("<script>") && !html.includes("<i>"), "escaped");
  assert.ok(!html.includes('class="atts"'), "preview image is not listed as a file");
  const bad = renderMessage({ ...base, previews: [{ url: "javascript:alert(1)", title: "x", image: -1 }] }, { group: false, showAuthor: false });
  assert.ok(!bad.includes("lp"), "non-http preview dropped");
});

test("search snippets center on the match and mark every occurrence", () => {
  const long = "a ".repeat(100) + "the Tea party had tea, TEA and more " + "b ".repeat(100);
  const { text, highlights } = snippet(long, "tea");
  assert.ok(text.startsWith("…") && text.endsWith("…"));
  assert.ok(text.length <= 82);
  assert.equal(highlights.length, 3);
  for (const [a, b] of highlights) {
    assert.equal(text.slice(a, b).toLowerCase(), "tea");
  }
  assert.deepEqual(snippet("short\nline", "zzz"), { text: "short line", highlights: [] });
});

test("data dir mirrors the daemon's per-OS default", () => {
  const home = os.homedir();
  assert.equal(dataDir({}, "linux"), path.join(home, ".local", "share", "signal-headless"));
  assert.equal(dataDir({}, "darwin"), path.join(home, "Library", "Application Support", "signal-headless"));
  assert.equal(dataDir({ LOCALAPPDATA: "/lad" }, "win32"), path.join("/lad", "signal-headless"));
  assert.equal(dataDir({ SIGNAL_HEADLESS_DATA: "/custom" }, "darwin"), "/custom");
});
