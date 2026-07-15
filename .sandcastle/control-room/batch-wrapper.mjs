#!/usr/bin/env node
// GENERATED, TOOL-OWNED — Control Room's batch-completion wrapper (#271, ADR-0028).
// Namespaced under control-room/ so it visibly belongs to Control Room; install and
// upgrade ALWAYS overwrite it, so never hand-edit. The Windows double-spawn relay
// fire-and-forgets THIS process in place of Sandcastle directly; it becomes the direct
// parent of Sandcastle, waits for the real close result, and atomically writes a
// completion sentinel the backend reconciles. The command + args arrive as a single
// JSON argv payload (never shell-concatenated), so there is no injection or quoting bug.
import { spawn } from "node:child_process";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SENTINEL_VERSION = 1;

function readPayload() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("batch-wrapper: missing JSON payload argument");
    process.exit(2);
  }
  return JSON.parse(raw);
}

// Atomic write: temp-write + rename on the SAME filesystem, so the backend never
// consumes a partial sentinel.
function writeSentinel(payload, fields) {
  const sentinel = {
    version: SENTINEL_VERSION,
    runId: payload.runId,
    branch: payload.branch,
    baseSha: payload.baseSha,
    wrapperPid: process.pid,
    childPid: fields.childPid,
    startedAt: fields.startedAt,
    endedAt: new Date().toISOString(),
    exitCode: fields.exitCode,
    terminationSignal: fields.terminationSignal,
  };
  if (fields.error) sentinel.error = fields.error;
  const target = payload.sentinelPath;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(sentinel) + "\n", "utf8");
  renameSync(tmp, target);
}

function main() {
  const payload = readPayload();
  const startedAt = new Date().toISOString();
  // Spawn Sandcastle as a normal (attached) child — the wrapper must OUTLIVE the child
  // to capture its real close result and write the sentinel, so it is never detached.
  // stdio ignored (Sandcastle writes its own worker log); windowsHide keeps it invisible.
  const child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.on("error", (err) => {
    // Sandcastle failed to launch — an honest UNKNOWN terminal fact (null exit).
    writeSentinel(payload, {
      childPid: child.pid ?? null,
      startedAt,
      exitCode: null,
      terminationSignal: null,
      error: err.message,
    });
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    writeSentinel(payload, {
      childPid: child.pid ?? null,
      startedAt,
      exitCode: code,
      terminationSignal: signal,
    });
    process.exit(0);
  });
}

main();
