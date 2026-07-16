import assert from "node:assert/strict";
import test from "node:test";

import { runCaptureSession, type CaptureSessionClock, type CapturePickerHandle, type CaptureSelectionEvent } from "../src/captureSession";
import type { CaptureArtifact } from "../src/capture";
import {
  captureArtifactToPayload,
  createHerdrDeliveryAdapter,
  type DeliverExecFile,
} from "../src/deliver";
import type { EligibleTarget } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";

// Orchestrator integration test (issue #32, PRD #24, AC): drives digit
// selection through a fake picker handle into the *real* deliver() adapter
// (mocked execFile only) through delivering → outcome, including the
// unknown → retry-with-the-same-capture-id path, and proves that retry
// never re-injects — the real ledger, not a fake, is what's under test here.

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const ARTIFACT: CaptureArtifact = {
  id: "capture-uuid-integration",
  pngPath: "/tmp/MistrFlowCaptures/capture-uuid-integration.png",
  windowTitle: "Untitled — Notepad",
  processName: "notepad",
  takenAt: "2026-07-15T10:00:00.000Z",
};

const TARGET: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000009",
  label: "claude · idle — pane",
  agentStatus: "idle",
};

interface FakePicker {
  handle: CapturePickerHandle;
  resolveSelection(event: CaptureSelectionEvent): void;
}

function makeFakePicker(): FakePicker {
  let current: {
    resolve: (event: CaptureSelectionEvent) => void;
  } | null = null;

  const handle: CapturePickerHandle = {
    appendTargets() {},
    awaitSelection() {
      return new Promise((resolve) => {
        current = { resolve };
      });
    },
    close() {},
  };

  return {
    handle,
    resolveSelection(event) {
      current!.resolve(event);
    },
  };
}

interface FakeClock {
  clock: CaptureSessionClock;
  fire(): void;
}

function makeFakeClock(): FakeClock {
  const scheduled: Array<{ cb: () => void; handle: number }> = [];
  const cleared = new Set<number>();
  let nextHandle = 1;
  return {
    clock: {
      setTimeout(cb) {
        const handle = nextHandle++;
        scheduled.push({ cb, handle });
        return handle;
      },
      clearTimeout(handle) {
        cleared.add(handle as number);
      },
    },
    fire() {
      for (const s of scheduled) {
        if (!cleared.has(s.handle)) {
          s.cb();
        }
      }
    },
  };
}

test("integration: unknown (ack timeout) then retry with the same capture id delivers via a single real injection", async () => {
  const fakeClock = makeFakeClock();
  const picker = makeFakePicker();
  const states: OverlaySnapshot[] = [];

  const execFileCalls: { args: readonly string[] }[] = [];
  let pendingCallback:
    | ((error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void)
    | null = null;

  const execFile: DeliverExecFile = (file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    pendingCallback = callback;
  };

  const deliver = createHerdrDeliveryAdapter({
    execFile,
    pathExists: async () => true,
  });

  const session = runCaptureSession({
    showOverlay: (snapshot) => {
      states.push(snapshot);
    },
    captureActiveWindow: async () => ARTIFACT,
    openPicker: () => picker.handle,
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET] }),
    copyToClipboard: async () => {},
    deliver: (capture, target) => deliver(captureArtifactToPayload(capture), target),
    clock: fakeClock.clock,
    deliveryAckTimeoutMs: 3000,
  });

  await flush();
  picker.resolveSelection({ kind: "target", target: TARGET });
  await flush();

  // The real herdr agent send is in flight — the orchestrator's 3s ack
  // deadline fires before the CLI call itself resolves.
  assert.equal(execFileCalls.length, 1);
  fakeClock.fire();
  await flush();

  assert.equal(states.at(-1)?.phase, "capture-delivery-unknown");

  // The user presses the same digit again — retries with the same artifact.
  picker.resolveSelection({ kind: "target", target: TARGET });
  await flush();

  // Still only one real CLI invocation: the retry attached to the same
  // in-flight ledger entry rather than shelling out a second time.
  assert.equal(execFileCalls.length, 1);

  pendingCallback!(null, "", "");
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET });
  assert.equal(execFileCalls.length, 1);
  assert.deepEqual(execFileCalls[0]!.args, [
    "agent",
    "send",
    TARGET.target,
    ARTIFACT.pngPath,
  ]);
});
