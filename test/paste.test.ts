import assert from "node:assert/strict";
import test from "node:test";

import { pasteText } from "../src/paste";

test("pasteText writes the clipboard before simulating paste", async () => {
  const calls: string[] = [];

  await pasteText("cleaned text", {
    async writeClipboard(text) {
      calls.push(`clipboard:${text}`);
    },
    async simulatePaste() {
      calls.push("paste");
    },
  });

  assert.deepEqual(calls, ["clipboard:cleaned text", "paste"]);
});
