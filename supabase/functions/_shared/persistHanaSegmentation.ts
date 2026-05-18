/**
 * FIX 8.3 — Persistence vrstvy nad `segmentHanaTurn`.
 *
 * Vstup:   userTurnText (= `lastUserTextForSafety` z karel-hana-chat), userId,
 *          conversationId (může být null / ne-uuid), sb client.
 * Výstup:  1 row do `hana_personal_identity_audit`
 *            (resolution_kind='fix_8_3_per_segment', marker s verzemi,
 *             segments_classified=pole všech segmentů, karel_role_per_segment=mapa).
 *          + N rows do `hana_personal_memory` per NON-ambiguous segment,
 *            pouze pokud system_config.hana_segment_writes_enabled='true'
 *            A conversationId je validní UUID (memory.source_thread_id NOT NULL uuid).
 *
 * GARANCE:
 * - Audit běží VŽDY (fail-closed jen pro memory write).
 * - Žádný throw ven — všechny chyby logged a swallowed (fire-and-forget).
 * - Per brief: messageId není v této fázi k dispozici → message_ref=null,
 *   source_message_refs=[].
 * - UUID validace pure regex, žádný DB roundtrip.
 */

import { segmentHanaTurn, segmenterVersion, type HanaTurnSegment } from "./hanaTurnSegmenter.ts";
import { isHanaSegmentWritesEnabled } from "./hanaSegmentFlag.ts";
import { mapSegmentToHanaFile } from "./hanaSegmentToFile.ts";
import { safeEnqueueDriveWrite } from "./documentGovernance.ts";

const FIX_VERSION = "v8.3.0";
const FIX_84_VERSION = "v8.4.0";
const MARKER = `fix_8_3_persist_${FIX_VERSION}_segmenter_v${segmenterVersion}`;
const DRIVE_MARKER = `fix_8_4_hana_drive_shadow_${FIX_84_VERSION}_segmenter_v${segmenterVersion}`;
const DRIVE_RESOLUTION_KIND = "fix_8_4_hana_drive_shadow";
const RESOLUTION_KIND = "fix_8_3_per_segment";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string | null | undefined): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mapování segment label → Karlova role pro daný segment.
 * Konzervativní mapping; v jsonb se per-segment uloží `segment_${idx}`.
 */
function karelRoleFor(label: HanaTurnSegment["label"]): string {
  switch (label) {
    case "intimate_self":   return "konzultant_zdravi";
    case "team_about_did":  return "vedouci_tymu";
    case "team_about_kata": return "vedouci_tymu";
    case "team_logistics":  return "vedouci_tymu";
    case "meta_to_karel":   return "meta";
    case "ambiguous":       return "none";
    default:                return "none";
  }
}

/**
 * memory_type per label (NON-ambiguous segmenty).
 */
function memoryTypeFor(label: HanaTurnSegment["label"]): string {
  switch (label) {
    case "intimate_self":   return "hana_segment_intimate";
    case "team_about_did":  return "hana_segment_team_did";
    case "team_about_kata": return "hana_segment_team_kata";
    case "team_logistics":  return "hana_segment_team_logistics";
    case "meta_to_karel":   return "hana_segment_meta";
    default:                return "hana_segment_other";
  }
}

export interface PersistHanaSegmentationArgs {
  sb: any;
  userId: string;
  conversationId: string | null;
  userTurnText: string;
}

export interface PersistHanaSegmentationResult {
  audit_inserted: boolean;
  audit_id: string | null;
  memory_rows_inserted: number;
  memory_skipped_reason: string | null;
  drive_rows_inserted: number;
  drive_rows_blocked: number;
  drive_skipped_reason: string | null;
  segments_total: number;
  segments_non_ambiguous: number;
  marker: string;
  drive_marker: string;
}

