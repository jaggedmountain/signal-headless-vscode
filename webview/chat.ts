// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// The chat panel's webview script: renders one conversation and the compose
// box, and forwards user actions to the extension host.
import type { HostToView, Staged, ViewMessage, ViewThread, ViewToHost } from "../src/protocol";
import { searchEmoji } from "../src/emoji";
import { dayKey, dayLabel, esc, renderMessage } from "./render";

interface VSCodeApi {
  postMessage(msg: ViewToHost): void;
  getState(): SavedState | undefined;
  setState(s: SavedState): void;
}
interface SavedState {
  thread?: string; // lets VS Code restore the panel after a reload
  draft: string;
  reply?: { author: string; ts: number; text?: string; name: string };
}
declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();
const post = (m: ViewToHost) => vscode.postMessage(m);

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLDivElement>("log");
const banner = $<HTMLDivElement>("banner");
const info = $<HTMLDivElement>("info");
const typingEl = $<HTMLDivElement>("typing");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const attachBtn = $<HTMLButtonElement>("attach");
const replying = $<HTMLDivElement>("replying");
const draftPreviewEl = $<HTMLDivElement>("draftPreview");
const stagedEl = $<HTMLDivElement>("staged");
const hint = $<HTMLDivElement>("hint");
const emojiPop = $<HTMLDivElement>("emojipop");
const reactPop = $<HTMLDivElement>("reactpop");

let me = "";
let thread: ViewThread | undefined;
let msgs: ViewMessage[] = [];
let hasMore = false;
let loadingOlder = false;
let selected: number | null = null; // message id
let reply: SavedState["reply"];
const replies = new Map<string, SavedState["reply"]>(); // per conversation, in single-panel mode
let staged: Staged[] = [];
let enterSends = true;
let stick = true; // keep the view pinned to the newest message
const typers = new Map<string, { name: string; timer: number }>();
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));

// ---- state ------------------------------------------------------------

const saved = vscode.getState();
if (saved) {
  input.value = saved.draft ?? "";
  reply = saved.reply;
}

function save(): void {
  vscode.setState({ thread: thread?.id ?? saved?.thread, draft: input.value, reply });
}

let draftTimer = 0;
function draftChanged(): void {
  save();
  clearTimeout(draftTimer);
  const t = thread?.id;
  draftTimer = window.setTimeout(() => post({ type: "draft", text: input.value, thread: t }), 400);
}

function upsert(list: ViewMessage[]): void {
  for (const m of list) {
    const i = msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      msgs[i] = m;
    } else {
      msgs.push(m);
    }
  }
  msgs.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

// ---- rendering ----------------------------------------------------------

function render(): void {
  const atBottom = stick;
  const fromBottom = log.scrollHeight - log.scrollTop;
  const group = thread?.kind === "group";
  let html = "";
  if (hasMore) {
    html += `<div class="older">${loadingOlder ? "Loading…" : "Scroll up for older messages"}</div>`;
  } else if (msgs.length === 0) {
    html += `<div class="older">No messages yet. Messages sent before this device was linked are not available.</div>`;
  }
  let prevDay = "";
  let prev: ViewMessage | undefined;
  for (const m of msgs) {
    const dk = dayKey(m.ts);
    let newDay = false;
    if (dk !== prevDay) {
      html += `<div class="day"><span>${esc(dayLabel(m.ts))}</span></div>`;
      prevDay = dk;
      newDay = true;
    }
    const first = newDay || !prev || prev.author !== m.author || m.ts - prev.ts > 5 * 60_000;
    let el = renderMessage(m, { group, showAuthor: first });
    el = el.replace('class="msg ', `class="msg ${first ? "first " : ""}${m.id === selected ? "selected " : ""}`);
    el = el.replace(/<\/div>$/, actions(m) + "</div>");
    html += el;
    prev = m;
  }
  log.innerHTML = html;
  if (atBottom) {
    scrollToBottom();
  } else {
    log.scrollTop = log.scrollHeight - fromBottom;
  }
}

