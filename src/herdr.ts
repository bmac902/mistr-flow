import { execFile as nodeExecFile } from "node:child_process";

// Mistr Flow talks to Herdr only through the supported `herdr` CLI (ADR 0001) —
// never the raw unix-socket protocol. This module is the query side of that
// adapter: availability, version/capability, eligibility, and safe errors.
// Delivery is deliberately absent; it is gated on the live delivery spike.

/** How many pane targets the picker can show (digit slots 2–9). */
export const MAX_ELIGIBLE_TARGETS = 8;

/** Default deadline for the `herdr pane list` query. */
export const PANE_QUERY_TIMEOUT_MS = 2000;

/** CLI protocol versions this adapter knows how to speak. */
const SUPPORTED_PROTOCOLS: ReadonlySet<number> = new Set([1]);

/** Actionable agent statuses — the only ones that make a pane an Eligible Target. */
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["idle", "working"]);

export type AgentStatus = "idle" | "working";

/**
 * A structured code for every adapter failure. Consumers switch on the code
 * for behaviour and render {@link safeMessageFor} as text — the code never
 * carries a raw socket path, command line, or exception string.
 */
export type HerdrFailureCode =
  | "herdr-not-found"
  | "herdr-daemon-unreachable"
  | "herdr-protocol-unsupported"
  | "herdr-version-unreadable"
  | "pane-query-timeout"
  | "pane-query-failed"
  | "pane-list-unreadable";

const SAFE_MESSAGES: Record<HerdrFailureCode, string> = {
  "herdr-not-found": "Herdr isn't installed or running — Clipboard only, sir.",
  "herdr-daemon-unreachable": "Herdr isn't answering — Clipboard only, sir.",
  "herdr-protocol-unsupported":
    "Herdr and Mistr Flow aren't speaking the same language — update one of them.",
  "herdr-version-unreadable":
    "Couldn't confirm Herdr's version — Clipboard only, sir.",
  "pane-query-timeout": "Herdr took too long to answer — Clipboard only, sir.",
  "pane-query-failed": "Couldn't reach Herdr's panes — Clipboard only, sir.",
  "pane-list-unreadable":
    "Herdr's answer didn't make sense — Clipboard only, sir.",
};

/** The only text a consumer may render for a failure. Never raw error output. */
export function safeMessageFor(code: HerdrFailureCode): string {
  return SAFE_MESSAGES[code];
}

/**
 * A pane Mistr Flow may offer in the Capture picker. Carries a human label
 * (including agent state) and the opaque durable target identity passed back
 * to Herdr verbatim — never a positional pane id.
 */
export interface EligibleTarget {
  readonly target: string;
  readonly label: string;
  readonly agentStatus: AgentStatus;
}

/** The result of asking Herdr for eligible targets. */
export type HerdrQueryResult =
  | { readonly kind: "targets"; readonly targets: readonly EligibleTarget[] }
  | {
      readonly kind: "unavailable";
      readonly code: HerdrFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "incompatible";
      readonly code: HerdrFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly code: HerdrFailureCode;
      readonly message: string;
    };

/** The result of the version/capability check run at adapter init. */
export type HerdrAvailabilityResult =
  | { readonly kind: "available"; readonly protocol: number }
  | {
      readonly kind: "unavailable";
      readonly code: HerdrFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "incompatible";
      readonly code: HerdrFailureCode;
      readonly message: string;
    };

type ExecCallbackError = (Error & { code?: string | number }) | null;

/** Minimal `execFile` shape — mirrors node's callback contract for mocking. */
export type HerdrExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

/** Injectable timer seam so the 2s deadline can be driven by a fake clock. */
export interface HerdrClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HerdrAdapterDeps {
  readonly execFile?: HerdrExecFile;
  readonly clock?: HerdrClock;
  readonly paneQueryTimeoutMs?: number;
}

const defaultExecFile: HerdrExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(
      error as ExecCallbackError,
      stdout ?? "",
      stderr ?? "",
    );
  });
};

const defaultClock: HerdrClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Full query flow: version/capability check, then a deadline-bounded pane
 * query mapped to Eligible Targets. Returns exactly one typed result — a
 * consumer renders the local-only picker for anything that isn't `targets`.
 */
export async function queryHerdr(
  deps: HerdrAdapterDeps,
): Promise<HerdrQueryResult> {
  const availability = await checkHerdrAvailability(deps);
  if (availability.kind !== "available") {
    return availability;
  }

  return queryEligibleTargets(deps);
}

/**
 * The init-time check: is Herdr present, running, and speaking a protocol we
 * understand? Availability and version-mismatch are distinct typed results so
 * the picker can explain the difference instead of failing mysteriously.
 */
export async function checkHerdrAvailability(
  deps: HerdrAdapterDeps,
): Promise<HerdrAvailabilityResult> {
  const execFile = deps.execFile ?? defaultExecFile;
  const outcome = await runHerdr(execFile, ["version", "--format", "json"]);

  if (outcome.error) {
    if (typeof outcome.error.code === "string") {
      // Spawn failure (ENOENT/EACCES/…): the binary isn't there to run.
      return failure("unavailable", "herdr-not-found");
    }
    // Non-zero exit: the CLI ran but couldn't reach the daemon.
    return failure("unavailable", "herdr-daemon-unreachable");
  }

  const version = parseVersion(outcome.stdout);
  if (!version) {
    return failure("incompatible", "herdr-version-unreadable");
  }
  if (!SUPPORTED_PROTOCOLS.has(version.protocol)) {
    return failure("incompatible", "herdr-protocol-unsupported");
  }

  return { kind: "available", protocol: version.protocol };
}

