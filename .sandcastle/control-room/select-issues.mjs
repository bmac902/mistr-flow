#!/usr/bin/env node
// GENERATED, TOOL-OWNED — Control Room's Sandcastle issue selector (#213, ADR-0024).
// Namespaced under control-room/ so it visibly belongs to Control Room; install and
// upgrade ALWAYS overwrite it, so never hand-edit. It reads .sandcastle/batch.json
// (the BatchSpec), resolves the work queue with the pure selectIssues() brain below
// (a verbatim copy of the host-tested function in Control Room's sandcastleModule.ts),
// and prints the issue JSON the prompt's "Open issues" block consumes. No batch.json
// present => attack-all (today's live ready-for-agent behaviour, unchanged).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function selectIssues(spec,opts){const readyQuery={command:"gh",args:["issue","list","--state","open","--label","ready-for-agent","--limit","100","--json","number,title,body,labels,comments","--jq","[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]"]};if(!spec||spec.mode!=="curated"){return{mode:"attack-all",query:readyQuery}}const handled=new Set(opts&&opts.handled||[]);const seen=new Set;const queue=[];for(const n of spec.issues||[]){if(typeof n!=="number"||!Number.isInteger(n)||n<=0)continue;if(seen.has(n))continue;seen.add(n);if(handled.has(n))continue;queue.push(n)}const cap=typeof spec.maxIterations==="number"&&Number.isInteger(spec.maxIterations)&&spec.maxIterations>0?spec.maxIterations:seen.size;return{mode:"curated",issues:queue.slice(0,cap)}}

function curatedInstruction(count){if(!(count>0))return"";return`CURATED BATCH MODE \u2014 ${count} issue(s) remain, listed below in the exact order the operator chose. That order already encodes every dependency between them, so in this mode:

- Work the FIRST issue in the list this iteration. Do NOT treat an issue's \`## Blocked by\` field or its open/closed state as a gate \u2014 the operator's order is the plan.
- An earlier issue in this batch still being OPEN is NOT a blocker: RALPH commits but never closes, so completed work stays open by design. Its code is already committed on this branch \u2014 build on it.
- Do NOT output <promise>COMPLETE</promise> while any issue remains in the list below. Only stop once this list is empty (every issue has been worked and carries a RALPH report), or you are genuinely blocked on the specific issue in front of you.

The ${count} issue(s) to work, in order:`}

function readBatchSpec() {
  try {
    return JSON.parse(readFileSync(".sandcastle/batch.json", "utf8"));
  } catch {
    return null; // absent or unreadable batch.json => attack-all
  }
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// An issue already carrying a RALPH report comment is "handled" for this batch —
// the drain marker curated mode relies on across stateless iterations.
function handledNumbers(issues) {
  return issues
    .filter((i) => (i.comments || []).some((c) => typeof c === "string" && c.includes("RALPH")))
    .map((i) => i.number);
}

function fetchIssue(n) {
  const raw = gh([
    "issue",
    "view",
    String(n),
    "--json",
    "number,title,body,labels,comments",
    "--jq",
    "{number, title, body, labels: [.labels[].name], comments: [.comments[].body]}",
  ]);
  return JSON.parse(raw);
}

function main() {
  const spec = readBatchSpec();
  // Attack-all needs no issue details — run the live query and pass its JSON straight through.
  if (!spec || spec.mode !== "curated") {
    process.stdout.write(gh(selectIssues(spec).query.args));
    return;
  }
  // Curated: fetch the operator's checklist, mark handled ones, then let the pure
  // brain drain + cap + preserve order. Print the resolved set as the same JSON shape.
  const numbers = Array.isArray(spec.issues) ? spec.issues : [];
  const details = [];
  for (const n of numbers) {
    try {
      details.push(fetchIssue(n));
    } catch {
      /* a deleted/inaccessible issue simply drops out of the queue */
    }
  }
  const handled = handledNumbers(details);
  const plan = selectIssues(spec, { handled });
  const byNumber = new Map(details.map((i) => [i.number, i]));
  const out = plan.issues.map((n) => byNumber.get(n)).filter(Boolean);
  // #243: prepend the curated-mode instruction so the agent works the operator's
  // full order and does not self-gate on Blocked-by / open state. Empty queue =>
  // empty preamble, so a drained batch still completes cleanly.
  const preamble = curatedInstruction(out.length);
  process.stdout.write((preamble ? preamble + "\n\n" : "") + JSON.stringify(out));
}

main();
