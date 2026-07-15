import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  HerdrClock,
  HerdrExecFile,
  HerdrFailureCode,
  MAX_ELIGIBLE_TARGETS,
  checkHerdrAvailability,
  mapPanesToTargets,
  parseHerdrStatus,
  parsePaneList,
  queryEligibleTargets,
  queryHerdr,
  safeMessageFor,
} from "../src/herdr";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "herdr");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

interface MockResponse {
  error?: (Error & { code?: string | number }) | null;
  stdout?: string;
  stderr?: string;
}

type ExecHandler = (
  args: ReadonlyArray<string>,
  callback: Parameters<HerdrExecFile>[2],
) => void;

/** Build an execFile mock that dispatches on the first CLI subcommand. */
function makeExec(handler: ExecHandler): HerdrExecFile {
  return (file, args, callback) => {
    assert.equal(file, "herdr");
    handler(args, callback);
  };
}

/** Dispatch status vs. pane-list responses; pane-list may be a hang. */
function makeAdapterExec(opts: {
  status?: MockResponse;
  paneList?: MockResponse | "hang";
}): HerdrExecFile {
  return makeExec((args, callback) => {
    const sub = args[0];
    if (sub === "status") {
      const r = opts.status ?? { stdout: fixture("status-ok.json") };
      callback(r.error ?? null, r.stdout ?? "", r.stderr ?? "");
      return;
    }
    if (sub === "pane") {
      if (opts.paneList === "hang") {
        return; // never calls back
      }
      const r = opts.paneList ?? { stdout: fixture("pane-list-empty.json") };
      callback(r.error ?? null, r.stdout ?? "", r.stderr ?? "");
      return;
    }
    throw new Error(`unexpected herdr subcommand: ${args.join(" ")}`);
  });
}

interface FakeClock {
  clock: HerdrClock;
  fire(): void;
  cleared: Set<number>;
  scheduledMs: number[];
}

function makeFakeClock(): FakeClock {
  const scheduled: Array<{ cb: () => void; ms: number; handle: number }> = [];
  const cleared = new Set<number>();
  let nextHandle = 1;
  return {
    clock: {
      setTimeout(cb, ms) {
        const handle = nextHandle++;
        scheduled.push({ cb, ms, handle });
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
    cleared,
    get scheduledMs() {
      return scheduled.map((s) => s.ms);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture-driven eligibility mapping
// ---------------------------------------------------------------------------

test("mixed pane list maps only idle/working agent panes to targets", () => {
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);

  assert.deepEqual(targets, [
    {
      target: "term_A1",
      label: "claude · idle — mistr-flow — capture adapter",
      agentStatus: "idle",
    },
    {
      target: "term_B1",
      label: "codex · working — herdr — pane list",
      agentStatus: "working",
    },
    {
      target: "term_F1",
      label: "claude · idle — docs — no session metadata yet",
      agentStatus: "idle",
    },
  ]);
});

test("an eligible agent pane's target is terminal_id even when agent_session is present", () => {
  // agent_session.value looks like a plausible durable id but `herdr agent
  // send` rejects it (agent_not_found) — confirmed live 2026-07-15.
  // terminal_id is the only field that actually works, present or not.
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);

  const withSession = targets.find((t) => t.label.startsWith("claude · idle — mistr-flow"));
  assert.equal(withSession?.target, "term_A1");
});

test("an eligible agent pane missing agent_session still uses its terminal_id", () => {
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);

  const sessionless = targets.find((t) => t.target === "term_F1");
  assert.ok(sessionless, "agent pane without agent_session should be eligible");
  assert.equal(sessionless?.agentStatus, "idle");
});

test("dead and completed agent panes are excluded", () => {
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);
  const ids = targets.map((t) => t.target);

  assert.ok(!ids.includes("term_C1"), "dead excluded");
  assert.ok(!ids.includes("term_D1"), "done excluded");
});

test("panes with no agent field are excluded", () => {
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);
  const ids = targets.map((t) => t.target);

  assert.ok(!ids.includes("term_E1"), "bare shell excluded");
  assert.ok(!ids.includes("term_G1"), "unlabelled pane excluded");
});

test("targets carry the durable terminal_id, never the positional pane id", () => {
  const panes = parsePaneList(fixture("pane-list-mixed.json"));
  const targets = mapPanesToTargets(panes);

  for (const t of targets) {
    assert.ok(t.target.startsWith("term_"), "durable identity passed verbatim");
    assert.ok(!t.target.startsWith("%"), "never a positional pane id");
  }
});