function actions(m: ViewMessage): string {
  if (m.deleted) {
    return "";
  }
  let b = `<div class="actions">`;
  b += `<button data-act="reply" title="Reply (r)">↩</button>`;
  b += `<button data-act="react" title="React (e)">☺</button>`;
  if (m.body) {
    b += `<button data-act="copy" title="Copy text (y)">⧉</button>`;
  }
  if ((m.attachments ?? []).some((a) => a.state === "done" && a.kind !== "preview")) {
    b += `<button data-act="open" title="Open attachment (o)">↗</button>`;
  }
  if (m.outgoing && m.status === "failed") {
    b += `<button data-act="resend" title="Send again">⟳</button>`;
  }
  if (m.outgoing && m.author === me) {
    b += `<button data-act="delete" title="Delete for everyone (D)">🗑</button>`;
  }
  return b + `</div>`;
}

function scrollToBottom(): void {
  log.scrollTop = log.scrollHeight;
}

function renderReply(): void {
  if (!reply) {
    replying.hidden = true;
    replying.innerHTML = "";
    return;
  }
  replying.hidden = false;
  replying.innerHTML = `<div class="text"><b>Replying to ${esc(reply.name)}</b><br>${esc(reply.text || "")}</div>` +
    `<button class="x" id="cancelReply" title="Cancel reply (Esc)">×</button>`;
}

function renderStaged(): void {
  stagedEl.innerHTML = staged.map((f, i) =>
    `<span class="chip" title="${esc(f.path)}">📎 ${esc(f.name)}<button class="x" data-detach="${i}" title="Remove">×</button></span>`).join("");
}

function renderTyping(): void {
  const names = [...typers.values()].map((t) => t.name);
  typingEl.textContent = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : `${names.join(", ")} are typing…`;
}

function renderInfo(): void {
  if (!thread) {
    return;
  }
  const bits: string[] = [];
  if (thread.expireTimer) {
    bits.push(`⏱ Disappearing messages: ${duration(thread.expireTimer)}`);
  }
  info.textContent = bits.join(" · ");
  input.placeholder = `Message ${thread.title}`;
}

function renderHint(): void {
  hint.textContent = enterSends
    ? "Enter to send · Shift+Enter for a new line · :shortcode: for emoji · Esc for message keys (j/k, r, e, o, y, D, / search)"
    : "Ctrl+Enter to send · :shortcode: for emoji · Esc for message keys (j/k, r, e, o, y, D, / search)";
}

function duration(s: number): string {
  if (s % 86400 === 0) {
    return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  }
  if (s % 3600 === 0) {
    return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  }
  if (s % 60 === 0) {
    return `${s / 60} minute${s === 60 ? "" : "s"}`;
  }
  return `${s} seconds`;
}

// ---- selection & message actions ---------------------------------------

function byId(id: number | null): ViewMessage | undefined {
  return id === null ? undefined : msgs.find((m) => m.id === id);
}

function select(id: number | null, scroll = true): void {
  selected = id;
  for (const el of log.querySelectorAll(".msg.selected")) {
    el.classList.remove("selected");
  }
  if (id === null) {
    return;
  }
  const el = log.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
  if (el) {
    el.classList.add("selected");
    if (scroll) {
      el.scrollIntoView({ block: "nearest" });
    }
  }
}

function moveSel(delta: number): void {
  if (msgs.length === 0) {
    return;
  }
  let i = msgs.findIndex((m) => m.id === selected);
  if (i < 0) {
    i = msgs.length - 1; // the first move selects the newest message
  } else {
    i = Math.max(0, Math.min(msgs.length - 1, i + delta));
  }
  select(msgs[i].id);
  if (i === 0 && hasMore) {
    loadOlder();
  }
}