/**
 * Query `herdr pane list` under the pane-query deadline and map it to Eligible
 * Targets. Assumes the availability check has already passed.
 */
export async function queryEligibleTargets(
  deps: HerdrAdapterDeps,
): Promise<HerdrQueryResult> {
  const execFile = deps.execFile ?? defaultExecFile;
  const clock = deps.clock ?? defaultClock;
  const timeoutMs = deps.paneQueryTimeoutMs ?? PANE_QUERY_TIMEOUT_MS;

  const outcome = await runHerdrWithDeadline(
    execFile,
    ["pane", "list", "--format", "json"],
    clock,
    timeoutMs,
  );

  if (outcome.kind === "timeout") {
    return failure("failed", "pane-query-timeout");
  }
  if (outcome.error) {
    return failure("failed", "pane-query-failed");
  }

  let panes: RawPane[];
  try {
    panes = parsePaneList(outcome.stdout);
  } catch {
    return failure("failed", "pane-list-unreadable");
  }

  return { kind: "targets", targets: mapPanesToTargets(panes) };
}

interface RawPane {
  readonly pane_id?: unknown;
  readonly target_id?: unknown;
  readonly label?: unknown;
  readonly agent_name?: unknown;
  readonly agent_status?: unknown;
  readonly agent_session?: unknown;
  readonly title?: unknown;
}

/**
 * Parse `herdr pane list --format json`. Throws when the output isn't a JSON
 * array — the caller maps that to a safe `pane-list-unreadable` result.
 */
export function parsePaneList(stdout: string): RawPane[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("herdr pane list did not return an array");
  }
  return parsed as RawPane[];
}

/**
 * Eligibility (glossary *Eligible Target*): the pane must carry the `agent`
 * label AND an actionable agent status (idle/working). Presence of the
 * optional `agent_session` metadata is NOT the test — recognised agent panes
 * can lack it. A durable `target_id` is required (never the positional pane
 * id). Bare shells, unknown labels, and completed/dead panes are excluded.
 * Capped at {@link MAX_ELIGIBLE_TARGETS}.
 */
export function mapPanesToTargets(
  panes: ReadonlyArray<RawPane>,
): EligibleTarget[] {
  const targets: EligibleTarget[] = [];

  for (const pane of panes) {
    if (targets.length >= MAX_ELIGIBLE_TARGETS) {
      break;
    }
    const target = mapPane(pane);
    if (target) {
      targets.push(target);
    }
  }

  return targets;
}

function mapPane(pane: RawPane): EligibleTarget | null {
  if (pane.label !== "agent") {
    return null;
  }
  if (
    typeof pane.agent_status !== "string" ||
    !ACTIONABLE_STATUSES.has(pane.agent_status)
  ) {
    return null;
  }
  if (typeof pane.target_id !== "string" || pane.target_id.length === 0) {
    // A pane with no durable identity cannot be a delivery target — and we
    // never fall back to the positional pane id.
    return null;
  }

  const agentStatus = pane.agent_status as AgentStatus;
  return {
    target: pane.target_id,
    label: buildTargetLabel(pane, agentStatus),
    agentStatus,
  };
}

function buildTargetLabel(pane: RawPane, agentStatus: AgentStatus): string {
  const name =
    typeof pane.agent_name === "string" && pane.agent_name.length > 0
      ? pane.agent_name
      : "agent";
  const base = `${name} · ${agentStatus}`;
  if (typeof pane.title === "string" && pane.title.length > 0) {
    return `${base} — ${pane.title}`;
  }
  return base;
}

interface ParsedVersion {
  readonly version: string;
  readonly protocol: number;
}

/** Parse `herdr version --format json`; returns null on anything unusable. */
export function parseVersion(stdout: string): ParsedVersion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { version?: unknown; protocol?: unknown };
  if (
    typeof record.version !== "string" ||
    typeof record.protocol !== "number"
  ) {
    return null;
  }
  return { version: record.version, protocol: record.protocol };
}

interface ExecOutcome {
  readonly error: ExecCallbackError;
  readonly stdout: string;
  readonly stderr: string;
}

type DeadlineOutcome =
  | { readonly kind: "timeout" }
  | {
      readonly kind: "exec";
      readonly error: ExecCallbackError;
      readonly stdout: string;
      readonly stderr: string;
    };

function runHerdr(
  execFile: HerdrExecFile,
  args: ReadonlyArray<string>,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile("herdr", args, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

function runHerdrWithDeadline(
  execFile: HerdrExecFile,
  args: ReadonlyArray<string>,
  clock: HerdrClock,
  timeoutMs: number,
): Promise<DeadlineOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    const handle = clock.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);

    execFile("herdr", args, (error, stdout, stderr) => {
      if (settled) {
        // A late response after the deadline is ignored — it can never
        // resurrect a closed pane query.
        return;
      }
      settled = true;
      clock.clearTimeout(handle);
      resolve({ kind: "exec", error, stdout, stderr });
    });
  });
}

function failure(
  kind: "unavailable" | "incompatible",
  code: HerdrFailureCode,
): HerdrAvailabilityResult;
function failure(
  kind: "failed",
  code: HerdrFailureCode,
): HerdrQueryResult;
function failure(
  kind: "unavailable" | "incompatible" | "failed",
  code: HerdrFailureCode,
): HerdrAvailabilityResult | HerdrQueryResult {
  return { kind, code, message: safeMessageFor(code) } as
    | HerdrAvailabilityResult
    | HerdrQueryResult;
}
