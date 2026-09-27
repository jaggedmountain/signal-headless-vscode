// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

// cleanEnv undoes the VS Code snap's environment overrides (it saves the
// originals as FOO_VSCODE_SNAP_ORIG) so the daemon — and the programs it
// runs — see the user's normal environment.
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const suffix = "_VSCODE_SNAP_ORIG";
  for (const [k, v] of Object.entries(env)) {
    if (!k.endsWith(suffix)) {
      continue;
    }
    const orig = k.slice(0, -suffix.length);
    if (v === undefined || v === "") {
      delete out[orig];
    } else {
      out[orig] = v;
    }
    delete out[k];
  }
  return out;
}