function startReply(m: ViewMessage): void {
  reply = { author: m.author, ts: m.ts, text: m.body || previewText(m), name: m.outgoing ? "yourself" : m.authorName || "them" };
  renderReply();
  save();
  input.focus();
}

function previewText(m: ViewMessage): string {
  const a = (m.attachments ?? []).filter((x) => x.kind !== "preview");
  if (a.length > 0) {
    return a.length > 1 ? `[${a.length} attachments]` : `[${a[0].filename || "attachment"}]`;
  }
  return m.sticker ? `[sticker ${m.sticker}]` : "";
}

function react(m: ViewMessage, emoji: string): void {
  const mine = (m.reactions ?? []).find((r) => r.reactor === me);
  const remove = emoji === "" || (mine !== undefined && mine.emoji === emoji);
  post({ type: "react", author: m.author, ts: m.ts, emoji: remove ? mine?.emoji ?? "" : emoji, remove });
}

function openAttachments(m: ViewMessage): void {
  (m.attachments ?? []).forEach((a, i) => {
    if (a.state === "done" && a.kind !== "preview") {
      post({ type: "open", id: m.id, index: i });
    }
  });
}

function act(m: ViewMessage, what: string, anchor?: HTMLElement): void {
  select(m.id, false);
  switch (what) {
    case "reply":
      startReply(m);
      break;
    case "react":
      showReactPop(m, anchor);
      break;
    case "copy":
      post({ type: "copy", text: m.body });
      break;
    case "open":
      openAttachments(m);
      break;
    case "delete":
      post({ type: "delete", ts: m.ts });
      break;
    case "resend":
      post({ type: "resend", id: m.id });
      break;
  }
}

// ---- reaction popup -----------------------------------------------------

let reactTarget: ViewMessage | undefined;

