// refusal.ts — THE NAMED REFUSAL VOCABULARY (extracted from
// jarvis-agent-manager src/orca-types.ts OrcaRefusal + adapter codes).
// LAW: every failure has a NAME; a failure without a name is unhandleable.
// The host matches on .code, never on message prose.

export type MechaRefusalCode =
  | "unit_not_found"
  | "unit_not_running"
  | "empty_directive"
  | "slot_not_found"
  | "probe_unavailable"
  | "brain_stall"
  | "brain_deadline"
  | "brain_exhausted"
  | "delivery_unverified"
  | "store_corrupt";

export class MechaRefusal extends Error {
  constructor(
    readonly code: MechaRefusalCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(`[${code}] ${message}`);
  }
}

export function isMechaRefusal(e: unknown): e is MechaRefusal {
  return e instanceof MechaRefusal;
}
