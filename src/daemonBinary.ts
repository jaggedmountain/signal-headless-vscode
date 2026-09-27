// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Finding a signal-headless binary that is new enough, and downloading the
// release this extension was built for when there is none. No vscode
// imports: unit-tested in Node.
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { cleanEnv } from "./env";

export type Source = "setting" | "path" | "managed";

export interface Candidate {
  path: string;
  source: Source;
}

export interface Probe {
  version: string;
  protocol: number; // 0: from before the protocol was versioned
}

export const EXE = process.platform === "win32" ? "signal-headless.exe" : "signal-headless";

// releaseAsset names the release tarball for this machine, or undefined if
// no release exists for it.
export function releaseAsset(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const supported: Record<string, string> = { "linux-x64": "linux-x64" };
  const key = supported[`${platform}-${arch}`];
  return key ? `signal-headless-${key}.tar.gz` : undefined;
}

// candidates lists existing binaries in order of preference: the setting,
// an install on the host (PATH, ~/.local/bin, ~/go/bin), then our download.
export function candidates(setting: string, managedDir: string, env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const out: Candidate[] = [];
  const add = (p: string, source: Source) => {
    if (isExecutable(p) && !out.some((c) => c.path === p)) {
      out.push({ path: p, source });
    }
  };
  if (setting.trim() !== "") {
    add(expandHome(setting.trim()), "setting");
    return out; // an explicit choice is not second-guessed
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const home = env.HOME || os.homedir();
  dirs.push(path.join(home, ".local", "bin"), path.join(home, "go", "bin"));
  for (const d of dirs) {
    add(path.join(d, EXE), "path");
  }
  add(path.join(managedDir, EXE), "managed");
  return out;
}

// probe asks a binary for its version and protocol.
export function probe(exe: string): Promise<Probe | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ["--version", "--json"], { timeout: 10_000, env: cleanEnv(process.env) }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const out = stdout.trim();
      try {
        const j = JSON.parse(out) as { version?: string; protocol?: number };
        resolve({ version: j.version ?? "?", protocol: j.protocol ?? 0 });
      } catch {
        // Older binaries ignore --json: "signal-headless <version>".
        const m = /^signal-headless\s+(\S+)/.exec(out);
        resolve(m ? { version: m[1], protocol: 0 } : undefined);
      }
    });
  });
}

// choose returns the first candidate whose protocol is at least minProtocol,
// with what was skipped (for messages). A setting is used even if older.
export async function choose(list: Candidate[], minProtocol: number): Promise<{ chosen?: Candidate & Probe; tooOld: (Candidate & Probe)[] }> {
  const tooOld: (Candidate & Probe)[] = [];
  for (const c of list) {
    const p = await probe(c.path);
    if (!p) {
      continue;
    }
    if (p.protocol >= minProtocol || c.source === "setting") {
      return { chosen: { ...c, ...p }, tooOld };
    }
    tooOld.push({ ...c, ...p });
  }
  return { tooOld };
}

export interface DownloadOptions {
  baseUrl: string; // e.g. https://github.com/jaggedmountain/signal-headless/releases
  version: string; // release tag, e.g. v0.1.0
  dir: string; // where the binary goes (replaced atomically)
  asset?: string; // default: releaseAsset()
  onProgress?: (received: number, total: number) => void;
}

// download fetches the release, checks it against the release's SHA256SUMS,
// and installs the binary into dir. Returns its path.
export async function download(o: DownloadOptions): Promise<string> {
  const asset = o.asset ?? releaseAsset();
  if (!asset) {
    throw new Error(`no signal-headless release for ${process.platform}-${process.arch} yet`);
  }
  const base = `${o.baseUrl.replace(/\/+$/, "")}/download/${o.version}`;
  const sums = (await get(`${base}/SHA256SUMS`)).toString("utf8");
  const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f.length === 2 && f[1].replace(/^\*/, "") === asset)?.[0];
  if (!want) {
    throw new Error(`${asset} is not listed in the release's SHA256SUMS`);
  }
  const tgz = await get(`${base}/${asset}`, o.onProgress);
  const got = crypto.createHash("sha256").update(tgz).digest("hex");
  if (got !== want.toLowerCase()) {
    throw new Error(`checksum mismatch for ${asset}; not installing`);
  }
  const files = untar(zlib.gunzipSync(tgz));
  const bin = files.get(`signal-headless/${EXE}`);
  if (!bin) {
    throw new Error(`${asset} has no signal-headless/${EXE}`);
  }
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const dest = path.join(o.dir, EXE);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bin, { mode: 0o755 });
  fs.renameSync(tmp, dest);
  const license = files.get("signal-headless/LICENSE");
  if (license) {
    fs.writeFileSync(path.join(o.dir, "LICENSE"), license);
  }
  return dest;
}

// get fetches a URL (following redirects: GitHub release assets redirect to
// a CDN) into memory.
export function get(url: string, onProgress?: (received: number, total: number) => void, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : url.startsWith("http:") ? http : undefined;
    if (!mod) {
      reject(new Error(`unsupported URL ${url}`));
      return;
    }
    const req = mod.get(url, { headers: { "User-Agent": "signal-headless-vscode" }, timeout: 30_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        if (url.startsWith("https:") && !next.startsWith("https:")) {
          reject(new Error(`refusing a redirect from https to ${next}`));
          return;
        }
        resolve(get(next, onProgress, redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`${url}: HTTP ${status}`));
        return;
      }
      const total = Number(res.headers["content-length"] ?? 0);
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        received += c.length;
        onProgress?.(received, total);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${url}: timed out`)));
    req.on("error", reject);
  });
}

// untar reads a POSIX (ustar) tar archive: regular files by path.
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      break;
    }
    const str = (a: number, n: number) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
    } else {
      if (longName) {
        name = longName;
        longName = undefined;
      }
      if (type === "0" || type === "\0") {
        files.set(name.replace(/^\.\//, ""), Buffer.from(data));
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// prune removes managed downloads other than keep (older versions).
export function prune(root: string, keep: string): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== keep) {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    }
  }
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