test("more than 8 eligible panes are capped at 8", () => {
  const panes = parsePaneList(fixture("pane-list-overflow.json"));
  const targets = mapPanesToTargets(panes);

  assert.equal(targets.length, MAX_ELIGIBLE_TARGETS);
  // The cap keeps the first N in list order.
  assert.equal(targets[0].target, "term_overflow_01");
  assert.equal(targets[7].target, "term_overflow_08");
});

test("empty pane list yields no targets", () => {
  const panes = parsePaneList(fixture("pane-list-empty.json"));
  assert.deepEqual(mapPanesToTargets(panes), []);
});

test("a pane with no durable identity at all is excluded", () => {
  const targets = mapPanesToTargets([
    { agent: "claude", agent_status: "idle", cwd: "no id" },
  ]);
  assert.deepEqual(targets, []);
});

test("an agent pane with a non-actionable status is excluded", () => {
  const targets = mapPanesToTargets([
    {
      agent: "claude",
      agent_status: "starting",
      terminal_id: "term_starting",
      cwd: "warming up",
    },
  ]);
  assert.deepEqual(targets, []);
});

// ---------------------------------------------------------------------------
// Availability + version/capability
// ---------------------------------------------------------------------------

test("missing binary maps to a typed unavailable result", async () => {
  const enoent = Object.assign(new Error("spawn herdr ENOENT"), {
    code: "ENOENT",
  });
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({ status: { error: enoent } }),
  });

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" ? result.code : null,
    "herdr-not-found",
  );
});

test("daemon-unreachable exit maps to a typed unavailable result", async () => {
  const exit = Object.assign(new Error("herdr: cannot connect"), { code: 1 });
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({
      status: { error: exit, stderr: "connect /run/herdr.sock: no such file" },
    }),
  });

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" ? result.code : null,
    "herdr-daemon-unreachable",
  );
});

test("a running server with an unsupported protocol maps to incompatible", async () => {
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({
      status: { stdout: fixture("status-incompatible.json") },
    }),
  });

  assert.equal(result.kind, "incompatible");
  assert.equal(
    result.kind === "incompatible" ? result.code : null,
    "herdr-protocol-unsupported",
  );
});

test("a stopped server maps to a typed unavailable result", async () => {
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({
      status: { stdout: fixture("status-not-running.json") },
    }),
  });

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" ? result.code : null,
    "herdr-daemon-unreachable",
  );
});

test("unreadable status output maps to a typed incompatible result", async () => {
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({ status: { stdout: "not json at all" } }),
  });

  assert.equal(result.kind, "incompatible");
  assert.equal(
    result.kind === "incompatible" ? result.code : null,
    "herdr-version-unreadable",
  );
});

test("a supported protocol reports available", async () => {
  const result = await checkHerdrAvailability({
    execFile: makeAdapterExec({ status: { stdout: fixture("status-ok.json") } }),
  });

  assert.equal(result.kind, "available");
  assert.equal(result.kind === "available" ? result.protocol : null, 16);
});

test("unavailable and incompatible results each carry safe human copy", async () => {
  const unavailable = await checkHerdrAvailability({
    execFile: makeAdapterExec({
      status: { error: Object.assign(new Error(""), { code: "ENOENT" }) },
    }),
  });
  const incompatible = await checkHerdrAvailability({
    execFile: makeAdapterExec({
      status: { stdout: fixture("status-incompatible.json") },
    }),
  });

  assert.equal(unavailable.kind, "unavailable");
  assert.equal(incompatible.kind, "incompatible");
  assert.ok(unavailable.message.length > 0);
  assert.ok(incompatible.message.length > 0);
  assert.notEqual(unavailable.message, incompatible.message);
});

// ---------------------------------------------------------------------------
// Safe failure-code -> message table (no raw error text can leak)
// ---------------------------------------------------------------------------

test("every failure code maps to non-empty safe copy", () => {
  const codes: HerdrFailureCode[] = [
    "herdr-not-found",
    "herdr-daemon-unreachable",
    "herdr-protocol-unsupported",
    "herdr-version-unreadable",
    "pane-query-timeout",
    "pane-query-failed",
    "pane-list-unreadable",
  ];
  for (const code of codes) {
    const message = safeMessageFor(code);
    assert.ok(message.length > 0, `${code} has copy`);
  }
});

