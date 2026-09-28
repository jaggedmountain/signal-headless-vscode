<p align="center"><img src="media/icon.png" alt="signal-headless logo" width="128"></p>

# signal-headless for VS Code

Signal in VS Code: notifications, a conversation list, and chat tabs.
Messages keep arriving while VS Code is closed.

*Unofficial. Not affiliated with or endorsed by Signal Messenger or the
Signal Technology Foundation.*

## Features

- **Notifications**, shown once across all VS Code windows, or on the desktop
  when VS Code isn't focused. Reply right from the notification.
- **Conversations view** with unread counts, mute and archive. Shows
  recently active conversations by default.
- **Chat tabs** with replies, reactions, attachments, link previews, read
  receipts and typing indicators.
- **Search** all conversations, or just one.
- **Send to Signal…** a file or selected text from the explorer or editor.
- **Status bar** unread count; click it for the next unread conversation.
- **Delete Old Messages…** from this computer, or from all linked devices.

## Getting started

1. Install the extension and open the **Signal** view in the activity bar.
2. Click **Link This Computer…**. A QR code appears.
3. On the phone: **Settings → Linked devices → Link new device**, and scan
   it. Choose **Transfer message history** to bring over past messages.

Conversations appear once the phone confirms.

The extension runs [signal-headless](https://github.com/jaggedmountain/signal-headless),
a small background service that holds the Signal connection and stores
messages on this computer. If it isn't installed, the extension offers to
download it (checksum-verified, from its GitHub releases). Once it has, each
extension update brings the matching signal-headless without asking again.
An install from `install.sh`/`install.ps1` is used instead when it's new
enough, and updates with `signal-headless --update`.

**Requirements:** Linux (x86-64 or arm64), macOS (Apple Silicon or Intel) or
Windows (x86-64). In Remote-SSH and container windows the extension runs on
the local machine, so that is the one that needs to be supported.

## Privacy

Messages are end-to-end encrypted by Signal and stored on this computer
(`~/.local/share/signal-headless`). The extension itself only talks to the
local service, apart from the one-time download. The service connects to
Signal's servers, and fetches a page's preview when a link is typed (see
`signalHeadless.sendLinkPreviews`). To clear old messages, use **Delete Old
Messages…** in the Diagnostics section of the Signal view.

## Keys

| | |
|---|---|
| `Ctrl+Alt+S` | open a conversation |
| `Ctrl+Alt+N` | next unread conversation |
| `Enter` / `Shift+Enter` | send / new line |
| `:joy:` | emoji shortcodes (→ 😂) |

In a chat tab, `Esc` moves to the message list: `j`/`k` select, `r` reply,
`e` react, `y` copy, `o` open attachment, `D` delete for everyone, `i` back
to typing.

## Settings

| Setting | Default | |
|---|---|---|
| `signalHeadless.notifications` | `all` | `off` silences everything; mute single conversations from the view |
| `signalHeadless.desktopNotifications` | `true` | notify on the desktop when VS Code isn't focused |
| `signalHeadless.notificationPreview` | `true` | show message text in notifications |
| `signalHeadless.enterSends` | `true` | `false`: `Ctrl+Enter` sends |
| `signalHeadless.activeDays` | `30` | how far back the *Active* conversation filter looks |
| `signalHeadless.chatPanels` | `perConversation` | `single`: one Signal tab that switches conversations |
| `signalHeadless.sendLinkPreviews` | `account` | previews on sent links: follow the Signal account setting, `on`, `off` |
| `signalHeadless.downloadDaemon` | `ask` | download signal-headless when needed: `ask`, `always`, `never` |
| `signalHeadless.autoStartDaemon` | `true` | start signal-headless when it isn't running |
| `signalHeadless.executablePath` | | a specific `signal-headless` binary |
| `signalHeadless.socketPath` | | a non-default service socket |
| `signalHeadless.releasesUrl` | GitHub | a mirror to download signal-headless from |

## Uninstalling

Uninstalling the extension leaves signal-headless alone: this computer stays
linked, and the message history and keys stay where they are. The only
cleanup is the copy of signal-headless the extension downloaded, if it was
using one: it is stopped and deleted.

To remove everything, run **Signal: Remove signal-headless from This
Computer…** first. After confirming with the account number, it unlinks this
computer, deletes the message history and keys (stored unencrypted), and
removes the program. It uses the installer's uninstaller when signal-headless
came from `install.sh` or `install.ps1`. The phone and other linked devices
keep their messages.

## Troubleshooting

- **"The phone removed this device"**: stop the service
  (`signal-headless --stop`), run `signal-headless --unlink --force`, then
  link again.
- **Something else**: the **Diagnostics** section of the Signal view shows
  the account, connection and storage; **Signal: Show Log** has details.

## Donate

signal-headless and this extension are free and made in spare time. If
they're useful, support helps keep them maintained:

- [GitHub Sponsors](https://github.com/sponsors/jam-on): monthly or one-time
- [Ko-fi](https://ko-fi.com/jaggedmountain): a one-off tip, no account needed

Signal itself runs on donations too:
[signal.org/donate](https://signal.org/donate/).

## License

Copyright © 2026 Jeff Mattson. `AGPL-3.0-or-later`; see `LICENSE`.
Building from source: see [CONTRIBUTING.md](CONTRIBUTING.md).

The signal-headless logo (`media/icon.png`) is not covered by the AGPL: it is
© 2026 Jeff Mattson, all rights reserved, except that it may be shown
unmodified to refer to this extension or signal-headless. Forks and modified
versions should use their own name and icon.
