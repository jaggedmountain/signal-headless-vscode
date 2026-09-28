// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { candidates, choose, download, probe, prune, releaseAsset, untar } from "../../src/daemonBinary";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "shv-bin-"));

// fakeBinary writes a script answering --version like signal-headless.
function fakeBinary(dir: string, out: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "signal-headless");
  fs.writeFileSync(p, `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
  return p;
}

test("probe reads --version --json, and old plain output as protocol 0", async () => {
  const d = scratch();
  assert.deepEqual(await probe(fakeBinary(path.join(d, "new"), '{"version":"v0.1.0","protocol":1}')), { version: "v0.1.0", protocol: 1 });
  assert.deepEqual(await probe(fakeBinary(path.join(d, "old"), "signal-headless 4e99a6f")), { version: "4e99a6f", protocol: 0 });
  assert.equal(await probe(path.join(d, "missing")), undefined);
});

test("candidates: setting only when set, else host install before our download", async () => {
  const d = scratch();
  const host = fakeBinary(path.join(d, "host"), "signal-headless old");
  const managed = fakeBinary(path.join(d, "managed"), '{"version":"v0.1.0","protocol":1}');
  const list = candidates("", path.dirname(managed), { PATH: path.dirname(host), HOME: d });
  assert.deepEqual(list.slice(0, 1), [{ path: host, source: "path" }]);
  assert.deepEqual(list[list.length - 1], { path: managed, source: "managed" });
  assert.deepEqual(candidates(host, path.dirname(managed), {}), [{ path: host, source: "setting" }]);
  // Windows: install.ps1's per-user directory.
  const ps1 = fakeBinary(path.join(d, "LocalAppData", "Programs", "signal-headless"), "signal-headless v1");
  assert.ok(candidates("", path.dirname(managed), { PATH: "", HOME: d, LOCALAPPDATA: path.join(d, "LocalAppData") }).some((c) => c.path === ps1 && c.source === "path"));
  // An old host install is skipped for the new-enough download...
  const { chosen, tooOld } = await choose(list, 1);
  assert.equal(chosen?.path, managed);
  assert.equal(tooOld[0]?.path, host);
  // ...but a configured binary is used as chosen.
  assert.equal((await choose([{ path: host, source: "setting" }], 1)).chosen?.path, host);
});

test("download verifies the checksum, follows redirects, installs the binary", async (t) => {
  const d = scratch();
  // A release tarball laid out like build/package.sh's.
  fakeBinary(path.join(d, "stage", "signal-headless"), '{"version":"v9.9.9","protocol":1}');
  fs.writeFileSync(path.join(d, "stage", "signal-headless", "LICENSE"), "AGPL");
  const asset = "signal-headless-linux-x64.tar.gz";
  execFileSync("tar", ["-C", path.join(d, "stage"), "-czf", path.join(d, asset), "signal-headless"]);
  const tgz = fs.readFileSync(path.join(d, asset));
  let sums = `${crypto.createHash("sha256").update(tgz).digest("hex")}  ${asset}\n`;
  const srv = http.createServer((req, res) => {
    if (req.url === `/download/v9.9.9/${asset}`) {
      res.writeHead(302, { Location: "/cdn/blob" }); // like GitHub → CDN
      res.end();
    } else if (req.url === "/cdn/blob") {
      res.writeHead(200, { "Content-Length": tgz.length });
      res.end(tgz);
    } else if (req.url === "/download/v9.9.9/SHA256SUMS") {
      res.end(sums);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  let progress = 0;
  const exe = await download({ baseUrl, version: "v9.9.9", dir: path.join(d, "managed", "v9.9.9"), asset, onProgress: (got) => (progress = got) });
  assert.equal(progress, tgz.length);
  assert.deepEqual(await probe(exe), { version: "v9.9.9", protocol: 1 });
  assert.equal(fs.readFileSync(path.join(d, "managed", "v9.9.9", "LICENSE"), "utf8"), "AGPL");

  sums = `${"0".repeat(64)}  ${asset}\n`;
  await assert.rejects(download({ baseUrl, version: "v9.9.9", dir: path.join(d, "x"), asset }), /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(d, "x")), false, "nothing installed on mismatch");
  await assert.rejects(download({ baseUrl, version: "v9.9.9", dir: path.join(d, "y"), asset: "signal-headless-plan9-x64.tar.gz" }), /has no signal-headless-plan9-x64.tar.gz/);
  await assert.rejects(download({ baseUrl, version: "v0.0.0", dir: path.join(d, "z"), asset }), /HTTP 404/);

  fs.mkdirSync(path.join(d, "managed", "v0.0.1"));
  prune(path.join(d, "managed"), "v9.9.9");
  assert.deepEqual(fs.readdirSync(path.join(d, "managed")), ["v9.9.9"]);
});

test("untar handles long names and skips directories", () => {
  const d = scratch();
  const long = "a".repeat(120);
  fs.mkdirSync(path.join(d, "src", "dir"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "dir", long), "long");
  fs.writeFileSync(path.join(d, "src", "dir", "short"), "x".repeat(1000));
  const tar = execFileSync("tar", ["-C", path.join(d, "src"), "--format=gnu", "-cf", "-", "dir"]);
  const files = untar(tar);
  assert.equal(files.get(`dir/${long}`)?.toString(), "long");
  assert.equal(files.get("dir/short")?.length, 1000);
  assert.equal(files.has("dir/"), false);
});

test("release assets exist only for built platforms", () => {
  assert.equal(releaseAsset("linux", "x64"), "signal-headless-linux-x64.tar.gz");
  assert.equal(releaseAsset("linux", "arm64"), "signal-headless-linux-arm64.tar.gz");
  assert.equal(releaseAsset("darwin", "arm64"), "signal-headless-darwin-arm64.tar.gz");
  assert.equal(releaseAsset("darwin", "x64"), "signal-headless-darwin-x64.tar.gz");
  assert.equal(releaseAsset("linux", "ia32"), undefined);
  assert.equal(releaseAsset("win32", "x64"), "signal-headless-windows-x64.tar.gz");
  assert.equal(releaseAsset("win32", "arm64"), undefined);
});
