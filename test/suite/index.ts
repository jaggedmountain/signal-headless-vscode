// SPDX-FileCopyrightText: 2026 Jeff Mattson
// SPDX-License-Identifier: AGPL-3.0-or-later

import Mocha from "mocha";
import * as path from "node:path";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 20_000, color: true });
  mocha.addFile(path.join(__dirname, "extension.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
