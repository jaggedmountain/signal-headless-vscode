# Developing signal-headless for VS Code

The user-facing overview is in [README.md](README.md).

## How it works

### Finding and starting the daemon

- **The binary.** The extension uses, in order: the `executablePath`
  setting; an install on the host (`PATH`, `~/.local/bin`, `~/go/bin`, e.g.
  from `install.sh`) if it is new enough; else the signal-headless release
  it was built for (`package.json` → `signalHeadless.daemonVersion`). That
  release is downloaded from GitHub on first need, after asking
  (`signalHeadless.downloadDaemon`: `ask`, `always`, `never`). The download
  is checked against the release's `SHA256SUMS` and kept in the extension's
  storage. "New enough" means the binary reports at least the protocol
  version the extension needs (`signal-headless --version --json`).
- **Staying current.** The daemon keeps running across upgrades. When the
  running one is older than the extension needs, a notification offers
  **Restart Daemon**; the restart picks a new-enough binary.
- **The daemon.** A daemon already listening on the socket is used as-is,
  whoever started it. Otherwise the extension starts one: through
  `systemctl --user start signal-headless.service` when that unit is
  installed (systemd stays in charge), else as a detached process that keeps
  running after VS Code closes. Every copy uses the same data directory
  (`~/.local/share/signal-headless`), which the daemon locks, so there is
  never more than one daemon per account.

### Source layout

- `src/session.ts` — one JSON-RPC connection to the daemon (`subscribe` for
  native events), cached threads/contacts, reconnect with backoff.
- `src/daemonBinary.ts`, `src/daemonManager.ts` — choosing a new-enough
  `signal-headless` (setting, host install, download), and the checksum-
  verified release download.
- `src/launcher.ts` — `signal-headless --check --json` (linked? exit status 3
  if not) and starting the daemon (systemd unit or detached).
- `src/linkPanel.ts` — the linking panel (QR code rendered as SVG on the
  extension side).
- `src/coordinator.ts` — every window connects to the daemon, so each sees
  every message. Windows talking to the same daemon elect a leader over a
  unix socket next to the daemon's (`<socket>.vscode`); followers report
  focus, the leader routes each notification to the focused window or the
  desktop. A follower takes over if the leader window closes.
- `src/chatPanel.ts` + `webview/` — the chat panel; the webview renders with
  a strict CSP (nonce script, no inline handlers) and escapes everything that
  came from the network.
- `src/notifier.ts`, `src/threadsView.ts`, `src/statusBar.ts`,
  `src/extension.ts` — the rest of the UI.
- Mutes live in `muted.json` in the extension's global storage (shared by all
  windows); staged attachment copies in `outgoing/` there, deleted after
  sending.

Clicking a desktop notification opens
`vscode://jaggedmountain.signal-headless/open?thread=…` through `xdg-open`,
which raises VS Code and opens the conversation.

## Build, test, install

Needs Node ≥ 20, and `xvfb-run` for the in-editor suite. The tests drive a
real daemon in `--fake` mode: `npm run fetch-daemon` downloads the pinned
release into `.daemon/` (or set `SIGNAL_HEADLESS_BIN` to a local build, e.g.
`../signal-headless/bin/signal-headless`).

```bash
npm ci
npm run fetch-daemon   # the pinned signal-headless release → .daemon/
npm run build          # dist/extension.js, dist/chat.js
npm test               # typecheck, unit tests, VS Code suite (xvfb)
npm run package        # → signal-headless-vscode.vsix (one package for every platform)
code --install-extension signal-headless-vscode.vsix
```

**Releases:** bump `version` in `package.json`, tag `v<version>` and push.
`.github/workflows/release.yml` tests, packages and attaches the `.vsix` to a
GitHub release, and publishes to the Marketplace when a `VSCE_PAT` secret is
set. To move to a newer daemon, bump `signalHeadless.daemonVersion` (and
`minProtocol` when the extension starts relying on newer daemon API).

Both test suites run against `signal-headless --daemon --fake` in a scratch
directory with auto-start disabled; they never touch the real account.
`npm run test:unit` covers the RPC client, session (including auto-start
through a wrapper that forces `--fake`), multi-window routing, emoji and the
HTML escaping. `npm run test:vscode` starts a separate VS Code under xvfb
(the installed snap build when present, else a downloaded one) and drives the
extension: webview rendering, send/echo, attachments, notification routing
and coalescing, mute, mark-read, archive, search reveal.
`SHV_SCREENSHOTS=DIR npm run test:vscode` saves screenshots along the way.
