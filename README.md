# mecha-brain-core v1.0.0

A mechanical decision-making engine: tracker-of-record + decision loop + error
classifier + proof gate + refusal vocabulary + tool shell. Extracted
law-faithfully from the jarvis-agent-manager build (JAM) for reuse in any
project that needs programmable decision machinery with enforcement that works.

## The one-paragraph what
Give it a unit, a probe (is the worker done? is it progressing?), an act
(nudge/steer), and an optional slot rotation; the brain runs the poll loop,
writes every transition + reason into a SQLite tracker of record, nudges on
stall up to NUDGE_MAX, fails loud on stall/deadline/exhaustion with
snapshot-plus-remedy reasons, classifies errors (quota/rejected rotate the
slot; contract/other retry it), and proves delivery BY EFFECT (before/after,
attempt evidence) — never by a receipt's self-report.

## THE LAWS (verbatim, from the source build)
1. ROW IS TRUTH — the worker's prose is never the state; the tracker row is.
   Every transition writes its reason into the row (store.setState).
2. STALL FLAGS MEASURE SILENCE — never cancel progress-proven work; progress
   resets the nudge counter (decision-loop progress branch).
3. PAUSED IS LEGAL — paused units skip the stall/deadline cycle but a done
   marker is still honoured.
4. EXHAUSTION IS LOUD — pool exhausted fails with snapshot + remedy text
   (`brainReason("exhausted", ...)` carries the remedy), never silent.
5. QUOTA/REJECTED ROTATE; CONTRACT/OTHER RETRY — demotesSlot() is the
   polarity; demoting on a contract error throws away good slots.
6. DELIVERY BY EFFECT — verified by before/after effect size with per-attempt
   evidence; unverifiable is NEVER success (verifyDeliveryByEffect).
7. UNVERIFIABLE IS NOT STARTED — the L1 backstop doctrine inherited from the
   source build's prove gate.
8. SECRETS LAW — key material never enters state/results; labels + ids only;
   resultIsSecretFree is grep-tested in the battery.
9. DEADLINE BOUNDS TOTAL TIME — checked BEFORE the progress branch (extraction
   delta, law-faithful to "deadline exceeded without done.mk").
10. FUNCTIONS-ONLY SHELL — tool entry points are functions; results are MCP
    content blocks (textResult); bare payloads break host renderers.

## Why-wired ledger (law -> mechanism -> reason)
| law | mechanism | reason |
|---|---|---|
| row is truth | UnitStore.setState writes reason + completed_at | the worker prose lies; the row cannot |
| stall/nudge ladder | runBrainLoop no-progress branch + setNudges | nudges recover; the budget bounds them |
| deadline first + done first | runBrainLoop order: done -> paused -> deadline -> progress | extraction-shape necessity: the draft's progress `continue` would skip a late deadline check; JAM's flow always reaches its unconditional deadline (progress is only a timestamp reset), so the hoist fixes the EXTRACTION, not JAM — and done-before-deadline preserves JAM's done.mk precedence (audited: MechaAudit P1/P2) |
| rotate polarity | classifyError + demotesSlot | contract errors are not slot failures |
| loud exhaustion | brainReason("exhausted") + remedy | silent exhaustion looks alive |
| delivery by effect | verifyDeliveryByEffect before/after | receipts self-report; effects do not |
| degrade-alive store | getStoreDb sick-handle reopen | a corrupt moment must not crash the brain |
| functions-only shell | registerToolDef + textResult | silent-drop + renderer laws of the host |

## Plug-in guide (numbered)
1. `bun install` (bun-types + typescript dev-only; runtime dep: none — bun:sqlite built-in).
2. Implement BrainDeps for your domain: `probe()` (done-marker + progress from
   YOUR worker), `act(text)` (your nudge/steer), optional `rotate(cls, err)`
   (your key/slot failover), `onState` (persist or notify).
3. Persist with UnitStore: `insertUnit` at dispatch, `setState` on terminal,
   `listByState(["running","paused"])` for census.
4. Verify sends with `verifyDeliveryByEffect` (effectSize = your observable:
   bytes, rows, revision); refuse to count unverified delivery as started.
5. Wire tools with shell.ts: `registerToolDef(pi, {...})` per operator verb;
   return `textResult(payload)`; guard inputs with `requireFields`.
6. Run `bun test tests/` — the battery must stay green before you trust it.

## Provenance (variant table + deltas)
| variant | lines | verdict |
|---|---|---|
| JARVIS JAM src (orchestrator 931L + adapter 395L + pool/classifier 637L) | winner | the extraction source |
| OMP_SUBAGENTS canonical copy (886L orchestrator) | older | equal machinery, pre-Orca |
| OMP/jarvis-wave-manager decoy (720L) | thinner | NEVER a source (drops keepAlive/P3/alive laws) |
Deltas vs JAM (documented, intentional): nouns desk->unit; herdr/Orca transport
couplings -> BrainDeps probe/act/rotate seams; sqlite fd-leak + tmp-path laws
kept (cached singleton + BRAIN_TEST tmpdir); deadline check hoisted ABOVE the
progress branch (delta vs JAM's late check — law-faithful to the deadline
intent, fixes the progress-spin hole); NEW error string prefix BRAIN_* (JAM:
STALL/DEADLINE/EXHAUSTED semantics preserved).

## Audit section (zero-trust, this extraction)
Findings found by the battery during extraction, all fixed:
1. deadline check sat after the progress branch -> progress-spin hole
   (deadline test hung) -> hoisted pre-branch (law 9).
2. quota-rotate evidence: rotate fires per failing poll (2x) before exhaustion
   -> test expectation corrected to the real polarity (2, not 1).
3. probe-null branch: a probe returning no result must classify as an error,
   not crash -> errText fallback added.
4. injectable clock/sleep seams added (sleepFn/nowFn) so the battery is
   deterministic — no wall timers in tests (project rule).
5. independent zero-trust audit (fresh subagent, zero build context) confirmed
   battery/constant claims PROVEN via mutation test, refuted the JAM-hole
   attribution (P1), and found: done-vs-deadline order (P2), unpersisted slot
   rotations (P4), secrets law unenforced on the write path (P5),
   shrink-blind effect gate (P6) — all fixed; paused semantics documented as
   probe-driven (P3); dead exports covered by battery (P7).
Battery: 17/17 green (51 expects). tsc --noEmit: 0.

## SHAs
See `git log` of this package after commit; the extraction source is
Shared_Workspace/JARVIS @ 50c0350 (post w7-pilot-live).

## Left out (and why)
The Orca transport, the Orca tool verbs, the L1 hook-edge proof, and the
tracker's desk-specific fields stay in jarvis-agent-manager — they are the
HOST layer. mecha-brain-core is the domain-free decision machinery.