function showReactPop(m: ViewMessage, anchor?: HTMLElement): void {
  reactTarget = m;
  const mine = (m.reactions ?? []).find((r) => r.reactor === me)?.emoji;
  reactPop.innerHTML = QUICK.map((e, i) =>
    `<button data-emoji="${esc(e)}" title="${i + 1}${e === mine ? " (remove)" : ""}"${e === mine ? ' style="outline:1px solid var(--vscode-focusBorder)"' : ""}>${e}</button>`).join("") +
    `<input id="reactInput" placeholder=":name: or emoji" title="Enter to react; empty removes your reaction">`;
  const target = anchor ?? log.querySelector<HTMLElement>(`.msg[data-id="${m.id}"] .bubble`) ?? log;
  const r = target.getBoundingClientRect();
  reactPop.hidden = false;
  const w = reactPop.offsetWidth;
  const h = reactPop.offsetHeight;
  reactPop.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left))}px`;
  reactPop.style.top = `${r.top - h - 4 < 4 ? r.bottom + 4 : r.top - h - 4}px`;
  (reactPop.querySelector("button") as HTMLButtonElement).focus();
}

function hideReactPop(refocus = true): void {
  if (reactPop.hidden) {
    return;
  }
  reactPop.hidden = true;
  reactTarget = undefined;
  if (refocus) {
    log.focus();
  }
}

reactPop.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-emoji]");
  if (b && reactTarget) {
    react(reactTarget, b.dataset.emoji!);
    hideReactPop();
  }
});
reactPop.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.key === "Escape") {
    e.preventDefault();
    hideReactPop();
  } else if (t.id === "reactInput" && e.key === "Enter") {
    e.preventDefault();
    if (reactTarget) {
      const v = (t as HTMLInputElement).value.trim();
      const mine = (reactTarget.reactions ?? []).find((r) => r.reactor === me);
      if (v !== "" || mine) {
        post({ type: "react", author: reactTarget.author, ts: reactTarget.ts, emoji: v === "" ? mine!.emoji : v, remove: v === "" });
      }
    }
    hideReactPop();
  } else if (t.tagName === "BUTTON" && /^[1-6]$/.test(e.key)) {
    e.preventDefault();
    if (reactTarget) {
      react(reactTarget, QUICK[Number(e.key) - 1]);
    }
    hideReactPop();
  } else if (t.tagName === "BUTTON" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    const items = [...reactPop.querySelectorAll<HTMLElement>("button, input")];
    const i = items.indexOf(t);
    items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener("mousedown", (e) => {
  if (!reactPop.hidden && !reactPop.contains(e.target as Node)) {
    hideReactPop(false);
  }
  if (!emojiPop.hidden && !emojiPop.contains(e.target as Node)) {
    hideEmojiPop();
  }
});

// ---- emoji completion in the compose box -------------------------------

let emojiItems: { name: string; emoji: string }[] = [];
let emojiActive = 0;

function emojiToken(): { start: number; prefix: string } | undefined {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) {
    return undefined;
  }
  const m = /(^|[\s(]):([a-z0-9_+\-]{2,})$/i.exec(input.value.slice(0, pos));
  if (!m) {
    return undefined;
  }
  return { start: pos - m[2].length - 1, prefix: m[2] };
}

function updateEmojiPop(): void {
  const tok = emojiToken();
  emojiItems = tok ? searchEmoji(tok.prefix, 8) : [];
  if (emojiItems.length === 0) {
    hideEmojiPop();
    return;
  }
  emojiActive = 0;
  drawEmojiPop();
  emojiPop.hidden = false;
  const r = input.getBoundingClientRect();
  emojiPop.style.left = `${r.left}px`;
  emojiPop.style.top = `${r.top - emojiPop.offsetHeight - 4}px`;
}

function drawEmojiPop(): void {
  emojiPop.innerHTML = emojiItems.map((it, i) =>
    `<div class="item${i === emojiActive ? " active" : ""}" data-i="${i}">${it.emoji} :${esc(it.name)}:</div>`).join("");
}

function hideEmojiPop(): void {
  emojiPop.hidden = true;
  emojiItems = [];
}

function acceptEmoji(i: number): void {
  const tok = emojiToken();
  const it = emojiItems[i];
  if (!tok || !it) {
    hideEmojiPop();
    return;
  }
  const end = input.selectionStart;
  input.setRangeText(it.emoji, tok.start, end, "end");
  hideEmojiPop();
  autosize();
  draftChanged();
}

emojiPop.addEventListener("mousedown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".item");
  if (el) {
    e.preventDefault();
    acceptEmoji(Number(el.dataset.i));
    input.focus();
  }
});

// ---- link preview for the draft ------------------------------------------

const draftUrlRe = /https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/;
let previewUrl = ""; // link the card is for ("" when none)
let previewShown = false; // a card (not just "loading") is showing
let dismissedUrl = "";
let previewTimer = 0;

function checkDraftLink(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    const url = draftUrlRe.exec(input.value)?.[0] ?? "";
    if (url === previewUrl) {
      return;
    }
    previewUrl = "";
    previewShown = false;
    draftPreviewEl.hidden = true;
    if (url !== "" && url !== dismissedUrl) {
      previewUrl = url;
      draftPreviewEl.innerHTML = `<span class="muted">Fetching preview…</span>`;
      draftPreviewEl.hidden = false;
      post({ type: "wantPreview", url });
    }
  }, 900);
}

function clearDraftPreview(): void {
  clearTimeout(previewTimer);
  previewUrl = "";
  previewShown = false;
  dismissedUrl = "";
  draftPreviewEl.hidden = true;
  draftPreviewEl.innerHTML = "";
}

function showDraftPreview(url: string, p: { title?: string; description?: string; host: string; imageUri?: string } | null): void {
  if (url !== previewUrl) {
    return; // the draft moved on
  }
  if (!p) {
    previewShown = false;
    draftPreviewEl.hidden = true;
    return;
  }
  previewShown = true;
  draftPreviewEl.innerHTML = `<div class="lp draft">` +
    (p.imageUri ? `<img class="lp-img" src="${esc(p.imageUri)}" alt="">` : "") +
    `<span class="lp-text">` + (p.title ? `<span class="lp-title">${esc(p.title)}</span>` : "") +
    (p.description ? `<span class="lp-desc">${esc(p.description)}</span>` : "") +
    `<span class="lp-host">${esc(p.host)}</span></span>` +
    `<button class="x" id="dropPreview" title="Send without a preview">×</button></div>`;
  draftPreviewEl.hidden = false;
}

draftPreviewEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "dropPreview") {
    dismissedUrl = previewUrl;
    previewUrl = "";
    previewShown = false;
    draftPreviewEl.hidden = true;
    input.focus();
  }
});

// ---- compose -----------------------------------------------------------

function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

let typingSent = false;
let typingTimer = 0;
function typing(active: boolean): void {
  clearTimeout(typingTimer);
  if (active) {
    if (!typingSent) {
      typingSent = true;
      post({ type: "typing", typing: true });
    }
    typingTimer = window.setTimeout(() => typing(false), 5000);
  } else if (typingSent) {
    typingSent = false;
    post({ type: "typing", typing: false });
  }
}

function send(): void {
  const body = input.value;
  if (body.trim() === "" && staged.length === 0) {
    return;
  }
  const preview = previewShown && previewUrl !== "" && body.includes(previewUrl) ? previewUrl : undefined;
  post({ type: "send", body, quote: reply ? { author: reply.author, ts: reply.ts, text: reply.text } : undefined, preview });
  clearDraftPreview();
  typing(false);
  input.value = "";
  reply = undefined;
  renderReply();
  autosize();
  draftChanged();
  stick = true;
  scrollToBottom();
}

input.addEventListener("input", () => {
  autosize();
  draftChanged();
  updateEmojiPop();
  checkDraftLink();
  typing(input.value !== "");
});

input.addEventListener("keydown", (e) => {
  if (!emojiPop.hidden && emojiItems.length > 0) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      emojiActive = (emojiActive + (e.key === "ArrowDown" ? 1 : emojiItems.length - 1)) % emojiItems.length;
      drawEmojiPop();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      acceptEmoji(emojiActive);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideEmojiPop();
      return;
    }
  }
  if (e.key === "Enter") {
    const sendKey = enterSends ? !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey : e.ctrlKey || e.metaKey;
    if (sendKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (reply) {
      reply = undefined;
      renderReply();
      save();
    } else {
      log.focus();
      if (selected === null) {
        moveSel(-1);
      }
    }
    return;
  }
  if (e.key === "ArrowUp" && input.value === "") {
    e.preventDefault();
    log.focus();
    moveSel(-1);
  }
});

input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length > 0) {
    e.preventDefault();
    for (const f of files) {
      void attachFile(f, f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.${(f.type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "")}`);
    }
  }
});

