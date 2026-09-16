// decision-loop.ts — THE DECISION LOOP (extracted from jarvis-agent-manager
// watchDesk, src/desk-orchestrator.ts:408-530). THE SHAPE:
//
//   poll -> done-marker? -> complete
//        -> no progress? -> nudge (max NUDGE_MAX) -> else FAIL brain_stall
//        -> deadline?    -> FAIL brain_deadline
//        -> act error    -> classify: quota/rejected = rotate slot
//                                       contract/other = retry same slot
//        -> exhausted    -> FAIL LOUD brain_exhausted (snapshot + remedy)
//
// LAWS pinned by tests/brain.test.ts:
//   ROW IS TRUTH: every transition writes the reason into the row.
//   STALL FLAGS MEASURE SILENCE: never cancel progress-proven work.
//   PAUSED/BLOCKED IS LEGAL: never a pass, never a fail.
//   EXHAUSTION IS LOUD: snapshot + remedy, never silent.
// TEST SEAM (documented delta): sleepFn + nowFn are injectable so the
// battery drives the ladder deterministically — no wall-clock timers.

import { classifyError, demotesSlot, type ErrorClass } from "./classify.js";
import { UnitStore, type UnitState } from "./store.js";

export const BRAIN_DEFAULTS = {
  pollMs: 5_000,
  stallMs: 60_000,
  nudgeMax: 3,
  deadlineMs: 45 * 60_000,
  maxAttempts: 3,
} as const;

export type ProbeResult = {
  doneMarker: boolean;
  progress: boolean;
  /** The host paused the unit: the loop skips stall/deadline accumulation
   *  but still honours a done marker (JAM paused semantics). */
  paused?: boolean;
  output?: string;
};

export type RotateResult = ActResult & { slotIdx?: number | null };

export type ActResult = { ok: boolean; errText?: string };

export type BrainDeps = {
  unitId: string;
  probe: () => Promise<ProbeResult>;
  act: (text: string) => Promise<ActResult>;
  rotate?: (cls: ErrorClass, errText: string) => Promise<RotateResult>;
  onState?: (state: UnitState, reason: string) => void;
};

export type BrainPolicies = {
  pollMs?: number;
  stallMs?: number;
  nudgeMax?: number;
  deadlineMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
};

export type LoopResult = { state: UnitState; reason: string; polls: number };

function brainReason(kind: "stall" | "deadline" | "exhausted", detail: string): string {
  if (kind === "stall") return `BRAIN_STALL: no unit progress for the stall window after the nudge budget — ${detail}`;
  if (kind === "deadline") return `BRAIN_DEADLINE: deadline exceeded without the done-marker — ${detail}`;
  return `BRAIN_EXHAUSTED: all slots dead — ${detail} | remedy: wait for the earliest window or provision fresh slots`;
}