export async function persistHanaSegmentation(
  args: PersistHanaSegmentationArgs,
): Promise<PersistHanaSegmentationResult> {
  const { sb, userId, conversationId, userTurnText } = args;
  const result: PersistHanaSegmentationResult = {
    audit_inserted: false,
    memory_rows_inserted: 0,
    memory_skipped_reason: null,
    segments_total: 0,
    segments_non_ambiguous: 0,
    marker: MARKER,
  };

  try {
    if (!userTurnText || !userTurnText.trim()) {
      result.memory_skipped_reason = "empty_input";
      return result;
    }

    const seg = segmentHanaTurn({ rawText: userTurnText });
    result.segments_total = seg.segments.length;
    const nonAmbiguous = seg.segments
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.label !== "ambiguous");
    result.segments_non_ambiguous = nonAmbiguous.length;

    const inputHash = await sha256Hex(userTurnText);

    // segments_classified jsonb pole — všechny segmenty (vč. ambiguous, idx zachován)
    const segmentsClassified = seg.segments.map((s, idx) => ({
      idx,
      label: s.label,
      confidence: s.confidence,
      start_offset: s.start_offset,
      end_offset: s.end_offset,
      cues: s.cues,
    }));

    // karel_role_per_segment mapa { segment_0: "...", segment_1: "..." }
    const karelRoles: Record<string, string> = {};
    seg.segments.forEach((s, idx) => {
      karelRoles[`segment_${idx}`] = karelRoleFor(s.label);
    });

    // 1) AUDIT — vždy (per brief, nezávisle na flagu)
    const { error: auditErr } = await sb.from("hana_personal_identity_audit").insert({
      user_id: userId,
      thread_id: conversationId ?? null,
      message_ref: null,
      surface: "hana_personal",
      input_hash: inputHash,
      resolution_kind: RESOLUTION_KIND,
      speaker_identity: "hanka",
      mentioned_parts: [],
      mentioned_groups: [],
      memory_targets: [],
      warnings: [],
      marker: MARKER,
      response_guard_status: null,
      cross_contamination_blocked: false,
      segments_classified: segmentsClassified,
      patientizing_pattern_hit: false,
      karel_role_per_segment: karelRoles,
    });
    if (auditErr) {
      console.warn("[FIX 8.3] audit insert failed:", auditErr.message);
    } else {
      result.audit_inserted = true;
    }

    // 2) MEMORY — pod flagem + validní UUID thread
    const writesEnabled = await isHanaSegmentWritesEnabled(sb);
    if (!writesEnabled) {
      result.memory_skipped_reason = "flag_disabled";
      return result;
    }
    if (!isUuid(conversationId)) {
      console.warn("[FIX 8.3] skip memory write — invalid thread uuid");
      result.memory_skipped_reason = "invalid_thread_uuid";
      return result;
    }
    if (nonAmbiguous.length === 0) {
      result.memory_skipped_reason = "no_non_ambiguous_segments";
      return result;
    }

    const hashPrefix = inputHash.slice(0, 16);
    let inserted = 0;
    for (const { s, idx } of nonAmbiguous) {
      const memType = memoryTypeFor(s.label);
      const { error: memErr } = await sb.from("hana_personal_memory").insert({
        user_id: userId,
        source_thread_id: conversationId,
        source_message_refs: [],
        memory_type: memType,
        emotional_state: null,
        safe_summary: s.text.slice(0, 500),
        do_not_export_raw_text: true,
        did_relevant: s.label === "team_about_did",
        private_to_hana: true,
        dedupe_key: `fix83_${hashPrefix}_${idx}`,
        memory_payload: {
          marker: MARKER,
          segmenter_version: segmenterVersion,
          segment_idx: idx,
          label: s.label,
          confidence: s.confidence,
          cues: s.cues,
          karel_role: karelRoleFor(s.label),
        },
        topic_tags: [s.label],
      });
      if (memErr) {
        // dedupe constraint OK; warn jiné chyby
        if (!String(memErr.message || "").includes("uq_hana_memory_dedupe_active")) {
          console.warn(`[FIX 8.3] memory insert failed (segment ${idx}):`, memErr.message);
        }
      } else {
        inserted++;
      }
    }
    result.memory_rows_inserted = inserted;
    return result;
  } catch (e) {
    console.warn("[FIX 8.3] persistHanaSegmentation threw:", (e as Error)?.message);
    return result;
  }
}
