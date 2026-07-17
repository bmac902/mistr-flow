import assert from "node:assert/strict";
import test from "node:test";

import {
  runSendSession,
  type CapturePickerHandle,
  type CaptureSelectionEvent,
  type RunSessionDependencies,
} from "../src/captureSession";
import type { EligibleTarget } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";

// Issue #37 (PRD #24): the picker → select → deliver loop must be reusable by
// a second verb with a DIFFERENT payload type — not just CaptureArtifact. This
// drives the shared session with a bespoke text artifact to prove the loop is
// generic in the thing it flows, so the Clipboard verb (#38/#39) can supply
// its own payload, crop, and clipboard behaviour rather than forking the loop.

interface TextArtifact {
  readonly id: string;
  readonly text: string;
}

const TEXT_ARTIFACT: TextArtifact = {
  id: "clip-text-artifact-1",
  text: "copied stack trace",
};

const TARGET: EligibleTarget = {
  target: "herdr-session-a",
  label: "claude · idle — pane a",
  agentStatus: "idle",
  agent: "claude",
  cwd: null,
};

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function makeFakePicker(): {
  handle: CapturePickerHandle;
  resolveSelection(event: CaptureSelectionEvent): void;
  closeCallCount(): number;
} {
  let current: { resolve: (event: CaptureSelectionEvent) => void } | null = null;
  let closeCalls = 0;
  return {
    handle: {
      appendTargets() {},
      awaitSelection() {
        return new Promise((resolve) => {
          current = { resolve };
        });
      },
      close() {
        closeCalls += 1;
      },
    },
    resolveSelection(event) {
      current!.resolve(event);
    },
    closeCallCount: () => closeCalls,
  };
}

test("runSendSession: drives a non-CaptureArtifact payload type end to end through delivery", async () => {
  const picker = makeFakePicker();
  const states: OverlaySnapshot[] = [];
  const delivered: TextArtifact[] = [];

  const deps: RunSessionDependencies<TextArtifact> = {
    showOverlay: (snapshot) => {
      states.push(snapshot);
    },
    captureActiveWindow: async () => TEXT_ARTIFACT,
    openPicker: () => picker.handle,
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET] }),
    copyToClipboard: async () => {},
    deliver: async (artifact, target) => {
      delivered.push(artifact);
      assert.equal(target.target, TARGET.target);
      return { kind: "delivered" };
    },
  };

  const session = runSendSession(deps);
  await flush();
  picker.resolveSelection({ kind: "target", target: TARGET });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET });
  assert.deepEqual(delivered, [TEXT_ARTIFACT]);
  assert.equal(picker.closeCallCount(), 1);
});
