// GENERATED, TOOL-OWNED — Control Room's Sandcastle live-stream forwarder (#202).
// Namespaced under control-room/ so it visibly belongs to Control Room; install and
// upgrade ALWAYS overwrite it, so never hand-edit. Wire it into the entrypoint's run()
// via `logging: { type: "file", path, onAgentStreamEvent: createStreamForwarder({ cwd, model }) }`
// to stream a batch into Control Room live (Tier-2). Absent, batches still surface
// post-hoc (Tier-1) — so this is purely additive and degrades gracefully.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const FALLBACK_SLUG = "C--sandcastle-uncategorized";

// Claude's transcript-dir slug encoding (matches the emitter family), so a batch's
// live session co-locates under the same Project slug as its host repo.
export function slugForCwd(cwd) {
  if (!cwd || String(cwd).trim() === "") return FALLBACK_SLUG;
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

// Where the backend tails Sandcastle live transcripts (SANDCASTLE_TRANSCRIPTS_DIR
// on the backend); default mirrors the backend's own default.
export function liveTranscriptsDir() {
  return (
    process.env.SANDCASTLE_TRANSCRIPTS_DIR ||
    join(homedir(), ".sandcastle", "live-transcripts")
  );
}

function detUuid(...parts) {
  const h = createHash("sha1").update(parts.join(":")).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return (
    h.slice(0, 8) + "-" + h.slice(8, 12) + "-5" + h.slice(13, 16) + "-" +
    y + h.slice(17, 20) + "-" + h.slice(20, 32)
  );
}

function isoOf(ts) {
  const d = ts instanceof Date ? ts : ts != null ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Project ONE Sandcastle AgentStreamEvent into Claude-shaped transcript records:
//   text     -> an assistant text entry
//   toolCall -> an assistant tool_use entry (tool_use is content[0], Normalizer rule)
//   raw      -> nothing (the unparsed stdout line — pure plumbing, not conversation)
// ctx carries { sessionId, cwd, model, seq } for stable ids + turn context.
export function projectStreamEvent(event, ctx) {
  if (!event || typeof event !== "object") return [];
  const sessionId = ctx.sessionId;
  const ts = isoOf(event.timestamp);
  const key = event.type + ":" + (event.iteration ?? 0) + ":" + (ctx.seq ?? 0);
  const model = ctx.model ? { model: ctx.model } : {};
  const cwd = ctx.cwd ? { cwd: ctx.cwd } : {};
  if (event.type === "text") {
    const text = String(event.message ?? "");
    if (!text) return [];
    return [{
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", ...model },
      uuid: detUuid(sessionId, "text", key),
      sessionId,
      timestamp: ts,
      ...cwd,
    }];
  }
  if (event.type === "toolCall") {
    const name = String(event.name ?? "unknown");
    const callId = detUuid(sessionId, "call", key);
    return [{
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: callId, name, input: { formattedArgs: String(event.formattedArgs ?? "") } }],
        stop_reason: "tool_calls",
        ...model,
      },
      uuid: detUuid(sessionId, "tool", key),
      sessionId,
      timestamp: ts,
      ...cwd,
    }];
  }
  return [];
}

// Build the onAgentStreamEvent callback. All fs work is deferred to the callback and
// wrapped best-effort, so construction never throws and a forward failure is silent.
export function createStreamForwarder(options = {}) {
  const cwd = options.cwd || process.cwd();
  const sessionId =
    options.sessionId || detUuid("sandcastle", cwd, options.runId || String(process.pid));
  const model = options.model;
  const baseDir = options.dir || liveTranscriptsDir();
  const outDir = join(baseDir, slugForCwd(cwd));
  const outPath = join(outDir, sessionId + ".jsonl");
  let seq = 0;
  let ready = false;
  return function onAgentStreamEvent(event) {
    try {
      const records = projectStreamEvent(event, { sessionId, cwd, model, seq });
      seq += 1;
      if (records.length === 0) return;
      if (!ready) {
        mkdirSync(outDir, { recursive: true });
        ready = true;
      }
      let out = "";
      for (const r of records) out += JSON.stringify(r) + "\n";
      appendFileSync(outPath, out, "utf8");
    } catch {
      // best-effort: never throw into the agent stream (Sandcastle swallows anyway).
    }
  };
}
