// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Wire types of the signal-headless daemon (internal/model and
// internal/rpc/api.go in the daemon's repository).

export type ThreadKind = "direct" | "group";
export type Status = "sending" | "sent" | "delivered" | "read" | "failed";
export type ConnState = "connecting" | "connected" | "disconnected" | "logged-out" | "error";
export type AttachmentState = "pending" | "done" | "failed";

export interface Thread {
  id: string;
  kind: ThreadKind;
  title: string;
  lastTs: number;
  unread: number;
  archived?: boolean;
  lastPreview?: string;
  lastAuthor?: string;
  noteToSelf?: boolean;
  expireTimer?: number;
}

export interface Quote {
  author: string;
  ts: number;
  text?: string;
}

export interface Attachment {
  index: number;
  contentType?: string;
  filename?: string;
  size?: number;
  path?: string;
  state: AttachmentState;
  error?: string;
  voiceNote?: boolean;
  kind?: "preview"; // a link preview's image, not a file
}

// A link preview the sender's app attached (we never fetch pages ourselves).
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  date?: number;
  image: number; // index into attachments, -1 for none
}

export interface Reaction {
  reactor: string;
  emoji: string;
  ts?: number;
}

export interface Message {
  id: number;
  thread: string;
  author: string;
  authorName?: string;
  ts: number;
  serverTs?: number;
  receivedAt?: number;
  outgoing?: boolean;
  read?: boolean;
  status?: Status;
  body: string;
  quote?: Quote;
  attachments?: Attachment[];
  previews?: LinkPreview[];
  reactions?: Reaction[];
  editedAt?: number;
  deleted?: boolean;
  expiresIn?: number;
  sticker?: string;
}

export interface Contact {
  id: string;
  number?: string;
  name: string;
  nickname?: string;
  profileName?: string;
  blocked?: boolean;
}

export interface GroupInfo {
  id: string;
  title: string;
  members?: string[];
}

export interface Account {
  aci: string;
  pni?: string;
  number: string;
  deviceId: number;
}

// Message-history transfer after linking.
export interface HistoryStatus {
  state: "waiting" | "downloading" | "importing" | "done" | "declined" | "failed";
  chats?: number;
  messages?: number;
  error?: string;
}

export interface StatusResult {
  account: Account;
  connection: ConnState;
  error?: string;
  queueEmpty: boolean;
  clients: number;
  version: string;
  history?: HistoryStatus;
  linkPreviews?: boolean; // the account's "Generate link previews" setting
  protocol?: number; // API version (missing from daemons before versioning)
}

// A preview fetched for an outgoing link; image is a local file.
export interface OutgoingPreview {
  url: string;
  title?: string;
  description?: string;
  date?: number;
  image?: string;
}

// historyText describes the transfer for people ("" when there is nothing to say).
export function historyText(h?: HistoryStatus): string {
  if (!h) {
    return "";
  }
  const counts = `${h.messages ?? 0} message${h.messages === 1 ? "" : "s"} from ${h.chats ?? 0} conversation${h.chats === 1 ? "" : "s"}`;
  switch (h.state) {
    case "waiting":
      return "Waiting for message history — on the phone, choose “Transfer message history”.";
    case "downloading":
      return "Downloading message history…";
    case "importing":
      return `Importing message history… ${counts} so far.`;
    case "done":
      return h.messages ? `Imported ${counts}.` : "No message history to import.";
    case "declined":
      return "The phone didn't transfer message history.";
    case "failed":
      return `Message history transfer failed: ${h.error ?? "unknown error"}`;
  }
  return "";
}

export interface TypingEvent {
  thread: string;
  sender: string;
  name?: string;
  typing: boolean;
}

export interface MessageRef {
  author: string;
  ts: number;
}

export interface SendParams {
  thread?: string;
  to?: string;
  body?: string;
  attachments?: string[];
  quote?: Quote;
  previews?: OutgoingPreview[];
}

export interface SendResult {
  timestamp: number;
  message?: Message;
}

export function displayName(c: Contact): string {
  for (const s of [c.nickname, c.name, c.profileName, c.number]) {
    if (s && s.trim() !== "") {
      return s;
    }
  }
  return c.id;
}

// preview mirrors model.Message.Preview: a one-line summary.
export function preview(m: Message): string {
  if (m.deleted) {
    return "(deleted)";
  }
  let s = m.body.split(/\s+/).filter(Boolean).join(" ");
  if (s === "" && m.sticker) {
    s = `[sticker ${m.sticker}]`;
  }
  const atts = files(m);
  if (atts.length > 0) {
    let label = "[attachment]";
    if (atts.length > 1) {
      label = `[${atts.length} attachments]`;
    } else if (atts[0].voiceNote) {
      label = "[voice note]";
    } else if (atts[0].filename) {
      label = `[${atts[0].filename}]`;
    }
    s = s === "" ? label : `${label} ${s}`;
  }
  return s;
}

// files lists the attachments sent as files (not link-preview images).
export function files(m: Message): Attachment[] {
  return (m.attachments ?? []).filter((a) => a.kind !== "preview");
}
