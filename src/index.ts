// index.ts — mecha-brain-core public surface.
export { MechaRefusal, isMechaRefusal, type MechaRefusalCode } from "./refusal.js";
export { classifyError, demotesSlot, type ErrorClass } from "./classify.js";
export {
  getStoreDb,
  defaultDbPath,
  closeStoreDb,
  reopenStore,
  UnitStore,
  type UnitRow,
  type UnitState,
  type StoreOpenOpts,
} from "./store.js";
export {
  runBrainLoop,
  verifyDeliveryByEffect,
  BRAIN_DEFAULTS,
  type BrainDeps,
  type BrainPolicies,
  type ProbeResult,
  type ActResult,
  type DeliveryEvidence,
  type DeliveryProbe,
} from "./decision-loop.js";
export {
  textResult,
  registerToolDef,
  requireFields,
  resultIsSecretFree,
  type ToolResult,
  type ToolDef,
  type ToolRegistrar,
  type ContentBlock,
} from "./shell.js";

export const MECHA_BRAIN_VERSION = "1.0.0";
