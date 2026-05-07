/**
 * P30.1 — External Reality Event normalization (source-backed only).
 *
 * Convert a raw ExternalSearchResult into a NormalizedExternalEvent that the
 * sentinel can insert into `external_reality_events`. A result without a real
 * URL MUST be discarded by the caller before reaching this function.
 *
 * Verification status rules (HARD):
 *   - source_backed_unverified  → URL exists, not manually verified
 *   - ai_unverified             → AI summarized from source snippets
 *   - manual_verified           → ONLY when a therapist verifies via UI
 *   - rejected                  → therapist rejected the source
 *   - "verified" / "verified_multi_source" must NEVER be auto-assigned by
 *     internet_watch.
 */

import type { ExternalSearchResult } from "./externalRealitySearchProvider.ts";

export type ExternalEventVerificationStatus =
  | "source_backed_unverified"
  | "ai_unverified"
  | "manual_verified"
  | "rejected";

export interface NormalizedExternalEvent {
  event_title: string;
  event_type: string;
  event_summary: string;
  source_url: string;
  source_title: string;
  source_name: string | null;
  source_published_at: string | null;
  provider: string;
  fetched_at: string;
  search_query: string;
  related_part_name: string | null;
  related_sensitivity_id: string | null;
  sensitivity_kind: string | null;
  child_exposure_risk: "low" | "medium" | "high";
  graphic_content_risk: "low" | "medium" | "high";
  verification_status: ExternalEventVerificationStatus;
  confidence: number;
  evidence_level: "low" | "medium" | "high";
  dedupe_key: string;
  semantic_dedupe_key: string;
}

export interface NormalizationContext {
  partName: string | null;
  partId?: string | null;
  sensitivityId?: string | null;
  sensitivityKind?: string | null;
  inferredEventType?: string | null;
  childExposureRisk?: "low" | "medium" | "high";
  graphicContentRisk?: "low" | "medium" | "high";
  /** When true the snippet was AI-generated from sources (not raw). */
  aiSummarized?: boolean;
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function normalizeExternalSearchResultToEvent(
  result: ExternalSearchResult,
  ctx: NormalizationContext,
): Promise<NormalizedExternalEvent> {
  if (!result.url || !/^https?:\/\//i.test(result.url)) {
    throw new Error("normalize_requires_real_url");
  }
  const partName = ctx.partName ?? null;
  const sensKind = ctx.sensitivityKind ?? null;
  const eventType = ctx.inferredEventType ?? "other";
  const child = ctx.childExposureRisk ?? "medium";
  const graphic = ctx.graphicContentRisk ?? "low";

  const verification: ExternalEventVerificationStatus = ctx.aiSummarized
    ? "ai_unverified"
    : "source_backed_unverified";

  const dedupeBase =
    `${result.provider}::${result.url}::${partName ?? "_"}::${sensKind ?? "_"}`;
  const semanticBase =
    `${normalizeTitle(result.title ?? "")}::${partName ?? "_"}::${sensKind ?? "_"}`;
  const [dedupe_key, semantic_dedupe_key] = await Promise.all([
    sha256Hex(dedupeBase),
    sha256Hex(semanticBase),
  ]);

  const summary = (result.snippet ?? "").trim().slice(0, 500) ||
    `Zdroj: ${result.source_name ?? new URL(result.url).hostname}. Téma: ${result.title}`;

  return {
    event_title: (result.title ?? "").trim().slice(0, 240) || result.url,
    event_type: eventType,
    event_summary: summary,
    source_url: result.url,
    source_title: (result.title ?? "").trim().slice(0, 240) || result.url,
    source_name: result.source_name ?? null,
    source_published_at: result.published_at ?? null,
    provider: result.provider,
    fetched_at: result.fetched_at,
    search_query: result.query,
    related_part_name: partName,
    related_sensitivity_id: ctx.sensitivityId ?? null,
    sensitivity_kind: sensKind,
    child_exposure_risk: child,
    graphic_content_risk: graphic,
    verification_status: verification,
    confidence: ctx.aiSummarized ? 0.4 : 0.6,
    evidence_level: "low",
    dedupe_key,
    semantic_dedupe_key,
  };
}
