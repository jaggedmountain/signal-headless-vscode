// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure HTML rendering for the chat webview (tested in Node).
import type { ViewMessage } from "../src/protocol";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const urlRe = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

// linkify escapes text and turns URLs into links.
export function linkify(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(urlRe)) {
    out += esc(text.slice(last, m.index));
    out += `<a href="${esc(m[0])}" data-link="${esc(m[0])}">${esc(m[0])}</a>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

export function time(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) {
    return "Today";
  }
  if (diff === 1) {
    return "Yesterday";
  }
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) {
    opts.year = "numeric";
  }
  return d.toLocaleDateString(undefined, opts);
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function size(n?: number): string {
  if (!n) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const statusIcon: Record<string, [string, string]> = {
  sending: ["◌", "Sending"],
  sent: ["✓", "Sent"],
  delivered: ["✓✓", "Delivered"],
  read: ["✓✓", "Read"],
  failed: ["⚠ failed", "Not sent"],
};

export function renderMessage(m: ViewMessage, opts: { group: boolean; showAuthor: boolean }): string {
  const cls = ["msg", m.outgoing ? "out" : "in"];
  if (m.deleted) {
    cls.push("deleted");
  }
  let meta = "";
  if (!m.outgoing && opts.group && opts.showAuthor) {
    meta = `<span class="author" style="--hue:${authorHue(m.author)}">${esc(m.authorName || m.author.slice(0, 8))}</span>`;
  }
  let inner = "";
  if (m.deleted) {
    inner = `<div class="body muted">This message was deleted.</div>`;
  } else {
    if (m.quote) {
      inner += `<div class="quote" data-quote-ts="${m.quote.ts}"><span class="qauthor">${esc(m.quoteName || "")}</span>${esc(m.quote.text || "")}</div>`;
    }
    const atts = m.attachments ?? [];
    if (atts.some((a) => a.kind !== "preview")) {
      inner += `<div class="atts">`;
      atts.forEach((a, i) => {
        if (a.kind !== "preview") {
          inner += renderAttachment(m, i);
        }
      });
      inner += `</div>`;
    }
    if (m.sticker && !m.body) {
      inner += `<div class="body sticker">${esc(m.sticker)}</div>`;
    }
    if (m.body) {
      inner += `<div class="body">${linkify(m.body)}</div>`;
    }
    for (const p of m.previews ?? []) {
      inner += renderPreview(m, p);
    }
  }
  const foot: string[] = [];
  if (m.expiresIn) {
    foot.push(`<span title="Disappearing message">⏱</span>`);
  }
  if (m.editedAt && !m.deleted) {
    foot.push(`<span>edited</span>`);
  }
  foot.push(`<span class="time" title="${esc(new Date(m.ts).toLocaleString())}">${time(m.ts)}</span>`);
  if (m.outgoing && m.status) {
    const [icon, title] = statusIcon[m.status] ?? ["", m.status];
    foot.push(`<span class="status ${esc(m.status)}" title="${esc(title)}">${esc(icon)}</span>`);
  }
  let reacts = "";
  if (m.reactions && m.reactions.length > 0 && !m.deleted) {
    const byEmoji = new Map<string, string[]>();
    m.reactions.forEach((r, i) => {
      const names = byEmoji.get(r.emoji) ?? [];
      names.push(m.reactionNames?.[i] ?? r.reactor.slice(0, 8));
      byEmoji.set(r.emoji, names);
    });
    reacts = `<div class="reacts">` + [...byEmoji].map(([e, names]) =>
      `<span class="react" title="${esc(names.join(", "))}">${esc(e)}${names.length > 1 ? `<small>${names.length}</small>` : ""}</span>`).join("") + `</div>`;
  }
  return `<div class="${cls.join(" ")}" data-id="${m.id}" data-ts="${m.ts}" tabindex="-1">` +
    (meta ? `<div class="meta">${meta}</div>` : "") +
    `<div class="bubble">${inner}<div class="foot">${foot.join(" ")}</div></div>${reacts}</div>`;
}

function renderAttachment(m: ViewMessage, i: number): string {
  const a = m.attachments![i];
  const uri = m.attachmentUris?.[i] ?? null;
  const name = a.filename || (a.voiceNote ? "voice note" : a.contentType || "attachment");
  const ct = a.contentType ?? "";
  const data = `data-id="${m.id}" data-index="${i}"`;
  if (a.state === "pending") {
    return `<div class="att pending">⤓ ${esc(name)} <span class="muted">${esc(size(a.size))} downloading…</span></div>`;
  }
  if (a.state === "failed") {
    return `<div class="att failed">⚠ ${esc(name)} <span class="muted">${esc(a.error || "download failed")}</span> <button class="retry" data-retry="${m.id}">Retry</button></div>`;
  }
  if (uri && ct.startsWith("image/")) {
    return `<img class="att image" src="${esc(uri)}" alt="${esc(name)}" title="${esc(name)} — click to open" ${data}>`;
  }
  if (uri && (ct.startsWith("audio/") || a.voiceNote)) {
    return `<div class="att"><audio controls preload="none" src="${esc(uri)}"></audio> <a href="#" class="open" ${data}>${esc(name)}</a></div>`;
  }
  if (uri && ct.startsWith("video/")) {
    return `<div class="att"><video controls preload="metadata" src="${esc(uri)}"></video><a href="#" class="open" ${data}>${esc(name)}</a></div>`;
  }
  return `<div class="att file"><a href="#" class="open" ${data}>📄 ${esc(name)}</a> <span class="muted">${esc(size(a.size))}</span></div>`;
}

// renderPreview draws a link-preview card from what the sender attached.
function renderPreview(m: ViewMessage, p: NonNullable<ViewMessage["previews"]>[number]): string {
  let host = "";
  try {
    const u = new URL(p.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return "";
    }
    host = u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
  const a = p.image >= 0 ? m.attachments?.[p.image] : undefined;
  const uri = p.image >= 0 ? m.attachmentUris?.[p.image] ?? null : null;
  const img = a && a.state === "done" && uri ? `<img class="lp-img" src="${esc(uri)}" alt="">` : "";
  return `<a class="lp" href="${esc(p.url)}" data-link="${esc(p.url)}" title="${esc(p.url)}">${img}<span class="lp-text">` +
    (p.title ? `<span class="lp-title">${esc(p.title)}</span>` : "") +
    (p.description ? `<span class="lp-desc">${esc(p.description)}</span>` : "") +
    `<span class="lp-host">${esc(host)}</span></span></a>`;
}

// authorHue gives each group member a stable color (lightness is themed in CSS).
export function authorHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