async function attachFile(f: File, name = f.name): Promise<void> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  post({ type: "attachData", name, data: btoa(bin) });
}

sendBtn.addEventListener("click", () => {
  send();
  input.focus();
});
attachBtn.addEventListener("click", () => post({ type: "attach" }));
replying.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "cancelReply") {
    reply = undefined;
    renderReply();
    save();
    input.focus();
  }
});
stagedEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-detach]");
  if (b) {
    post({ type: "detach", index: Number(b.dataset.detach) });
  }
});

// Files dragged in (VS Code needs Shift held while dropping onto a webview).
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  for (const f of e.dataTransfer?.files ?? []) {
    void attachFile(f);
  }
});

// ---- the message log ---------------------------------------------------

function loadOlder(): void {
  if (!hasMore || loadingOlder || msgs.length === 0) {
    return;
  }
  loadingOlder = true;
  const el = log.querySelector(".older");
  if (el) {
    el.textContent = "Loading…";
  }
  post({ type: "loadOlder", before: msgs[0].ts });
}

log.addEventListener("scroll", () => {
  stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (log.scrollTop < 150) {
    loadOlder();
  }
});

// Images change height as they load; keep the bottom pinned.
log.addEventListener("load", () => {
  if (stick) {
    scrollToBottom();
  }
}, true);

