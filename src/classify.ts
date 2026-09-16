// classify.ts — THE ERROR CLASSIFIER (extracted verbatim-shape from
// jarvis-agent-manager src/go-key-pool.ts classifyGoError + quota-failover.ts
// handleDeskError). LAW: quota/rejected are SERVING failures (rotate the
// slot); contract/other are NOT (retrying the same slot is correct) —
// demoting on a contract error throws away good slots.

export type ErrorClass = "quota" | "rejected" | "contract" | "other";

export function classifyError(err: string): ErrorClass {
  const e = String(err ?? "");
  if (/MissingSessionID/i.test(e)) return "contract";
  if (/GoUsageLimitError|usage limit|quota|rate limit|\b429\b/i.test(e)) return "quota";
  if (/\b401\b|\b403\b|invalid_api_key|invalid x-api-key|unauthorized/i.test(e)) return "rejected";
  return "other";
}

/** The decision: should this error demote the serving slot? quota/rejected
 *  = yes (the slot is the failure); contract/other = no (retry may succeed). */
export function demotesSlot(cls: ErrorClass): boolean {
  return cls === "quota" || cls === "rejected";
}
