/**
 * canonicalSnapshot.ts — Phase 3D Canonical Daily Snapshot Shape Lock
 *
 * One and only contract for `did_daily_context.context_json`.
 *
 * Architectural lock (see Karel_Runtime_Architecture_Lock.md):
 *   - did_daily_context = canonical daily snapshot (single source of truth
 *     for the daily runtime layer).
 *   - karel_working_memory_snapshots = derived WM, NOT canonical.
 *   - context_cache = prompt-prime cache, NOT canonical.
 *   - Drive = audit/output, NOT canonical input.
 *
 * Writer contract (FROZEN):
 *   - karel-daily-refresh: emits the canonical context_json shape.
 *   - karel-did-daily-analyzer: emits analysis_json (AI parts analysis),
 *     and on row-insert it must call composeEmptyCanonicalContext() — never
 *     write `{}` into context_json.
 *   - karel-analyst-loop: same — never write `{}` into context_json.
 *
 * Reader contract:
 *   - All readers must select context_json AND treat it as v2-shaped.
 *   - Legacy keys (parts/therapists/pipeline/recent_activity) remain
 *     temporarily in `legacy` for back-compat, but new readers must read
 *     from canonical_* fields.
 */

export const CANONICAL_SNAPSHOT_VERSION = 2 as const;

export interface CanonicalCrisisItem {
  id: string;
  partName: string;
  severity: string | null;
  phase: string;
}

export interface CanonicalTodaySessionItem {
  id: string;
  selected_part: string | null;
  therapist: string | null;
  session_lead: string | null;
  urgency_score: number | null;
  status: string | null;
  crisis_event_id: string | null;
}

export interface CanonicalQueuePrimaryItem {
  id: string;
  text: string;
  priority: string | null;
  section: string | null;
  planType: string | null;
  reviewAt: string | null;
}

export interface CanonicalQueueAdjunctItem {
  id: string;
  text: string;
  assignedTo: string | null;
  priority: string | null;
  status: string | null;
  category: string | null;
  dueDate: string | null;
}

export interface CanonicalQueue {
  primary: CanonicalQueuePrimaryItem[];
  adjunct: CanonicalQueueAdjunctItem[];
  primary_count: number;
  adjunct_count: number;
}

export interface CanonicalDriveDocuments {
  dashboard: string | null;
  operativni_plan: string | null;
  strategicky_vyhled: string | null;
  pamet_karel: string | null;
  instrukce_karel: string | null;
}

/**
 * Locked canonical shape for did_daily_context.context_json.
 *
 * Two namespaces:
 *   - canonical_*  → primary truth; readers MUST consume these.
 *   - legacy       → optional bag for any pass-through that has not yet
 *                    been migrated to a canonical field. Treated as
 *                    deprecated but tolerated by the validator.
 */
export interface CanonicalDailyContext {
  /** Schema discriminator. */
  schema_version: typeof CANONICAL_SNAPSHOT_VERSION;
  /** Prague-day ISO (YYYY-MM-DD). */
  date: string;
  /** ISO timestamp this snapshot was composed. */
  generated_at: string;
  /** Identifier of the writer that produced this row. */
  source: string;

  // ── Canonical pass-through (server resolvers) ──
  canonical_crisis_count: number;
  canonical_crises: CanonicalCrisisItem[];
  canonical_today_session: CanonicalTodaySessionItem | null;
  canonical_queue: CanonicalQueue;

  // ── Drive documents (audit-side passthrough, optional) ──
  drive_documents: CanonicalDriveDocuments;

  // ── Diff vs. yesterday (computed by daily-refresh) ──
  diff: unknown | null;

  // ── Legacy bag (deprecated, tolerated) ──
  /**
   * Tolerated container for legacy keys (parts, therapists, pipeline,
   * recent_activity, pending_tasks, recent_sessions). Readers must NOT
   * treat anything here as canonical truth.
   *
   * This bag is intentionally permissive: readers that still consume
   * legacy fields go through `selectLegacy()` so we can grep them later
   * and migrate one at a time.
   */
  legacy: Record<string, unknown>;
}

export interface CanonicalContextValidationResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Strict-but-lenient validator. Fails loudly on missing canonical_* keys,
 * tolerates extra keys in `legacy`. Used inside writers right before upsert.
 */
