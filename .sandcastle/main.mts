import { run, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { readFileSync } from "node:fs";

function readSandcastleEnv(name: string): string {
  const envText = readFileSync(".sandcastle/.env", "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== name) continue;
    const value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return "";
}

const openAiApiKey = readSandcastleEnv("OPENAI_KEY");

function readMaxIterations(): number {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === "--max-iterations" || arg === "-n");
  const rawValue = flagIndex >= 0 ? args[flagIndex + 1] : args[0];
  const parsed = Number(rawValue ?? "5");
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid max iterations: ${rawValue}`);
  }
  return parsed;
}

const maxIterations = readMaxIterations();

// Simple loop: an agent that picks open issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker({
    imageName: "sandcastle-mistr-flow",
  }),

  // The agent provider. gpt-5.4-mini is plenty for tracer-bullet vertical
  // slices; bump to gpt-5.4 for harder problems.
  agent: codex("gpt-5.4-mini", {
    env: {
      OPENAI_API_KEY: openAiApiKey,
    },
  }),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Defaults to 5; override with
  // --max-iterations <n> or -n <n> on the command line.
  maxIterations,

  // Branch strategy — merge-to-head creates a temporary branch for the agent
  // to work on, then merges the result back to HEAD when the run completes.
  // This is required when using copyToWorktree, since head mode bind-mounts
  // the host directory directly (no worktree to copy into).
  branchStrategy: { type: "merge-to-head" },

  // Copy node_modules from the host into the worktree before the sandbox
  // starts. This avoids a full npm install from scratch on every iteration.
  // The onSandboxReady hook still runs npm install as a safety net to handle
  // platform-specific binaries and any packages added since the last copy.
  copyToWorktree: ["node_modules"],

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. Use it to install dependencies or run
      // any other setup steps your project needs.
      onSandboxReady: [
        { command: "git config --global --add safe.directory /home/agent/workspace" },
        { command: "printenv OPENAI_API_KEY | codex login --with-api-key" },
        { command: "npm install" },
      ],
    },
  },
});
