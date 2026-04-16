/**
 * governedWriteDecoder.ts — Frontend decoder for governed write envelopes
 * Mirrors the backend decodeGovernedWrite logic for UI display.
 */

export interface GovernedWriteMetadata {
  source_type?: string;
  source_id?: string;
  segment_id?: string;
  payload_fingerprint?: string;
  content_type?: string;
  subject_type?: string;
  subject_id?: string;
  crisis_event_id?: string;
}

interface GovernedWriteEnvelope {
  __governed_write__: true;
  payload: string;
  [key: string]: unknown;
}

function isGovernedWriteEnvelope(value: unknown): value is GovernedWriteEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GovernedWriteEnvelope>;
  return candidate.__governed_write__ === true && typeof candidate.payload === "string";
}

export function decodeGovernedWrite(raw: string): {
  payload: string;
  metadata: GovernedWriteMetadata | null;
} {
  try {
    const parsed = JSON.parse(raw);
    if (!isGovernedWriteEnvelope(parsed)) {
      return { payload: raw, metadata: null };
    }
    const { payload, __governed_write__, ...metadata } = parsed;
    void __governed_write__;
    return { payload, metadata };
  } catch {
    return { payload: raw, metadata: null };
  }
}

export type WriteQueueItemView = {
  id: string;
  targetDocument: string;
  payloadPreview: string;
  payloadFull: string;
  sourceType: string | null;
  contentType: string | null;
  subjectType: string | null;
  subjectId: string | null;
  priority: string | null;
  status: string | null;
  createdAt: string | null;
};

export function toWriteQueueItemView(row: {
  id: string;
  target_document: string;
  content: string;
  priority?: string | null;
  status?: string | null;
  created_at?: string | null;
}): WriteQueueItemView {
  const decoded = decodeGovernedWrite(row.content);
  return {
    id: row.id,
    targetDocument: row.target_document,
    payloadPreview: decoded.payload.split("\n").filter(l => l.trim()).slice(0, 4).join("\n"),
    payloadFull: decoded.payload,
    sourceType: decoded.metadata?.source_type ?? null,
    contentType: decoded.metadata?.content_type ?? null,
    subjectType: decoded.metadata?.subject_type ?? null,
    subjectId: decoded.metadata?.subject_id ?? null,
    priority: row.priority ?? null,
    status: row.status ?? null,
    createdAt: row.created_at ?? null,
  };
}

// ── Badge tone helper ──
export type BadgeTone = "neutral" | "info" | "warning" | "critical" | "success";

export function getBadgeTone(label: string): BadgeTone {
  if (label.includes("KONFLIKT")) return "critical";
  if (label.includes("VYŽADUJE OVĚŘENÍ") || label.includes("NEOVĚŘENO")) return "warning";
  if (label.includes("AKUTNÍ")) return "warning";
  if (label.includes("NOVÉ")) return "info";
  if (label.includes("AKTUALIZACE")) return "info";
  if (label.includes("VYSOKÁ JISTOTA")) return "success";
  return "neutral";
}

export const BADGE_TONE_STYLES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-primary/10 text-primary border-primary/30",
  warning: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  success: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
};

// ── Quality label extractor ──
export function extractQualityLabels(payload: string): string[] {
  const labelPattern = /\[([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]+)\]/g;
  const labels: string[] = [];
  let match;
  while ((match = labelPattern.exec(payload)) !== null) {
    labels.push(match[1].trim());
  }
  return labels;
}

// ── Content type label ──
export function contentTypeLabel(ct: string | null): string {
  if (!ct) return "—";
  const map: Record<string, string> = {
    card_section_update: "Karta",
    situational_analysis: "Situační analýza",
    therapist_memory_note: "Poznámka terapeuta",
    daily_plan: "Denní plán",
    strategic_outlook: "Strategický výhled",
    general_classification: "Kontexty",
  };
  return map[ct] || ct;
}

// ── Subject type label ──
export function subjectTypeLabel(st: string | null): string {
  if (!st) return "—";
  const map: Record<string, string> = {
    part: "Část",
    therapist: "Terapeutka",
    family_context: "Kontext rodiny",
    system: "Systém",
  };
  return map[st] || st;
}
