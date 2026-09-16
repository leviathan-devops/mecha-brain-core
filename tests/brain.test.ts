// brain.test.ts — THE BATTERY (Phase 3): pins the decision ladder
// deterministically via the injected clock/sleep seams — no wall timers.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyError,
  demotesSlot,
  runBrainLoop,
  verifyDeliveryByEffect,
  BRAIN_DEFAULTS,
  getStoreDb,
  closeStoreDb,
  UnitStore,
  MechaRefusal,
  textResult,
  resultIsSecretFree,
  requireFields,
} from "../src/index.js";

console.error("LOAD: brain.test.ts module evaluated");
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mbc-"));
}

let dir = "";
let dbPath = "";
let store: UnitStore;
let now = 1000;
beforeEach(() => {
    dir = tmpDir();
  dbPath = path.join(dir, "brain.sqlite");
  process.env.BRAIN_DB_PATH = dbPath;
  store = new UnitStore(getStoreDb({ dbPath }));
  now = 1000;
});
afterEach(() => {
  closeStoreDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// deterministic clock: advances pollMs per poll; sleep is a no-op.
function brainPolicies(extra: Record<string, unknown> = {}) {
  return {
    pollMs: 5,
    stallMs: 30,
    nudgeMax: 3,
    deadlineMs: 200,
    // 0ms macrotask timer: yields to the event loop so bun's per-test
    // timeout can fire; the injected nowFn keeps the ladder deterministic.
    sleepFn: async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    },
    nowFn: () => {
      now += 5;
      return now;
    },
    ...extra,
  };
}

describe("the error classifier + demotion polarity", () => {
  test("quota/rejected demote; contract/other never demote", () => {
    expect(classifyError("GoUsageLimitError: rate limit")).toBe("quota");
    expect(classifyError("HTTP 429")).toBe("quota");
    expect(classifyError("401 unauthorized")).toBe("rejected");
    expect(classifyError("MissingSessionID")).toBe("contract");
    expect(demotesSlot("quota")).toBe(true);
    expect(demotesSlot("rejected")).toBe(true);
    expect(demotesSlot("contract")).toBe(false);
    expect(demotesSlot("other")).toBe(false);
  });
});

describe("the decision loop — the full ladder (deterministic clock)", () => {
  test("done-marker -> complete with the yield written into the row", async () => {
    store.insertUnit("u1", "pilot");
    const r = await runBrainLoop(
      store,
      {
        unitId: "u1",
        probe: async () => ({ doneMarker: true, progress: true, output: "the receipt" }),
        act: async () => ({ ok: true }),
      },
      brainPolicies(),
    );
    expect(r.state).toBe("complete");
    expect(store.getUnit("u1")?.yield_preview).toBe("the receipt");
    expect(store.getUnit("u1")?.completed_at).toBeGreaterThan(0);
  });

  test("stall -> nudge exactly NUDGE_MAX times -> FAIL brain_stall", async () => {
    store.insertUnit("u2", "stall");
    let nudges = 0;
    const r = await runBrainLoop(
      store,
      {
        unitId: "u2",
        probe: async () => ({ doneMarker: false, progress: false }),
        act: async () => {
          nudges += 1;
          return { ok: true };
        },
      },
      brainPolicies(),
    );
    expect(r.state).toBe("failed");
    expect(r.reason).toContain("BRAIN_STALL");
    expect(nudges).toBe(3);
    expect(store.getUnit("u2")?.nudges).toBe(3);
  });

  test("progress resets the nudge counter (never cancel progress-proven work)", async () => {
    store.insertUnit("u3", "flap");
    let polls = 0;
    let nudges = 0;
    const r = await runBrainLoop(
      store,
      {
        unitId: "u3",
        probe: async () => {
          polls += 1;
          return { doneMarker: polls >= 8, progress: polls % 2 === 0 };
        },
        act: async () => {
          nudges += 1;
          return { ok: true };
        },
      },
      brainPolicies(),
    );
    expect(r.state).toBe("complete");
    expect(nudges).toBe(0);
  });

  test("deadline -> FAIL brain_deadline", async () => {
    store.insertUnit("u4", "slow");
    let polls = 0;
    const r = await runBrainLoop(
      store,
      {
        unitId: "u4",
        probe: async () => {
          polls += 1;
          return { doneMarker: false, progress: true };
        },
        act: async () => ({ ok: true }),
      },
      brainPolicies({ deadlineMs: 40 }),
    );

    expect(r.state).toBe("failed");
    expect(r.reason).toContain("BRAIN_DEADLINE");
  });

  test("quota rotates via rotate(); exhausted -> FAIL brain_exhausted with remedy", async () => {
    store.insertUnit("u5", "rotate");
    let rotations = 0;
    const r = await runBrainLoop(
      store,
      {
        unitId: "u5",
        probe: async () => {
          throw new Error("HTTP 429 rate limit");
        },
        act: async () => ({ ok: true }),
        rotate: async () => {
          rotations += 1;
          return rotations < 2 ? { ok: true } : { ok: false, errText: "pool empty" };
        },
      },
      brainPolicies(),
    );
    expect(r.state).toBe("failed");
    expect(r.reason).toContain("BRAIN_EXHAUSTED");
    expect(r.reason).toContain("remedy");
    // rotate fires once per failing poll; the 2nd rotation reports exhaustion
    expect(rotations).toBe(2);
  });

  test("contract error never rotates (retry the same slot is correct)", async () => {
    store.insertUnit("u6", "contract");
    let rotations = 0;
    const r = await runBrainLoop(
      store,
      {
        unitId: "u6",
        probe: async () => {
          throw new Error("MissingSessionID");
        },
        act: async () => ({ ok: true }),
        rotate: async () => {
          rotations += 1;
          return { ok: true };
        },
      },
      brainPolicies({ stallMs: 20 }),
    );
    expect(rotations).toBe(0);
    expect(r.state).toBe("failed");
    expect(r.reason).toContain("BRAIN_STALL");
  });
});

describe("the proof gate — delivery by effect, never by receipt", () => {
  test("verified when the effect grows; attempt evidence recorded", async () => {
    let size = 0;
    const r = await verifyDeliveryByEffect(
      {
        effectSize: async () => size,
        deliver: async () => {
          size = 42;
        },
      },
      { settleMs: 10, sleepFn: async () => {}, nowFn: () => (now += 10) },
    );
    expect(r.verified).toBe(true);
    expect(r.attempts.length).toBe(1);
    expect(r.attempts[0]).toEqual({ attempt: 1, before: 0, after: 42, verified: true });
  });

  test("unverifiable is NEVER success: attempts exhaust with per-attempt evidence", async () => {
    const r = await verifyDeliveryByEffect(
      { effectSize: async () => 0, deliver: async () => {} },
      { settleMs: 10, sleepFn: async () => {}, nowFn: () => (now += 10), maxAttempts: 2 },
    );
    expect(r.verified).toBe(false);
    expect(r.attempts.length).toBe(2);
  });
});

describe("the store — row is truth, degrade-alive", () => {
  test("insert/get/setState round-trip + reason written into the row", () => {
    store.insertUnit("u9", "store");
    store.setState("u9", "failed", "BRAIN_STALL: after 3 nudges");
    const row = store.getUnit("u9");
    expect(row?.state).toBe("failed");
    expect(row?.yield_preview).toContain("BRAIN_STALL");
    expect(row?.completed_at).toBeGreaterThan(0);
  });

  test("reopen after close degrades alive (the sick-handle law)", () => {
    store.insertUnit("u10", "reopen");
    closeStoreDb();
    const store2 = new UnitStore(getStoreDb({ dbPath }));
    expect(store2.getUnit("u10")?.state).toBe("running");
  });

  test("listByState is the census source", () => {
    store.insertUnit("u11a", "census");
    store.insertUnit("u11b", "census");
    store.setState("u11b", "complete");
    const running = store.listByState(["running", "paused"]);
    expect(running.map((r) => r.unit_id)).toContain("u11a");
    expect(running.map((r) => r.unit_id)).not.toContain("u11b");
  });
});

describe("the refusal vocabulary + the shell laws", () => {
  test("MechaRefusal carries a code; guard narrows", () => {
    const r = new MechaRefusal("unit_not_found", "no such unit");
    expect(r.code).toBe("unit_not_found");
    expect(r.message.startsWith("[unit_not_found]")).toBe(true);
  });

  test("textResult wraps the payload as a content block (renderer law)", () => {
    const res = textResult({ ok: true, n: 1 });
    expect(res.content.length).toBe(1);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, n: 1 });
  });

  test("secrets law: key-shaped material is detected", () => {
    expect(resultIsSecretFree("all clear")).toBe(true);
    expect(resultIsSecretFree("token sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  test("requireFields declines host pre-pass invocations safely", () => {
    expect(requireFields("call_01abc", ["scopeRoot"]).ok).toBe(false);
    expect(requireFields({ scopeRoot: "/x", desk: "d" }, ["scopeRoot", "desk"]).ok).toBe(true);
    expect(requireFields({ scopeRoot: "", desk: "d" }, ["scopeRoot", "desk"]).ok).toBe(false);
  });

  test("BRAIN_DEFAULTS are the JAM-derived constants (named, never magic)", () => {
    expect(BRAIN_DEFAULTS.pollMs).toBe(5_000);
    expect(BRAIN_DEFAULTS.stallMs).toBe(60_000);
    expect(BRAIN_DEFAULTS.nudgeMax).toBe(3);
    expect(BRAIN_DEFAULTS.deadlineMs).toBe(45 * 60_000);
    expect(BRAIN_DEFAULTS.maxAttempts).toBe(3);
  });
});