export async function runBrainLoop(
  store: UnitStore,
  deps: BrainDeps,
  policies: BrainPolicies = {},
): Promise<LoopResult> {
  const pollMs = policies.pollMs ?? BRAIN_DEFAULTS.pollMs;
  const stallMs = policies.stallMs ?? BRAIN_DEFAULTS.stallMs;
  const nudgeMax = policies.nudgeMax ?? BRAIN_DEFAULTS.nudgeMax;
  const deadlineMs = policies.deadlineMs ?? BRAIN_DEFAULTS.deadlineMs;
  const sleepFn = policies.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = policies.nowFn ?? Date.now;
  const deadline = nowFn() + deadlineMs;
  let nudges = 0;
  let lastProgress = nowFn();
  let polls = 0;
  const finish = (state: UnitState, reason: string): LoopResult => {
    store.setState(deps.unitId, state, reason);
    deps.onState?.(state, reason);
    return { state, reason, polls };
  };

  for (;;) {
    polls += 1;
    await sleepFn(pollMs);
    let probe: ProbeResult | null = null;
    let probeErr: string | null = null;
    try {
      probe = await deps.probe();
    } catch (err) {
      probeErr = err instanceof Error ? err.message : String(err);
    }
    // ERROR BRANCH: quota/rejected rotate (slot persisted); contract/other
    // retry the same slot; stall still applies to silent failures.
    if (probeErr !== null || probe === null) {
      const errText = probeErr ?? "probe returned no result";
      const cls = classifyError(errText);
      if (demotesSlot(cls) && deps.rotate) {
        const next = await deps.rotate(cls, errText);
        if (typeof next.slotIdx === "number") store.setSlotIdx(deps.unitId, next.slotIdx);
        if (!next.ok) {
          return finish("failed", brainReason("exhausted", `${cls}: ${errText.slice(0, 160)}`));
        }
        lastProgress = nowFn();
        continue;
      }
      if (nowFn() - lastProgress > stallMs) {
        return finish("failed", brainReason("stall", `${cls}: ${errText.slice(0, 160)}`));
      }
      continue;
    }
    // DONE BEFORE DEADLINE (JAM order): a done-marker arriving in the same
    // tick the deadline expires still completes — done.mk is honoured first.
    if (probe.doneMarker) {
      return finish("complete", probe.output ?? "done-marker observed");
    }
    // PAUSED: skip stall/deadline accumulation (the pane + pin stay live).
    if (probe.paused) {
      lastProgress = nowFn();
      continue;
    }
    // DEADLINE bounds total wall time regardless of progress (extraction
    // shape: checked after done/paused, before the progress reset).
    if (nowFn() > deadline) {
      return finish("failed", brainReason("deadline", `${Math.round(deadlineMs / 60_000)}min budget`));
    }
    if (probe.progress) {
      nudges = 0;
      lastProgress = nowFn();
      continue;
    }
    if (nowFn() - lastProgress > stallMs) {
      if (nudges < nudgeMax) {
        nudges += 1;
        store.setNudges(deps.unitId, nudges);
        const act = await deps.act(
          `[NUDGE ${nudges}/${nudgeMax}] continue toward your goal — when done, signal the done-marker.`,
        );
        if (!act.ok) {
          const cls = classifyError(act.errText ?? "");
          if (demotesSlot(cls) && deps.rotate) {
            const next = await deps.rotate(cls, act.errText ?? "");
            if (typeof next.slotIdx === "number") store.setSlotIdx(deps.unitId, next.slotIdx);
            if (!next.ok) {
              return finish("failed", brainReason("exhausted", `${cls} on nudge ${nudges}`));
            }
          }
        }
        lastProgress = nowFn();
        continue;
      }
      return finish("failed", brainReason("stall", `after ${nudgeMax} nudges`));
    }
  }
}

/** THE PROOF GATE (from the adapter's submit-verify + the L1 backstop
 *  doctrine): delivery is verified BY EFFECT — a before/after difference —
 *  never by a receipt's self-report. Unverifiable is never success.
 *  TEST SEAM: sleepFn + nowFn injectable (deterministic battery). */
export type DeliveryProbe = {
  effectSize: () => Promise<number>;
  deliver: () => Promise<void>;
};

export type DeliveryAttempt = { attempt: number; before: number; after: number; verified: boolean };
export type DeliveryEvidence = { attempts: DeliveryAttempt[]; verified: boolean };

export async function verifyDeliveryByEffect(
  probe: DeliveryProbe,
  opts?: {
    maxAttempts?: number;
    minDelta?: number;
    settleMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
  },
): Promise<DeliveryEvidence> {
  const maxAttempts = opts?.maxAttempts ?? BRAIN_DEFAULTS.maxAttempts;
  const minDelta = opts?.minDelta ?? 1;
  const settleMs = opts?.settleMs ?? 1000;
  const sleepFn = opts?.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = opts?.nowFn ?? Date.now;
  const evidence: DeliveryAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = await probe.effectSize();
    await probe.deliver();
    const verifyStart = nowFn();
    let after = before;
    for (;;) {
      after = await probe.effectSize();
      if (after > before) {
        evidence.push({ attempt, before, after, verified: true });
        return { attempts: evidence, verified: true };
      }
      if (nowFn() - verifyStart >= settleMs) break;
      await sleepFn(Math.min(settleMs, 1000));
    }
    evidence.push({ attempt, before, after, verified: false });
  }
  return { attempts: evidence, verified: false };
}
