// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// Messages between the chat panel (extension host) and its webview.
import type { ConnState, Message, Thread } from "./types";

// ViewMessage is a Message decorated by the host for display.
export interface ViewMessage extends Message {
  quoteName?: string;
  reactionNames?: string[]; // parallel to reactions
  attachmentUris?: (string | null)[]; // webview URIs, parallel to attachments
}

export interface ViewThread {
  id: string;
  title: string;
  kind: Thread["kind"];
  noteToSelf?: boolean;
  expireTimer?: number;
}

export interface Staged {
  name: string;
  path: string;
  size: number;
}

export type HostToView =
  | { type: "init"; me: string; thread: ViewThread; messages: ViewMessage[]; hasMore: boolean; draft: string; enterSends: boolean; connection: string }
  | { type: "older"; messages: ViewMessage[]; hasMore: boolean }
  | { type: "upsert"; messages: ViewMessage[] }
  | { type: "remove"; id: number }
  | { type: "thread"; thread: ViewThread }
  | { type: "typing"; name: string; sender: string; typing: boolean }
  | { type: "connection"; text: string } // empty: connected
  | { type: "staged"; files: Staged[] }
  | { type: "draft"; text: string; append?: boolean }
  | { type: "sendFailed"; body: string; error: string }
  | { type: "reveal"; ts: number }
  | { type: "focus" }
  | { type: "draftPreview"; url: string; preview: { title?: string; description?: string; host: string; imageUri?: string } | null }
  | { type: "probe" } // tests: ask the webview to report what it shows
  | { type: "probeInput"; text: string } // tests: type into the compose box
  | { type: "probeSend" } // tests: press Send
  | { type: "probeReact" } // tests: open the reaction picker on the newest message
  | { type: "probePick" }; // tests: click the first emoji in the open picker

export type ViewToHost =
  | { type: "ready" }
  | { type: "send"; body: string; quote?: { author: string; ts: number; text?: string }; preview?: string }
  | { type: "wantPreview"; url: string }
  | { type: "search" }
  | { type: "loadOlder"; before: number }
  | { type: "react"; author: string; ts: number; emoji: string; remove: boolean }
  | { type: "delete"; ts: number }
  | { type: "attach" }
  | { type: "attachData"; name: string; data: string } // base64
  | { type: "detach"; index: number }
  | { type: "open"; id: number; index: number }
  | { type: "retry"; id: number }
  | { type: "resend"; id: number }
  | { type: "copy"; text: string }
  | { type: "openLink"; url: string }
  | { type: "typing"; typing: boolean }
  | { type: "draft"; text: string; thread?: string }
  | { type: "markRead" }
  | { type: "probe"; messages: number; text: string; errors: string[]; hiddenButShown: string[]; openPopups: string[]; composer: string; input: string };

export function connectionText(state: string, conn?: ConnState, error?: string): string {
  if (state !== "connected") {
    return state === "connecting" ? "Connecting to the daemon…" : "Not connected to the daemon — messages can't be sent.";
  }
  switch (conn) {
    case "connected":
    case undefined:
      return "";
    case "connecting":
      return "Daemon is connecting to Signal…";
    case "logged-out":
      return "This device was unlinked from the account.";
    default:
      return `Signal: ${conn}${error ? ` (${error})` : ""}`;
  }
}