test("raw socket paths and exception text never leak into the result message", async () => {
  const secret = "connect /run/herdr/agent-42.sock: connection refused";
  const result = await queryHerdr({
    execFile: makeAdapterExec({
      status: {
        error: Object.assign(new Error(secret), { code: 1 }),
        stderr: secret,
      },
    }),
  });

  assert.equal(result.kind, "unavailable");
  const message = result.message;
  assert.equal(message, safeMessageFor("herdr-daemon-unreachable"));
  assert.ok(!message.includes(secret), "no raw error text in message");
  assert.ok(!message.includes(".sock"), "no socket path in message");
});

test("malformed pane list output maps to a safe pane-list-unreadable failure", async () => {
  const result = await queryEligibleTargets({
    execFile: makeAdapterExec({ paneList: { stdout: "{ not an array }" } }),
    clock: makeFakeClock().clock,
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : null, "pane-list-unreadable");
});

test("a pane query exec error maps to a safe pane-query-failed failure", async () => {
  const result = await queryEligibleTargets({
    execFile: makeAdapterExec({
      paneList: { error: Object.assign(new Error("boom"), { code: 2 }) },
    }),
    clock: makeFakeClock().clock,
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : null, "pane-query-failed");
});

// ---------------------------------------------------------------------------
// 2s pane-query deadline (injected timer / fake clock)
// ---------------------------------------------------------------------------

test("a hung pane query trips the 2s deadline via the injected timer", async () => {
  const fake = makeFakeClock();
  const pending = queryEligibleTargets({
    execFile: makeAdapterExec({ paneList: "hang" }),
    clock: fake.clock,
    paneQueryTimeoutMs: 2000,
  });

  // The adapter scheduled the deadline but the exec never answered.
  assert.deepEqual(fake.scheduledMs, [2000]);
  fake.fire();

  const result = await pending;
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : null, "pane-query-timeout");
});

test("a late pane response after the deadline is ignored", async () => {
  const fake = makeFakeClock();
  let lateCallback: Parameters<HerdrExecFile>[2] | null = null;
  const execFile: HerdrExecFile = (_file, _args, callback) => {
    lateCallback = callback;
  };

  const pending = queryEligibleTargets({
    execFile,
    clock: fake.clock,
    paneQueryTimeoutMs: 2000,
  });

  fake.fire();
  const result = await pending;
  assert.equal(result.kind === "failed" ? result.code : null, "pane-query-timeout");

  // A response arriving after the deadline must not resurrect the query.
  assert.doesNotThrow(() => lateCallback?.(null, fixture("pane-list-mixed.json"), ""));
});

test("a pane query that answers in time clears the deadline timer", async () => {
  const fake = makeFakeClock();
  const result = await queryEligibleTargets({
    execFile: makeAdapterExec({
      paneList: { stdout: fixture("pane-list-mixed.json") },
    }),
    clock: fake.clock,
  });

  assert.equal(result.kind, "targets");
  assert.equal(fake.cleared.size, 1, "deadline timer was cleared");
});

// ---------------------------------------------------------------------------
// End-to-end orchestration (mocked execFile, no socket protocol)
// ---------------------------------------------------------------------------

test("queryHerdr returns mapped targets on the happy path", async () => {
  const result = await queryHerdr({
    execFile: makeAdapterExec({
      status: { stdout: fixture("status-ok.json") },
      paneList: { stdout: fixture("pane-list-mixed.json") },
    }),
    clock: makeFakeClock().clock,
  });

  assert.equal(result.kind, "targets");
  assert.equal(result.kind === "targets" ? result.targets.length : -1, 3);
});

test("queryHerdr short-circuits to unavailable without querying panes", async () => {
  let paneQueried = false;
  const result = await queryHerdr({
    execFile: makeExec((args, callback) => {
      if (args[0] === "status") {
        callback(Object.assign(new Error(""), { code: "ENOENT" }), "", "");
        return;
      }
      paneQueried = true;
      callback(null, "[]", "");
    }),
    clock: makeFakeClock().clock,
  });

  assert.equal(result.kind, "unavailable");
  assert.equal(paneQueried, false, "panes not queried when Herdr is unavailable");
});

test("parseHerdrStatus rejects missing or wrong-typed fields", () => {
  assert.equal(parseHerdrStatus('{"server":{"running":true}}'), null);
  assert.equal(parseHerdrStatus('{"server":{"protocol":16}}'), null);
  assert.equal(parseHerdrStatus('{"server":{"running":"yes","protocol":16}}'), null);
  assert.equal(parseHerdrStatus('{}'), null);
  assert.deepEqual(
    parseHerdrStatus('{"server":{"running":true,"protocol":16}}'),
    { running: true, protocol: 16 },
  );
});
