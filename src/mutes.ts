// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Muted conversations, kept in a small JSON file so every VS Code window
// (and the leader that routes notifications) sees changes immediately.
import * as fs from "node:fs";
import * as path from "node:path";

export class Mutes {
  private cache = new Set<string>();
  private mtime = -1;

  constructor(private readonly file: string) {}

  private load(): Set<string> {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs !== this.mtime) {
        const ids = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.cache = new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : []);
        this.mtime = st.mtimeMs;
      }
    } catch {
      this.cache = new Set();
      this.mtime = -1;
    }
    return this.cache;
  }

  has(thread: string): boolean {
    return this.load().has(thread);
  }

  set(thread: string, muted: boolean): void {
    const ids = new Set(this.load());
    if (muted) {
      ids.add(thread);
    } else {
      ids.delete(thread);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...ids]));
    fs.renameSync(tmp, this.file);
    this.mtime = -1;
  }
}
