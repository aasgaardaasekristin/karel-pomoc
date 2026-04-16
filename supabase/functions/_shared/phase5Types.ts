/**
 * phase5Types.ts — Phase 5 Data Contracts
 *
 * Structured types for post-chat writeback:
 * extraction outputs, evidence classification,
 * logical write targets, and governed write intents.
 *
 * NO runtime logic — pure type definitions.
 */

// ── Evidence Classification ──

export type EvidenceKind = "FACT" | "INFERENCE" | "PLAN" | "UNKNOWN";

// ── Write Quality Metadata (Phase 5B) ──

export type WriteConfidence = "low" | "medium" | "high";

export type FreshnessBand =
  | "immediate"
  | "recent"
  | "historical"
  | "timeless";

export type ChangeType =
  | "new"
  | "update"
  | "repeat"
  | "conflict";

// ── Extraction Output Kinds ──

export type ExtractionOutputKind =
  | "SITUACNI"
  | "POZNATKY"
  | "STRATEGIE"
  | "KAREL"
  | "KDO_JE_KDO"
  | "DULEZITA_DATA"
  | "SLOVNIK"
  | "VZORCE"
  | "PART_CARD"
  | "PLAN_05A"
  | "PLAN_05B";

// ── Information Sensitivity (mirrors phase3Types but scoped for writeback) ──

export type WritebackSensitivity =
  | "team_operational"
  | "child_card_relevant"
  | "therapist_private"
  | "secret_karel_only";

// ── Extracted Write Output (AI returns this) ──

export interface ExtractedWriteOutput {
  kind: ExtractionOutputKind;
  evidenceKind: EvidenceKind;
  sensitivity: WritebackSensitivity;
  summary: string;
  implication?: string;
  proposedAction?: string;
  subject?: string;
  therapist?: "hanka" | "kata" | null;
  partName?: string | null;
  partAliases?: string[];
  section?: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M" | null;
  timeHorizon?: "today_3d" | "15_60d" | null;
  // Phase 5B quality fields
  confidence: WriteConfidence;
  freshness: FreshnessBand;
  changeType: ChangeType;
  needsVerification: boolean;
  changeSummary?: string;
  conflictNote?: string;
}

// ── Logical Write Target ──

export type WriteBucket =
  | "therapist_hanka"
  | "therapist_kata"
  | "contexts"
  | "active_part_card"
  | "dormant_part_card"
  | "plan_05A"
  | "plan_05B";

export interface LogicalWriteTarget {
  bucket: WriteBucket;
  documentKey: string;
  sensitivity: WritebackSensitivity;
}

// ── Governed Write Intent ──

export interface GovernedWriteIntent {
  target: LogicalWriteTarget;
  content: string;
  evidenceKind: EvidenceKind;
  sourceMode: string;
  sourceThreadId?: string | null;
}
