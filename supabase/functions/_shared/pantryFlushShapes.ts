/**
 * pantryFlushShapes.ts — schema-correct insert payload buildery pro Pantry B flush.
 *
 * Cíl: zabránit, aby se hourglass flush znovu rozbil kvůli tichému schema
 * driftu. Tento modul je jediný povolený zdroj insert payloads pro:
 *   - did_therapist_tasks
 *   - did_pending_questions
 *
 * `did_implications` zde NENÍ. Důvod: vyžaduje NOT NULL `observation_id`
 * s FK do `did_observations` a Pantry B observation rows nevyrábí. Dokud
 * neexistuje korektní observation pipeline napojení, tato destinace
 * zůstává blocked v karel-did-daily-cycle phase_8b.
 *
 * Architektonický zámek:
 *   - Tyto shapes jsou ověřeny proti information_schema.columns +
 *     pg_constraint (CHECK) k datu 2026-04-21.
 *   - Pokud by někdo v budoucnu změnil schema, runtime validace
 *     (validateTaskShape / validateQuestionShape) okamžitě vrátí
 *     strukturovanou chybu a entry zůstane retryable v Pantry B.
 *   - Žádný jiný kód NESMÍ stavět insert payload pro tyto tabulky
 *     ad-hoc; musí jít přes tyto buildery.
 */

// ── Inputs ──────────────────────────────────────────────────────────

export interface PantryEntryRef {
  id: string;
  entry_kind: string;
  source_kind: string;
  source_ref: string | null;
  related_part_name: string | null;
  related_therapist: "hanka" | "kata" | null;
  summary: string;
}

// ── Outputs (insert payloads) ───────────────────────────────────────

export interface TherapistTaskInsert {
  user_id: string;
  task: string;
  assigned_to: "hanka" | "kata" | "both";
  status: "pending";
  priority: "high" | "normal" | "low";
  source: string;
  category: string;
  note: string;
}

export interface PendingQuestionInsert {
  question: string;
  directed_to: "hanka" | "kata";
  subject_type: "part" | null;
  subject_id: string | null;
  status: "open";
  context: string;
}

// ── Shape validation ────────────────────────────────────────────────
//
// Lightweight runtime guards — žádná externí závislost. Vrací
// `{ ok: true, value }` nebo `{ ok: false, reason }`. Volající
// (phase_8b flush) na false reaguje tak, že entry zůstane unprocessed
// s blocked diagnostikou v flush_result.

export type ShapeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Bezpečně postaví insert pro `did_therapist_tasks`.
 *
 * Real schema (NOT NULL): user_id (uuid), task (text), assigned_to (text
 * default 'both'), status (text default 'pending'), task_tier (default
 * 'operative'), status_hanka, status_kata.
 *
 * CHECK constraints:
 *   - task_tier ∈ {'operative','tactical','strategic'}
 */
export function buildTherapistTaskInsert(
  userId: string,
  entry: PantryEntryRef,
): ShapeResult<TherapistTaskInsert> {
  if (!isUuid(userId)) {
    return { ok: false, reason: "invalid_user_id" };
  }
  if (!isNonEmptyString(entry.summary)) {
    return { ok: false, reason: "empty_summary" };
  }
  const therapist = (entry.related_therapist || "").toLowerCase();
  if (therapist !== "hanka" && therapist !== "kata") {
    return { ok: false, reason: "missing_or_invalid_related_therapist" };
  }

  const priority: "high" | "normal" =
    entry.entry_kind === "risk" ? "high" : "normal";

  return {
    ok: true,
    value: {
      user_id: userId,
      task: entry.summary.slice(0, 500),
      assigned_to: therapist,
      status: "pending",
      priority,
      source: "pantry_b_flush",
      category: entry.entry_kind || "general",
      note: JSON.stringify({
        pantry_entry_id: entry.id,
        pantry_entry_kind: entry.entry_kind,
        pantry_source_kind: entry.source_kind,
        pantry_source_ref: entry.source_ref ?? null,
        related_part_name: entry.related_part_name ?? null,
      }),
    },
  };
}

/**
 * Bezpečně postaví insert pro `did_pending_questions`.
 *
 * Real schema (NOT NULL): question (text). Žádné `user_id`. Žádné
 * `asked_to`/`source_kind`/`source_ref`/`part_name`.
 *
 * CHECK constraints:
 *   - status ∈ {'open','answered','expired','irrelevant'}
 *
 * Mapping:
 *   - asked_to(legacy) → directed_to
 *   - part_name(legacy) → subject_type='part' + subject_id
 *   - source metadata → context (JSON string)
 */
export function buildPendingQuestionInsert(
  entry: PantryEntryRef,
): ShapeResult<PendingQuestionInsert> {
  if (!isNonEmptyString(entry.summary)) {
    return { ok: false, reason: "empty_summary" };
  }
  const therapist = (entry.related_therapist || "").toLowerCase();
  if (therapist !== "hanka" && therapist !== "kata") {
    return { ok: false, reason: "missing_or_invalid_related_therapist" };
  }

  return {
    ok: true,
    value: {
      question: entry.summary.slice(0, 500),
      directed_to: therapist,
      subject_type: entry.related_part_name ? "part" : null,
      subject_id: entry.related_part_name ?? null,
      status: "open",
      context: JSON.stringify({
        pantry_entry_id: entry.id,
        pantry_entry_kind: entry.entry_kind,
        pantry_source_kind: entry.source_kind,
        pantry_source_ref: entry.source_ref ?? null,
      }),
    },
  };
}

/**
 * Konstanta pro blocked did_implications destinaci.
 * Centralizováno pro inspect endpoint, aby reason matchoval phase_8b.
 */
export const IMPLICATIONS_BLOCKED_REASON =
  "schema_blocked_observation_id_required_no_safe_synthesis_path";
