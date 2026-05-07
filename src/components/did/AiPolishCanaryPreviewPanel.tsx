/**
 * AiPolishCanaryPreviewPanel — P31.2C
 *
 * READ-ONLY audit preview pro poslední AI polish canary běh
 * navázaný na aktuální briefing. NIKDY nepublikuje, nepřepisuje
 * ani nezapisuje. Hlavní text Karlova přehledu zůstává deterministic
 * `payload.karel_human_briefing.sections[].karel_text`.
 *
 * Pravidla:
 *  - Pouze SELECT z `p31_ai_polish_canary_runs`.
 *  - Žádné .insert/.update/.delete/.upsert/.rpc/.functions.invoke.
 *  - Žádné tlačítko publish/accept/replace/save.
 *  - Rejected kandidáti se NEzobrazují jako primární text — pouze
 *    v collapsed `<details>` jako audit-only.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";

interface CanarySection {
  section_id?: string;
  polish_status?: string;
  warnings?: string[];
  unsupported_claims_count?: number;
  robotic_phrase_count?: number;
  original_text?: string;
  polished_text?: string;
}

interface CanaryRow {
  id: string;
  briefing_id: string | null;
  status: string;
  attempted: boolean;
  accepted_candidate_count: number;
  rejected_candidate_count: number;
  unsupported_claims_count: number;
  robotic_phrase_count: number;
  meaning_drift_count: number;
  model: string | null;
  sections: CanarySection[];
  errors: unknown;
  created_at: string;
}

const KNOWN_STATUSES = new Set([
  "accepted_candidate",
  "partial_candidates",
  "rejected_all",
  "provider_error",
  "validation_failed",
  "disabled",
  "provider_not_configured",
]);

interface Props {
  briefingId: string | null | undefined;
  humanOk: boolean;
}

export default function AiPolishCanaryPreviewPanel({ briefingId, humanOk }: Props) {
  const [row, setRow] = useState<CanaryRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!briefingId || !humanOk) {
      setRow(null);
      setLoaded(false);
      return;
    }
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("p31_ai_polish_canary_runs")
        .select(
          "id, briefing_id, status, attempted, accepted_candidate_count, rejected_candidate_count, unsupported_claims_count, robotic_phrase_count, meaning_drift_count, model, sections, errors, created_at",
        )
        .eq("briefing_id", briefingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setRow((data as unknown as CanaryRow) ?? null);
      setLoading(false);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [briefingId, humanOk]);

  if (!briefingId || !humanOk) return null;

  const statusKnown = row ? KNOWN_STATUSES.has(row.status) : true;

  return (
    <details
      className="mt-2 rounded-md border border-border/40 bg-muted/10"
      data-testid="ai-polish-canary-preview"
    >
      <summary className="cursor-pointer px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
        AI polish náhled — pouze audit
      </summary>
      <div className="px-3 py-2 space-y-3">
        {loading && (
          <p className="text-[11px] text-muted-foreground italic">Načítám…</p>
        )}
        {!loading && loaded && !row && (
          <p
            className="text-[11px] text-muted-foreground italic"
            data-testid="ai-polish-canary-empty"
          >
            Žádný canary běh pro tento briefing.
          </p>
        )}
        {row && !statusKnown && (
          <p className="text-[11px] text-amber-700 italic" data-testid="ai-polish-canary-unknown-status">
            Unknown canary status — not shown as usable.
          </p>
        )}
        {row && statusKnown && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <Badge variant="outline">status: {row.status}</Badge>
              <Badge variant="outline">attempted: {String(row.attempted)}</Badge>
              <Badge variant="outline">accepted: {row.accepted_candidate_count}</Badge>
              <Badge variant="outline">rejected: {row.rejected_candidate_count}</Badge>
              <Badge variant="outline">unsupported: {row.unsupported_claims_count}</Badge>
              <Badge variant="outline">robotic: {row.robotic_phrase_count}</Badge>
              <Badge variant="outline">drift: {row.meaning_drift_count}</Badge>
              {row.model && <Badge variant="outline">model: {row.model}</Badge>}
              <Badge variant="outline">{new Date(row.created_at).toLocaleString()}</Badge>
            </div>

            {row.status === "provider_error" && (
              <p className="text-[11px] text-orange-700 italic" data-testid="ai-polish-canary-provider-error">
                Provider error — audit only, polished text není použitelný.
              </p>
            )}

            {row.accepted_candidate_count === 0 && (
              <p className="text-[11px] text-muted-foreground italic" data-testid="ai-polish-canary-no-accepted">
                No accepted AI polish candidate.
              </p>
            )}

            <div className="space-y-2">
              {(row.sections || []).map((s, i) => {
                const polishStatus = s.polish_status || "unknown";
                const accepted = polishStatus === "accepted_candidate";
                const unsupported = (s.unsupported_claims_count || 0) > 0;
                const robotic = (s.robotic_phrase_count || 0) > 0;
                const safeAccepted = accepted && !unsupported && !robotic;
                return (
                  <div
                    key={s.section_id || i}
                    className={`rounded border p-2 ${
                      safeAccepted
                        ? "border-emerald-300/50 bg-emerald-50/30"
                        : "border-orange-300/50 bg-orange-50/20"
                    }`}
                    data-testid={`ai-polish-canary-section-${s.section_id || i}`}
                    data-polish-status={polishStatus}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] mb-1">
                      <span className="font-medium">{s.section_id || `section ${i}`}</span>
                      {safeAccepted ? (
                        <Badge className="bg-emerald-600 text-white">candidate accepted by validator</Badge>
                      ) : (
                        <Badge className="bg-orange-600 text-white">rejected — do not use</Badge>
                      )}
                      {(s.warnings || []).map((w, wi) => (
                        <Badge key={wi} variant="outline">{w}</Badge>
                      ))}
                    </div>
                    <div className="text-[12px] space-y-1">
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground">deterministic</div>
                        <p className="whitespace-pre-line text-foreground/85">{s.original_text || ""}</p>
                      </div>
                      {safeAccepted ? (
                        <div data-testid={`ai-polish-canary-accepted-side-${s.section_id || i}`}>
                          <div className="text-[10px] uppercase text-muted-foreground">candidate</div>
                          <p className="whitespace-pre-line text-foreground/85">{s.polished_text || ""}</p>
                        </div>
                      ) : (
                        <details className="mt-1" data-testid={`ai-polish-canary-rejected-collapsed-${s.section_id || i}`}>
                          <summary className="cursor-pointer text-[10px] uppercase text-orange-700">
                            Rejected candidate — audit only
                          </summary>
                          <p className="whitespace-pre-line text-foreground/60 mt-1">
                            {s.polished_text || ""}
                          </p>
                        </details>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
