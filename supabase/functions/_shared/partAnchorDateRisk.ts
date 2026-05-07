/**
 * P30.3 — Anchor date / anniversary risk in Prague-local time.
 */

import type { PartPersonalTriggerProfile } from "./partPersonalTriggerProfile.ts";
import type { PartExternalAnchorFact } from "./partAnchorFactDiscovery.ts";

export interface DateRiskInput {
  datePrague: string; // YYYY-MM-DD
  profile: PartPersonalTriggerProfile;
  anchorFacts: PartExternalAnchorFact[];
  lookaheadDays?: number;
}

export interface PartDateRiskResult {
  part_name: string;
  date_prague: string;
  risk_level: "none" | "low" | "medium" | "high";
  matched_dates: Array<{
    date: string;
    date_type: string;
    days_from_today: number;
    anchor_label: string;
    source_ref: string;
    verification_status: string;
  }>;
  recommended_guard: string;
  should_surface_in_briefing: boolean;
}

function diffDays(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T12:00:00Z`).getTime();
  const b = new Date(`${bIso}T12:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

export function evaluatePartAnchorDateRisk(
  input: DateRiskInput,
): PartDateRiskResult {
  const matched: PartDateRiskResult["matched_dates"] = [];

  // Walk known_dates from profile
  for (const a of input.profile.biographical_anchors) {
    for (const d of a.known_dates) {
      const days = Math.abs(diffDays(d.date, input.datePrague));
      if (days <= 7) {
        matched.push({
          date: d.date,
          date_type: d.date_type,
          days_from_today: diffDays(d.date, input.datePrague),
          anchor_label: a.anchor_label,
          source_ref: d.source_ref,
          verification_status: d.verification_status,
        });
      }
    }
  }

  // Walk anchor fact cache
  for (const f of input.anchorFacts) {
    if (!f.fact_date) continue;
    const days = Math.abs(diffDays(f.fact_date, input.datePrague));
    if (days <= 7) {
      matched.push({
        date: f.fact_date,
        date_type: f.fact_type,
        days_from_today: diffDays(f.fact_date, input.datePrague),
        anchor_label: f.anchor_label,
        source_ref: f.source_url,
        verification_status: f.verification_status,
      });
    }
  }

  let risk: PartDateRiskResult["risk_level"] = "none";
  for (const m of matched) {
    const d = Math.abs(m.days_from_today);
    if (d === 0) risk = "high";
    else if (d <= 3 && risk !== "high") risk = "medium";
    else if (d <= 7 && risk === "none") risk = "low";
  }

  return {
    part_name: input.profile.part_name,
    date_prague: input.datePrague,
    risk_level: risk,
    matched_dates: matched,
    recommended_guard: matched.length
      ? "Možné citlivostní okno — bez explicitních detailů, držet bezpečí, sledovat tělesnou reakci."
      : "",
    should_surface_in_briefing: risk !== "none",
  };
}
