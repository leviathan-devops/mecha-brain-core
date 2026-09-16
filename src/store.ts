// store.ts — THE TRACKER OF RECORD (extracted from jarvis-agent-manager
// desk-orchestrator trackerDb + scope/scoped-store.ts). LAWS:
//   ROW IS TRUTH — the worker's prose is never the state; the row is.
//   CACHED SINGLETON — per-call opens leak fds (measured fd-leak incident).
//   MIGRATION GUARD — add columns via pragma check, never a noisy re-CREATE.
//   CORRUPT/REOPEN DEGRADES — a sick handle is closed and reopened; a store
//   error degrades the caller alive, it never crashes the brain.
//   BUN_TEST TMP — under tests the store resolves to a tmpdir path.
import { Database } from "bun:sqlite";

export type UnitState =
  | "pending"
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "killed";

export type UnitRow = {
  unit_id: string;
  label: string;
  state: UnitState;
  nudges: number;
  yield_preview: string;
  started_at: number;
  completed_at: number | null;
  paused_at: number | null;
  slot_idx: number | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS units (
    unit_id       TEXT PRIMARY KEY,
    label         TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT 'pending',
    nudges        INTEGER NOT NULL DEFAULT 0,
    yield_preview TEXT NOT NULL DEFAULT '',
    started_at    INTEGER,
    completed_at  INTEGER,
    paused_at     INTEGER,
    slot_idx      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_units_state ON units(state);
`;

let storeDb: Database | null = null;
let storeDbPath: string | null = null;

export type StoreOpenOpts = { dbPath: string; schema?: string[]; id?: string };

/** Cached-singleton open (fd-leak law). Reopens a sick handle; creates the
 *  parent dir; applies the schema once per path. */
export function getStoreDb(opts: StoreOpenOpts): Database {
  if (storeDb && storeDbPath === opts.dbPath) {
    try {
      storeDb.query("SELECT 1").get();
      return storeDb;
    } catch {
      try {
        storeDb.close();
      } catch {
        /* already closed */
      }
      storeDb = null;
    }
  }
  if (storeDb) {
    try {
      storeDb.close();
    } catch {
      /* best-effort */
    }
  }
  const fresh = new Database(opts.dbPath, { create: true });
  fresh.exec("PRAGMA journal_mode = WAL;");
  fresh.exec("PRAGMA busy_timeout = 5000;");
  for (const stmt of opts.schema ?? [SCHEMA]) fresh.exec(stmt);
  storeDb = fresh;
  storeDbPath = opts.dbPath;
  return storeDb;
}

export function defaultDbPath(homeDir = process.env.HOME ?? "/tmp"): string {
  if (process.env.BRAIN_DB_PATH) return process.env.BRAIN_DB_PATH;
  if (process.env.BUN_TEST === "1") {
    return `${process.env.BRAIN_TEST_DIR ?? "/tmp"}/brain-test.sqlite`;
  }
  return `${homeDir}/.mecha-brain/brain.sqlite`;
}

export function closeStoreDb(): void {
  if (storeDb) {
    try {
      storeDb.close();
    } catch {
      /* best-effort */
    }
    storeDb = null;
    storeDbPath = null;
  }
}

export class UnitStore {
  constructor(readonly db: Database) {}

  insertUnit(unitId: string, label: string, slotIdx: number | null = null): void {
    this.db
      .run(
        "INSERT INTO units (unit_id, label, state, nudges, yield_preview, started_at, slot_idx) VALUES (?, ?, 'running', 0, '', ?, ?)",
        [unitId, label, Date.now(), slotIdx],
      );
  }

  getUnit(unitId: string): UnitRow | null {
    return (this.db
      .query("SELECT * FROM units WHERE unit_id = ?")
      .get(unitId) as UnitRow | null) ?? null;
  }

  setState(unitId: string, state: UnitState, reason = ""): void {
    const completed = state === "complete" || state === "failed" || state === "killed" ? Date.now() : null;
    this.db.run(
      "UPDATE units SET state = ?, yield_preview = ?, completed_at = COALESCE(?, completed_at) WHERE unit_id = ?",
      [state, reason.slice(0, 2000), completed, unitId],
    );
  }

  setNudges(unitId: string, n: number): void {
    this.db.run("UPDATE units SET nudges = ? WHERE unit_id = ?", [n, unitId]);
  }

  setPausedAt(unitId: string, pausedAt: number | null): void {
    this.db.run("UPDATE units SET paused_at = ? WHERE unit_id = ?", [pausedAt, unitId]);
  }

  setSlotIdx(unitId: string, idx: number | null): void {
    this.db.run("UPDATE units SET slot_idx = ? WHERE unit_id = ?", [idx, unitId]);
  }

  listByState(states: UnitState[]): UnitRow[] {
    const placeholders = states.map(() => "?").join(",");
    return this.db
      .query(`SELECT * FROM units WHERE state IN (${placeholders})`)
      .all(...states) as UnitRow[];
  }
}

/** Degrade-alive: reopen the store after any sick-handle error. Never throw
 *  on reopen — a corrupt moment must not crash the brain. */
export function reopenStore(opts: StoreOpenOpts): Database {
  closeStoreDb();
  return getStoreDb(opts);
}