log.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const msgEl = t.closest<HTMLElement>(".msg");
  const m = msgEl ? byId(Number(msgEl.dataset.id)) : undefined;
  const link = t.closest<HTMLAnchorElement>("a[data-link]");
  if (link) {
    e.preventDefault();
    post({ type: "openLink", url: link.dataset.link! });
    return;
  }
  const act_ = t.closest<HTMLElement>("[data-act]");
  if (act_ && m) {
    e.preventDefault();
    act(m, act_.dataset.act!, act_);
    return;
  }
  const retry = t.closest<HTMLElement>("[data-retry]");
  if (retry) {
    post({ type: "retry", id: Number(retry.dataset.retry) });
    return;
  }
  const open = t.closest<HTMLElement>("[data-index]");
  if (open && (open.tagName === "IMG" || open.tagName === "A")) {
    e.preventDefault();
    post({ type: "open", id: Number(open.dataset.id), index: Number(open.dataset.index) });
    return;
  }
  const quote = t.closest<HTMLElement>("[data-quote-ts]");
  if (quote) {
    const target = msgs.find((x) => x.ts === Number(quote.dataset.quoteTs));
    if (target) {
      select(target.id);
      log.querySelector(`.msg[data-id="${target.id}"]`)?.scrollIntoView({ block: "center" });
    }
    return;
  }
  if (m && window.getSelection()?.isCollapsed) {
    select(m.id === selected ? null : m.id, false);
  }
});

