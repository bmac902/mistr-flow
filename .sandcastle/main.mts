import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { homedir } from "node:os";
import { join } from "node:path";
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

const claudeOauthToken = readSandcastleEnv("CLAUDE_CODE_OAUTH_TOKEN");

// Pin the HOST Claude projects directory explicitly rather than trusting an
// ambient $HOME — on Windows $HOME is often unset, which would silently send
// captured sessions to the wrong place and keep them invisible to Control Room.
// Sandcastle captures each Claude Code session here with the cwd rewritten to
// the host repo root, so this project's batch runs appear in the fleet.
const hostProjectsDir = join(homedir(), ".claude", "projects");

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

function readModel(): string {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === "--model" || arg === "-m");
  return flagIndex >= 0 ? args[flagIndex + 1] ?? "claude-sonnet-4-6" : "claude-sonnet-4-6";
}

const model = readModel();

// Simple loop: an agent that picks open issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker({
    imageName: "sandcastle:mistr-flow",
  }),

  // Claude Code, authenticated by CLAUDE_CODE_OAUTH_TOKEN (mint with
  // `claude setup-token`) so usage bills to the Claude subscription, not the
  // metered API. Control Room's Batch verb always passes --model explicitly;
  // readModel()'s Sonnet fallback only applies to a raw `npm run sandcastle`.
  // sessionStorage pins the host transcript store (hostProjectsDir above).
  agent: claudeCode(model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken,
    },
    sessionStorage: { hostProjectsDir },
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
  branchStrategy: { type: "merge-to-head" },

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. Use it to install dependencies or run
      // any other setup steps your project needs.
      onSandboxReady: [
        { command: "git config --global --add safe.directory /home/agent/workspace" },
        { command: "npm install" },
      ],
    },
  },
});
