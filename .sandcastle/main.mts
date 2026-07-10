import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// Observable from birth (Control Room #193): pin the HOST Claude projects
// directory EXPLICITLY rather than trusting an ambient $HOME — on Windows $HOME
// is often unset, which would silently send captured sessions to the wrong place
// and keep them invisible to Control Room. os.homedir() resolves through
// USERPROFILE on Windows, so this is a concrete path. Sandcastle captures each
// Claude Code session to <hostProjectsDir>/<encoded-cwd>/<session-id>.jsonl with
// the cwd rewritten to the host repo root, so this project's runs appear in the
// fleet automatically, filed under this Project.
const hostProjectsDir = join(homedir(), ".claude", "projects");

// Read a single var from .sandcastle/.env (operator-created, gitignored). The
// real token never lives in git — only .env.example ships.
function readSandcastleEnv(name: string): string {
  let envText = "";
  try {
    envText = readFileSync(".sandcastle/.env", "utf8");
  } catch {
    return "";
  }
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

function readMaxIterations(): number {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === "--max-iterations" || arg === "-n");
  const rawValue = flagIndex >= 0 ? args[flagIndex + 1] : args[0];
  const parsed = Number(rawValue ?? "1");
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

// Run: npm run sandcastle                     (single issue)
//      npm run sandcastle -- -n 5             (five iterations)
//      npm run sandcastle -- -m claude-opus-4-8   (harder batches)
//
// The ESM run(...) is wrapped in an async IIFE (not a top-level `await`) so tsx
// never dies with "Top-level await is currently not supported with the cjs
// output format" — it runs the same under an ESM or a CommonJS package.json.
void (async () => {
await run({
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container. Build the
  // image once before the first run (this tag must match imageName below):
  //   npx @ai-hero/sandcastle docker build-image --image-name sandcastle:mistr-flow
  sandbox: docker({
    imageName: "sandcastle:mistr-flow",
    selinuxLabel: false,
  }),

  // Claude Code, authenticated by CLAUDE_CODE_OAUTH_TOKEN (mint with
  // `claude setup-token`) so usage bills to the Claude subscription, not the
  // metered API. sessionStorage pins the host transcript store (above).
  agent: claudeCode(model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken,
    },
    sessionStorage: { hostProjectsDir },
  }),

  promptFile: "./.sandcastle/prompt.md",
  maxIterations,

  // "head" bind-mounts the host directory directly into the container — no git
  // worktree is created, sidestepping the Windows git-worktree path bugs.
  branchStrategy: { type: "head" },

  hooks: {
    sandbox: {
      onSandboxReady: [
        { command: "git config --global --add safe.directory /home/agent/workspace" },
        // Install deps only when this project has a package.json; a project
        // without one just runs the agent against its files.
        {
          command:
            "[ -f package.json ] && npm install --prefer-offline 2>&1 | tail -3 || echo 'no package.json — skipping npm install'",
        },
      ],
    },
  },
});
})();