log.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  const m = byId(selected);
  switch (e.key) {
    case "j":
    case "ArrowDown":
      moveSel(1);
      break;
    case "k":
    case "ArrowUp":
      moveSel(-1);
      break;
    case "g":
    case "Home":
      if (msgs.length) {
        select(msgs[0].id);
      }
      loadOlder();
      break;
    case "G":
    case "End":
      select(null);
      stick = true;
      scrollToBottom();
      break;
    case "PageUp":
    case "PageDown":
      return; // native scrolling
    case "r":
      if (m && !m.deleted) {
        startReply(m);
      }
      break;
    case "e":
    case "+":
      if (m && !m.deleted) {
        showReactPop(m);
      }
      break;
    case "1": case "2": case "3": case "4": case "5": case "6":
      if (m && !m.deleted) {
        react(m, QUICK[Number(e.key) - 1]);
      }
      break;
    case "y":
      if (m?.body) {
        post({ type: "copy", text: m.body });
      }
      break;
    case "o":
      if (m) {
        openAttachments(m);
      }
      break;
    case "R":
      if (m && (m.attachments ?? []).some((a) => a.state === "failed")) {
        post({ type: "retry", id: m.id });
      }
      break;
    case "D":
    case "Delete":
      if (m && m.outgoing && !m.deleted) {
        post({ type: "delete", ts: m.ts });
      }
      break;
    case "a":
      post({ type: "attach" });
      break;
    case "/":
      post({ type: "search" });
      break;
    case "Escape":
      select(null);
      input.focus();
      break;
    case "i":
    case "c":
    case "Enter":
      input.focus();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---- host messages -----------------------------------------------------

window.addEventListener("message", (ev: MessageEvent<HostToView>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      const switching = thread !== undefined && thread.id !== msg.thread.id;
      if (switching) {
        // Single-panel mode moved to another conversation: keep this one's
        // draft and reply for when it comes back.
        clearTimeout(draftTimer);
        post({ type: "draft", text: input.value, thread: thread!.id });
        replies.set(thread!.id, reply);
        reply = replies.get(msg.thread.id);
        typing(false);
        clearDraftPreview();
        hideEmojiPop();
        hideReactPop(false);
        typers.clear();
        renderTyping();
        selected = null;
        loadingOlder = false;
      }
      me = msg.me;
      thread = msg.thread;
      msgs = [];
      upsert(msg.messages);
      hasMore = msg.hasMore;
      enterSends = msg.enterSends;
      if (switching) {
        input.value = msg.draft;
      } else if (input.value === "" && msg.draft) {
        input.value = msg.draft;
      }
      checkDraftLink();
      banner.textContent = msg.connection;
      save();
      stick = true;
      render();
      renderInfo();
      renderReply();
      renderHint();
      autosize();
      break;
    }
    case "older":
      loadingOlder = false;
      hasMore = msg.hasMore;
      upsert(msg.messages);
      render();
      break;
    case "upsert": {
      upsert(msg.messages);
      render();
      if (selected !== null) {
        select(selected, false);
      }
      for (const m of msg.messages) {
        const t = typers.get(m.author);
        if (t && !m.outgoing) {
          clearTimeout(t.timer);
          typers.delete(m.author);
          renderTyping();
        }
      }
      break;
    }
    case "remove": {
      const i = msgs.findIndex((x) => x.id === msg.id);
      if (i >= 0) {
        msgs.splice(i, 1);
        if (selected === msg.id) {
          selected = null;
        }
        render();
      }
      break;
    }
    case "thread":
      thread = msg.thread;
      renderInfo();
      break;
    case "typing": {
      const old = typers.get(msg.sender);
      if (old) {
        clearTimeout(old.timer);
      }
      if (msg.typing) {
        typers.set(msg.sender, { name: msg.name, timer: window.setTimeout(() => {
          typers.delete(msg.sender);
          renderTyping();
        }, 15_000) });
      } else {
        typers.delete(msg.sender);
      }
      renderTyping();
      break;
    }
    case "connection":
      banner.textContent = msg.text;
      break;
    case "staged":
      staged = msg.files;
      renderStaged();
      break;
    case "draft":
      input.value = msg.append && input.value !== "" ? `${input.value}\n${msg.text}` : msg.text;
      autosize();
      draftChanged();
      input.focus();
      break;
    case "sendFailed":
      if (input.value === "") {
        input.value = msg.body;
        autosize();
        draftChanged();
      }
      break;
    case "reveal": {
      const target = msgs.find((x) => x.ts === msg.ts);
      if (target) {
        stick = false;
        select(target.id);
        log.querySelector(`.msg[data-id="${target.id}"]`)?.scrollIntoView({ block: "center" });
        log.focus();
      }
      break;
    }
    case "focus":
      input.focus();
      break;
    case "draftPreview":
      showDraftPreview(msg.url, msg.preview);
      break;
    case "probeInput":
      input.value = msg.text;
      input.dispatchEvent(new Event("input"));
      break;
    case "probeSend":
      send();
      break;
    case "probe":
      post({
        type: "probe", messages: log.querySelectorAll(".msg").length, text: log.innerText, errors,
        hiddenButShown: [...document.querySelectorAll<HTMLElement>("[hidden]")].filter((el) => getComputedStyle(el).display !== "none").map((el) => el.id || el.className),
        openPopups: [...document.querySelectorAll<HTMLElement>(".popup")].filter((el) => getComputedStyle(el).display !== "none").map((el) => el.id),
        composer: document.getElementById("composer")!.innerText,
        input: input.value,
      });
      break;
    case "probeReact":
      if (msgs.length > 0) {
        showReactPop(msgs[msgs.length - 1]);
      }
      break;
    case "probePick":
      reactPop.querySelector<HTMLButtonElement>("button[data-emoji]")?.click();
      break;
  }
});

window.addEventListener("focus", () => post({ type: "markRead" }));
window.addEventListener("resize", () => {
  if (stick) {
    scrollToBottom();
  }
});

renderReply();
renderHint();
post({ type: "ready" });
