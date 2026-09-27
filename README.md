<p align="center"><img src="media/icon.png" alt="signal-headless logo" width="128"></p>

# signal-headless for VS Code (unofficial Signal client)

Signal notifications and conversations inside VS Code, through a local
[signal-headless](https://github.com/jaggedmountain/signal-headless) daemon.
The extension never talks to Signal itself: the daemon owns the linked
device, and this is one more client on its socket, alongside the terminal
shell.

This is an independent project, not affiliated with or endorsed by Signal
Messenger or the Signal Technology Foundation.

- **Notifications** for incoming messages, shown once even with many windows
  open: in the focused VS Code window, or as a desktop notification
  (`notify-send`) when no VS Code window is focused. Nothing is shown for the
  conversation already on screen. Bursts (catching up after being offline)
  collapse into one notification. Reply straight from a notification.
- **Status bar**: unread count (click for the next unread conversation);
  connection problems show here too.
- **Conversations view** in the activity bar: unread first-class, previews,
  archive/unarchive, mute, mark read. The filter button switches between
  *Active* (a message in the last `signalHeadless.activeDays` days, 30 by
  default, or unread; the default filter) and *All*.
- **Chat panels**, one editor tab per conversation: history with day
  separators, quotes, reactions, attachments (images inline), receipts,
  typing indicators, disappearing-message timer, link-preview cards (from
  the preview the sender's app attached; pages are never fetched here). Reply, react, delete for
  everyone, copy, resend failed messages, retry downloads.
- **Link previews when sending**: a moment after an https link is typed, a
  preview card (title, description, image) appears above the compose box and
  goes out with the message; × drops it. `signalHeadless.sendLinkPreviews`:
  `account` (default — follow the Signal account's "Generate link previews"),
  `on`, `off`. The daemon fetches the page (https, public addresses only).
- **Compose**: `Enter` sends (`Shift+Enter` newline), `:shortcode:` completion
  and conversion (`:joy:` → 😂), attach with 📎, paste or Shift+drop. Drafts
  and staged files are kept per conversation.
- **Diagnostics** (collapsed under Conversations): account and device,
  daemon version and connection, history-transfer state, database size,
  message/conversation counts and date range, attachment files and space,
  downloads in progress or failed (click to retry). 🗑 **Delete Old Messages…**
  (also per conversation in its context menu) removes history older than a
  chosen age after showing exactly what would go, then compacts the
  database. By default only this computer's copy goes; choosing **All my
  devices** also deletes them on the phone and other linked devices
  (Signal's "delete for me" — the other people keep theirs).
- **Send to Signal…** from the explorer, editor title or selection context
  menu; the file or text lands in the chosen conversation's compose box.
- **Search** (`Signal: Search Messages…`, the 🔍 in the view title): results
  appear as you type; **Enter** lists them all in a **Search Results** panel
  under Conversations, grouped by conversation with the matches highlighted.
  Selecting a result opens the conversation scrolled to it. Search within
  one conversation from its context menu or with `/` in its chat panel.

## Getting started

The extension needs a signal-headless daemon for this computer, and the
computer linked to a Signal account. It takes care of both:

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
- **Linking.** When the host has no linked device, the status bar shows
  *Link Signal* and the Signal view offers **Link This Computer**: a panel
  runs `signal-headless --link --json` and shows the QR code to scan on the
  phone (Settings → Linked devices → Link new device). Once the phone
  confirms, the daemon starts and conversations appear. If the phone's
  **Transfer message history** is chosen, the panel (and the status bar)
  follow the transfer until the old conversations are imported. Linking
  from a terminal (`signal-headless --link`) is noticed too.

If the phone later removes this device, the extension says so; clear the old
link with `signal-headless --unlink --force` (daemon stopped) and link again.

## Keys

| | |
|---|---|
| `Ctrl+Alt+S` | open a conversation (quick pick, unread first) |
| `Ctrl+Alt+N` | next unread conversation |

In a chat panel, `Esc` (or `↑` in an empty compose box) moves to the message
list, where the TUI's keys work: `j`/`k` select, `g`/`G` oldest/newest,
`r` reply, `e` react (`1`–`6` quick picks), `y` copy, `o` open attachments,
`R` retry downloads, `D` delete for everyone, `a` attach, `i`/`Enter`/`Esc`
back to compose.

## Remote windows

The extension is a UI extension (`"extensionKind": ["ui"]`): in Remote-SSH,
WSL or container windows it keeps running on the local machine, next to the
daemon. Files from the remote workspace ("Send to Signal…", the attach
dialog) are copied to the local machine before sending. "Open Terminal Shell"
is hidden in remote windows, where a terminal would run on the remote host.
*Remote-SSH has not been exercised yet; only local windows are tested.*

## Settings

| Setting | Default | |
|---|---|---|
| `signalHeadless.socketPath` | *(empty)* | daemon socket; empty: `$SIGNAL_HEADLESS_SOCKET`, else `$XDG_RUNTIME_DIR/signal-headless.sock` |
| `signalHeadless.executablePath` | *(empty)* | `signal-headless` binary for linking, auto-start and the terminal shell; empty: a new-enough install on `PATH`, `~/.local/bin`, `~/go/bin`, else the downloaded release |
| `signalHeadless.downloadDaemon` | `ask` | download the pinned signal-headless release when none is usable: `ask`, `always`, `never` |
| `signalHeadless.releasesUrl` | GitHub releases | where to download it from (a mirror with the same `download/<tag>/<asset>` layout) |
| `signalHeadless.autoStartDaemon` | `true` | start the daemon in the background when it isn't running |
| `signalHeadless.notifications` | `all` | `off` to silence everything; mute single conversations from the view |
| `signalHeadless.desktopNotifications` | `true` | desktop notifications when no VS Code window is focused |
| `signalHeadless.notificationPreview` | `true` | include message text in notifications |
| `signalHeadless.enterSends` | `true` | off: `Ctrl+Enter` sends |
| `signalHeadless.activeDays` | `30` | the Conversations view's *Active* filter: conversations with a message in this many days, plus any unread |
| `signalHeadless.chatPanels` | `perConversation` | `single`: one Signal tab that switches conversations (drafts and replies kept per conversation) |
| `signalHeadless.sendLinkPreviews` | `account` | link previews on sent messages: follow the account setting, `on`, `off` |

## How it works

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

## License

Copyright © 2026 Jeff Mattson.

`AGPL-3.0-or-later`, the same as signal-headless; see `LICENSE`. The
extension doesn't include the daemon; the one it downloads comes from
signal-headless's own releases, with their source and license.

The AGPL covers the code, not the signal-headless logo (`media/icon.png`).
It is © 2026 Jeff Mattson, all rights reserved, except that it may be shown
unmodified to refer to this extension or signal-headless. A modified version
or fork doesn't get to use it; please give it its own name and icon.
