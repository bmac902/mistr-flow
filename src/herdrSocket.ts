import net from "node:net";

// The one place Mistr Flow speaks Herdr's socket protocol instead of the CLI,
// and it exists for exactly one reason: `client.window_title.*` has no CLI
// equivalent, and it is the only way to tell Herdr's host terminal window apart
// from any other terminal window on screen (ADR 0002, superseding ADR 0001's
// CLI-only clause). Everything else still goes through the `herdr` CLI.
//
// Verified live against herdr 0.7.2-preview / protocol 16 (2026-07-15).

/** Windows names the pipe after the socket path itself, verbatim. */
export function toPipePath(socketPath: string): string {
  return `\\\\.\\pipe\\${socketPath}`;
}

export interface HerdrSocketOk {
  readonly kind: "ok";
  readonly result: Record<string, unknown>;
}
export interface HerdrSocketFailed {
  readonly kind: "failed";
}
export type HerdrSocketOutcome = HerdrSocketOk | HerdrSocketFailed;

/**
 * How many connect attempts before giving up.
 *
 * Not defensive padding: herdr's listener hands out a dead pipe instance on the
 * first connect after an idle period, so attempt #1 reliably fails with EPIPE
 * and #2 succeeds. Observed live, repeatedly — a single-shot client looks
 * exactly like "the socket is broken" when it is in fact healthy.
 */
const CONNECT_ATTEMPTS = 4;
const ATTEMPT_DELAY_MS = 60;
const REQUEST_TIMEOUT_MS = 2000;

export interface HerdrSocketDeps {
  readonly connect?: (pipePath: string) => net.Socket;
  readonly delay?: (ms: number) => Promise<void>;
}

const defaultConnect = (pipePath: string): net.Socket => net.connect(pipePath);
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function callHerdrSocket(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  deps: HerdrSocketDeps = {},
): Promise<HerdrSocketOutcome> {
  const connect = deps.connect ?? defaultConnect;
  const delay = deps.delay ?? defaultDelay;
  const pipePath = toPipePath(socketPath);

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const outcome = await attemptCall(connect, pipePath, method, params);
    if (outcome.kind === "ok") return outcome;
    if (attempt < CONNECT_ATTEMPTS) await delay(ATTEMPT_DELAY_MS);
  }
  return { kind: "failed" };
}

function attemptCall(
  connect: (pipePath: string) => net.Socket,
  pipePath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<HerdrSocketOutcome> {
  return new Promise((resolve) => {
    const id = `mistr-flow:${method}`;
    let settled = false;
    let buffer = "";

    const finish = (outcome: HerdrSocketOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    let socket: net.Socket;
    try {
      socket = connect(pipePath);
    } catch {
      resolve({ kind: "failed" });
      return;
    }

    const timer = setTimeout(() => finish({ kind: "failed" }), REQUEST_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Responses are newline-delimited JSON, one object per line.
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const parsed = parseResponse(line, id);
        if (parsed) {
          finish(parsed);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => finish({ kind: "failed" }));
    socket.on("close", () => finish({ kind: "failed" }));
  });
}

function parseResponse(line: string, id: string): HerdrSocketOutcome | null {
  if (!line) return null;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const record = message as { id?: unknown; result?: unknown; error?: unknown };
  if (record.id !== id) return null;
  if (typeof record.result === "object" && record.result !== null) {
    return { kind: "ok", result: record.result as Record<string, unknown> };
  }
  return { kind: "failed" };
}