export function validateCanonicalContext(
  ctx: unknown,
): CanonicalContextValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!ctx || typeof ctx !== "object") {
    return { ok: false, missing: ["<root>"], warnings };
  }
  const c = ctx as Record<string, unknown>;
  const required: Array<keyof CanonicalDailyContext> = [
    "schema_version",
    "date",
    "generated_at",
    "source",
    "canonical_crisis_count",
    "canonical_crises",
    "canonical_today_session",
    "canonical_queue",
    "drive_documents",
  ];
  for (const k of required) if (!(k in c)) missing.push(k as string);

  if (c.schema_version !== CANONICAL_SNAPSHOT_VERSION) {
    warnings.push(
      `schema_version=${String(c.schema_version)} (expected ${CANONICAL_SNAPSHOT_VERSION})`,
    );
  }
  if (c.canonical_crises && !Array.isArray(c.canonical_crises)) {
    missing.push("canonical_crises[array]");
  }
  const q = c.canonical_queue as Record<string, unknown> | undefined;
  if (q && (!Array.isArray(q.primary) || !Array.isArray(q.adjunct))) {
    missing.push("canonical_queue.primary|adjunct[array]");
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Build an empty but VALID canonical context. Used by writers that need
 * to insert a fresh row without having computed the canonical fields
 * (e.g. analyst_loop and daily-analyzer when no daily-refresh row exists).
 *
 * This guarantees: no writer ever puts `{}` into context_json again.
 */
export function composeEmptyCanonicalContext(args: {
  date: string;
  source: string;
  legacy?: Record<string, unknown>;
}): CanonicalDailyContext {
  return {
    schema_version: CANONICAL_SNAPSHOT_VERSION,
    date: args.date,
    generated_at: new Date().toISOString(),
    source: args.source,
    canonical_crisis_count: 0,
    canonical_crises: [],
    canonical_today_session: null,
    canonical_queue: {
      primary: [],
      adjunct: [],
      primary_count: 0,
      adjunct_count: 0,
    },
    drive_documents: {
      dashboard: null,
      operativni_plan: null,
      strategicky_vyhled: null,
      pamet_karel: null,
      instrukce_karel: null,
    },
    diff: null,
    legacy: args.legacy ?? {},
  };
}

/**
 * Compose a canonical context from raw inputs. Writers must use this
 * helper instead of hand-building the JSON shape.
 */
export function composeCanonicalContext(args: {
  date: string;
  source: string;
  canonical_crises: CanonicalCrisisItem[];
  canonical_today_session: CanonicalTodaySessionItem | null;
  canonical_queue: CanonicalQueue;
  drive_documents?: Partial<CanonicalDriveDocuments>;
  diff?: unknown | null;
  legacy?: Record<string, unknown>;
}): CanonicalDailyContext {
  return {
    schema_version: CANONICAL_SNAPSHOT_VERSION,
    date: args.date,
    generated_at: new Date().toISOString(),
    source: args.source,
    canonical_crisis_count: args.canonical_crises.length,
    canonical_crises: args.canonical_crises,
    canonical_today_session: args.canonical_today_session,
    canonical_queue: args.canonical_queue,
    drive_documents: {
      dashboard: args.drive_documents?.dashboard ?? null,
      operativni_plan: args.drive_documents?.operativni_plan ?? null,
      strategicky_vyhled: args.drive_documents?.strategicky_vyhled ?? null,
      pamet_karel: args.drive_documents?.pamet_karel ?? null,
      instrukce_karel: args.drive_documents?.instrukce_karel ?? null,
    },
    diff: args.diff ?? null,
    legacy: args.legacy ?? {},
  };
}

/**
 * Adapter for readers that still consume legacy keys.
 * Returns either the canonical_* projection (preferred) or the legacy bag.
 *
 * This is the ONLY sanctioned way to read legacy keys post-lock. It exists
 * so we can grep all legacy-consuming readers when scheduling Part 2 cleanup.
 */
export function selectLegacy<T = unknown>(
  ctx: unknown,
  key: string,
): T | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const c = ctx as Record<string, unknown>;
  // Prefer top-level for back-compat with rows written before the lock.
  if (key in c) return c[key] as T;
  const legacy = (c.legacy ?? {}) as Record<string, unknown>;
  return legacy[key] as T | undefined;
}
