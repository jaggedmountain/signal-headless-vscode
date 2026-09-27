// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// :shortcode: → emoji for outgoing text, matching the TUI: a code must be
// delimited by non-alphanumerics, unknown codes and times like 12:30:45 stay.
import * as nodeEmoji from "node-emoji";

const codeRe = /:([a-zA-Z0-9_+\-]+):/g;

export function emojize(s: string): string {
  if (!s.includes(":")) {
    return s;
  }
  let out = "";
  let last = 0;
  let pos = 0;
  while (pos < s.length) {
    codeRe.lastIndex = pos;
    const m = codeRe.exec(s);
    if (!m) {
      break;
    }
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? s[start - 1] : "";
    const after = end < s.length ? s[end] : "";
    const e = lookup(m[1]);
    if (e && !isAlnum(before) && !isAlnum(after)) {
      out += s.slice(last, start) + e;
      last = end;
      pos = end;
    } else {
      // Let the closing colon open the next candidate (":x::joy:").
      pos = start + 1;
    }
  }
  return out + s.slice(last);
}

function lookup(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/^\d+$/.test(n)) {
    return undefined; // "12:30:45"
  }
  return nodeEmoji.get(n) ?? nodeEmoji.get(aliases[n] ?? "");
}

const aliases: Record<string, string> = {
  thumbsup: "+1",
  thumbs_up: "+1",
  thumbsdown: "-1",
  thumbs_down: "-1",
};

function isAlnum(c: string): boolean {
  return c !== "" && /[\p{L}\p{N}]/u.test(c);
}

// Emoji completion for the chat panel: names starting with prefix.
export function searchEmoji(prefix: string, limit = 8): { name: string; emoji: string }[] {
  const p = prefix.toLowerCase();
  if (p === "") {
    return [];
  }
  const exact = nodeEmoji.search(p).filter((r) => r.name.startsWith(p));
  const rest = nodeEmoji.search(p).filter((r) => !r.name.startsWith(p));
  return [...exact, ...rest].slice(0, limit);
}
