import assert from "node:assert/strict";
import test from "node:test";

import { appTargetToEligibleTarget } from "../src/appTargets";
import type { AppWindowOutcome } from "../src/appWindow";
import {
  createAppDeliveryAdapter,
  createRoutingDeliveryAdapter,
  type AppDeliveryDeps,
} from "../src/appDeliver";
import type { CaptureDeliverOutcome } from "../src/captureSession";
import type { DeliverFn, SendPayload } from "../src/deliver";
import type { EligibleTarget } from "../src/herdr";

const CHATGPT = appTargetToEligibleTarget({
  id: "chatgpt",
  label: "ChatGPT",
  process: "ChatGPT",
  glyph: "chatgpt",
});

const CHATGPT_WITH_KEYS = appTargetToEligibleTarget({
  id: "chatgpt",
  label: "ChatGPT",
  process: "ChatGPT",
  pasteFocusKeys: "{ESC}",
});

function makeDeps(overrides: Partial<AppDeliveryDeps> = {}) {
  const log: string[] = [];
  const deps: AppDeliveryDeps = {
    focusWindow: async () => {
      log.push("focus");
      return { kind: "focused", hwnd: "1" } as AppWindowOutcome;
    },
    writeImageToClipboard: (p) => log.push(`image:${p}`),
    writeTextToClipboard: (t) => log.push(`text:${t}`),
    simulatePaste: async () => {
      log.push("paste");
    },
    sendKeys: async (k) => {
      log.push(`keys:${k}`);
    },
    pathExists: async () => true,
    readTextFile: async () => "spilled contents",
    ...overrides,
  };
  return { deps, log };
}

// ---------------------------------------------------------------------------
// Clipboard content by payload flavor (+ ordering: clipboard → focus → paste)
// ---------------------------------------------------------------------------

test("a screenshot (.png) is put on the clipboard as an image, then focus, then paste", async () => {
  const { deps, log } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  const payload: SendPayload = {
    id: "c1",
    injectText: "C:\\tmp\\cap.png",
    requiresFile: "C:\\tmp\\cap.png",
  };
  const outcome = await deliver(payload, CHATGPT);

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(log, ["image:C:\\tmp\\cap.png", "focus", "paste"]);
});

test("short text is pasted as text", async () => {
  const { deps, log } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  await deliver({ id: "c2", injectText: "hello world" }, CHATGPT);
  assert.deepEqual(log, ["text:hello world", "focus", "paste"]);
});

test("a long-text spill (.txt) pastes its CONTENTS, never the path", async () => {
  const { deps, log } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  await deliver(
    { id: "c3", injectText: "C:\\tmp\\relay-1.txt", requiresFile: "C:\\tmp\\relay-1.txt" },
    CHATGPT,
  );
  assert.deepEqual(log, ["text:spilled contents", "focus", "paste"]);
});

test("pasteFocusKeys fires after focus and before the paste", async () => {
  const { deps, log } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  await deliver({ id: "c4", injectText: "hi" }, CHATGPT_WITH_KEYS);
  assert.deepEqual(log, ["text:hi", "focus", "keys:{ESC}", "paste"]);
});

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

test("a missing required file fails the delivery — clipboard untouched, no focus, no paste", async () => {
  const { deps, log } = makeDeps({ pathExists: async () => false });
  const deliver = createAppDeliveryAdapter(deps);
  const outcome = await deliver(
    { id: "c5", injectText: "C:\\tmp\\gone.png", requiresFile: "C:\\tmp\\gone.png" },
    CHATGPT,
  );
  assert.equal(outcome.kind, "failed");
  assert.equal((outcome as { code: string }).code, "delivery-file-missing");
  assert.deepEqual(log, []);
});

test("a multi-file relay fails naming the missing file (all-or-nothing)", async () => {
  const { deps } = makeDeps({
    pathExists: async (p) => p !== "C:\\a\\gone.py",
  });
  const deliver = createAppDeliveryAdapter(deps);
  const outcome = await deliver(
    {
      id: "c6",
      injectText: "C:\\a\\ok.py\nC:\\a\\gone.py",
      requiresFiles: ["C:\\a\\ok.py", "C:\\a\\gone.py"],
    },
    CHATGPT,
  );
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, /gone\.py/);
});

// ---------------------------------------------------------------------------
// Focus failures fail the delivery (focus IS the mechanism)
// ---------------------------------------------------------------------------

test("focus outcomes map to distinct failure codes, and never paste", async () => {
  const cases: Array<[AppWindowOutcome["kind"], string]> = [
    ["window-not-found", "app-window-not-found"],
    ["foreground-refused", "app-foreground-refused"],
    ["helper-not-found", "app-focus-failed"],
    ["helper-error", "app-focus-failed"],
  ];
  for (const [focusKind, code] of cases) {
    const { deps, log } = makeDeps({
      focusWindow: async () => ({ kind: focusKind }) as AppWindowOutcome,
    });
    const deliver = createAppDeliveryAdapter(deps);
    const outcome = await deliver({ id: `f-${focusKind}`, injectText: "hi" }, CHATGPT);
    assert.equal(outcome.kind, "failed");
    assert.equal((outcome as { code: string }).code, code);
    assert.ok(!log.includes("paste"), `${focusKind} must not paste`);
  }
});

// ---------------------------------------------------------------------------
// Ledger idempotency (the unknown→retry guard against a double paste)
// ---------------------------------------------------------------------------

test("a retry with the same payload id pastes once and returns the same outcome", async () => {
  const { deps, log } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  const payload: SendPayload = { id: "same", injectText: "hi" };
  const first = await deliver(payload, CHATGPT);
  const second = await deliver(payload, CHATGPT);
  assert.deepEqual(first, { kind: "delivered" });
  assert.deepEqual(second, { kind: "delivered" });
  assert.equal(log.filter((x) => x === "paste").length, 1, "exactly one paste");
});

test("a payload id reused against a different target or text is rejected as a mismatch", async () => {
  const { deps } = makeDeps();
  const deliver = createAppDeliveryAdapter(deps);
  await deliver({ id: "x", injectText: "hi" }, CHATGPT);

  const otherTarget = appTargetToEligibleTarget({ id: "slack", label: "Slack", process: "Slack" });
  const wrongTarget = await deliver({ id: "x", injectText: "hi" }, otherTarget);
  assert.equal((wrongTarget as { code: string }).code, "delivery-id-mismatch");

  const wrongText = await deliver({ id: "x", injectText: "different" }, CHATGPT);
  assert.equal((wrongText as { code: string }).code, "delivery-id-mismatch");
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

test("the router sends kind:'app' to the app adapter and everything else to herdr", async () => {
  const seen: string[] = [];
  const herdr: DeliverFn = async () => {
    seen.push("herdr");
    return { kind: "delivered" } as CaptureDeliverOutcome;
  };
  const app: DeliverFn = async () => {
    seen.push("app");
    return { kind: "delivered" } as CaptureDeliverOutcome;
  };
  const route = createRoutingDeliveryAdapter({ herdr, app });

  const pane: EligibleTarget = {
    target: "term-1",
    label: "claude · idle",
    agentStatus: "idle",
    agent: "claude",
    cwd: null,
  };

  await route({ id: "1", injectText: "x" }, CHATGPT);
  await route({ id: "2", injectText: "x" }, pane); // kind undefined ⇒ herdr
  await route({ id: "3", injectText: "x" }, { ...pane, kind: "herdr" });

  assert.deepEqual(seen, ["app", "herdr", "herdr"]);
});
