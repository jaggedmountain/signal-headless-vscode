// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Search-result excerpts (no vscode imports: unit-tested in Node).

// snippet cuts a one-line excerpt around the first match and returns the
// match ranges within it.
export function snippet(body: string, query: string, width = 80): { text: string; highlights: [number, number][] } {
  const flat = body.replace(/\s+/g, " ").trim();
  const q = query.toLowerCase();
  const lower = flat.toLowerCase();
  let start = 0;
  const first = q ? lower.indexOf(q) : -1;
  if (first > width / 3) {
    start = first - Math.floor(width / 3);
  }
  let text = flat.slice(start, start + width);
  let offset = 0;
  if (start > 0) {
    text = "…" + text;
    offset = 1;
  }
  if (start + width < flat.length) {
    text += "…";
  }
  const highlights: [number, number][] = [];
  if (q) {
    const hay = text.toLowerCase();
    for (let i = hay.indexOf(q, offset); i >= 0; i = hay.indexOf(q, i + q.length)) {
      highlights.push([i, i + q.length]);
    }
  }
  return { text, highlights };
}
