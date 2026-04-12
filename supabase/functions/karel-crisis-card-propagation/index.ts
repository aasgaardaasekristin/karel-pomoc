import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * karel-crisis-card-propagation
 *
 * Propaguje krizové poznatky do karty části.
 * Zdroje: interview completion, post-session analysis, state transitions, closure.
 *
 * Používá karel-did-card-update (append mode) pro zápis na Drive.
 * Deduplikuje přes did_doc_sync_log.
 */

type PropagationSource =
  | "interview_completed"
  | "post_session_analysis"
  | "state_transition"
  | "closure_summary";

interface PropagationRequest {
  crisis_event_id: string;
  part_name: string;
  source: PropagationSource;
  source_id?: string; // interview_id, assessment_id, etc.
  data: Record<string, any>;
}

// ═══════════════════════════════════════════════════════
// STRUCTURED CLINICAL ENTRY BUILDERS
// ═══════════════════════════════════════════════════════

function buildInterviewEntry(data: Record<string, any>, dateStr: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines: string[] = [];

  // Section E — Chronologický log
  const eLine = [
    `${dateStr} | KRIZOVÝ ROZHOVOR (${data.interview_type || "diagnostic"})`,
    data.interview_goal ? ` | Cíl: ${data.interview_goal}` : "",
    ` | Rozhodnutí: ${data.karel_decision_after_interview || "?"}`,
    data.what_shifted ? ` | Posun: ${data.what_shifted}` : "",
  ].join("");
  sections.E = eLine;

  // Section F — Poznámky pro Karla
  const fParts: string[] = [];
  if (data.what_remains_unclear) fParts.push(`⚠️ Nejasné: ${data.what_remains_unclear}`);
  if (data.observed_risk_signals?.length) fParts.push(`🔴 Rizikové signály: ${data.observed_risk_signals.join(", ")}`);
  if (data.hidden_diagnostic_hypotheses?.length) {
    fParts.push(`❓ Hypotézy: ${data.hidden_diagnostic_hypotheses.map((h: any) => typeof h === "string" ? h : h.text || JSON.stringify(h)).join("; ")}`);
  }
  if (fParts.length > 0) sections.F = `[Krizový rozhovor ${dateStr}]\n${fParts.join("\n")}`;

  // Section D — Terapeutická doporučení (stabilization methods)
  if (data.stabilization_methods_used?.length) {
    sections.D = `[Krizový rozhovor ${dateStr}] Použité stabilizační metody: ${data.stabilization_methods_used.join(", ")}`;
  }

  // Section M — Karlova analytická poznámka
  const mParts: string[] = [`[Krizový rozhovor ${dateStr}]`];
  if (data.summary_for_team) mParts.push(data.summary_for_team);
  if (data.observed_regulation != null) mParts.push(`Regulace: ${data.observed_regulation}/10`);
  if (data.observed_trust != null) mParts.push(`Důvěra: ${data.observed_trust}/10`);
  if (data.observed_coherence != null) mParts.push(`Koherence: ${data.observed_coherence}/10`);
  if (data.observed_somatic_state) mParts.push(`Somatika: ${data.observed_somatic_state}`);
  mParts.push(`Rozhodnutí: ${data.karel_decision_after_interview || "?"}`);
  sections.M = mParts.join("\n");

  // Section C — Potřeby/strachy/konflikty (risk signals as triggers)
  if (data.observed_risk_signals?.length) {
    sections.C = `[Krizový rozhovor ${dateStr}] Pozorované rizikové signály: ${data.observed_risk_signals.join(", ")}`;
  }

  return sections;
}

function buildPostSessionEntry(data: Record<string, any>, dateStr: string): Record<string, string> {
  const sections: Record<string, string> = {};

  // Section E — log
  const effectiveness = data.intervention_effectiveness || "?";
  const trend = data.stabilization_trend || "?";
  sections.E = `${dateStr} | POST-SESSION ANALÝZA | Efektivita: ${effectiveness} | Trend: ${trend}`;

  // Section M — Karlova poznámka
  const mParts: string[] = [`[Post-session analýza ${dateStr}]`];
  if (data.main_risk) mParts.push(`Hlavní riziko: ${data.main_risk}`);
  if (data.next_action) mParts.push(`Další krok: ${data.next_action}`);
  if (data.karel_recommendation) mParts.push(`Doporučení: ${data.karel_recommendation}`);
  if (data.what_worked) mParts.push(`Co fungovalo: ${data.what_worked}`);
  if (data.what_failed) mParts.push(`Co nefungovalo: ${data.what_failed}`);
  sections.M = mParts.join("\n");

  // Section D — therapeutic recommendation update
  if (data.what_worked || data.what_failed) {
    const dParts: string[] = [`[Post-session ${dateStr}]`];
    if (data.what_worked) dParts.push(`✓ Funguje: ${data.what_worked}`);
    if (data.what_failed) dParts.push(`✗ Nefunguje: ${data.what_failed}`);
    sections.D = dParts.join("\n");
  }

  return sections;
}

function buildStateTransitionEntry(data: Record<string, any>, dateStr: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const from = data.from_state || "?";
  const to = data.to_state || "?";
  const reason = data.reason || "";

  sections.E = `${dateStr} | STAV KRIZE: ${from} → ${to}${reason ? ` | ${reason}` : ""}`;

  if (data.trigger_update) {
    sections.C = `[Stav krize ${dateStr}] Trigger: ${data.trigger_update}`;
  }

  if (to === "stabilizing" || to === "ready_for_joint_review") {
    sections.M = `[${dateStr}] Krize přechází do stavu "${to}". ${reason}`;
  }

  return sections;
}

function buildClosureEntry(data: Record<string, any>, dateStr: string): Record<string, string> {
  const sections: Record<string, string> = {};

  // Section E — final log
  sections.E = `${dateStr} | UZAVŘENÍ KRIZE | Trvání: ${data.days_active || "?"} dní | Výsledek: ${data.closure_reason || "stabilizace"}`;

  // Section M — comprehensive closure note
  const mParts: string[] = [`[UZAVŘENÍ KRIZE ${dateStr}]`];
  if (data.closure_statement) mParts.push(data.closure_statement);
  if (data.clinical_summary) mParts.push(`Klinický souhrn: ${data.clinical_summary}`);
  if (data.trigger_description) mParts.push(`Trigger: ${data.trigger_description}`);
  if (data.what_worked_overall) mParts.push(`Co fungovalo: ${data.what_worked_overall}`);
  if (data.what_to_watch) mParts.push(`Na co dávat pozor: ${data.what_to_watch}`);
  mParts.push(`Doporučení pro další práci: ${data.recommendation_for_future || "Sledovat stabilitu, preventivně pracovat s triggery."}`);
  sections.M = mParts.join("\n");

  // Section H — long-term goals update if applicable
  if (data.new_goal) {
    sections.H = `[Po krizi ${dateStr}] ${data.new_goal}`;
  }

  // Section F — notes for Karel
  if (data.what_to_watch) {
    sections.F = `[Po krizi ${dateStr}] ⚠️ Sledovat: ${data.what_to_watch}`;
  }

  return sections;
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, srvKey);

  try {
    const body: PropagationRequest = await req.json();
    const { crisis_event_id, part_name, source, source_id, data } = body;

    if (!crisis_event_id || !part_name || !source) {
      return jsonRes({ error: "crisis_event_id, part_name, and source required" }, 400);
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // ── Deduplication ────────────────────────────────────
    const dedupKey = `crisis_card_${crisis_event_id}_${source}_${source_id || dateStr}`;
    const { data: existing } = await sb
      .from("did_doc_sync_log")
      .select("id")
      .eq("source_type", "crisis_card_propagation")
      .eq("source_id", dedupKey)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[crisis-card-prop] Dedup hit: ${dedupKey}`);
      return jsonRes({ success: true, skipped: true, reason: "already_propagated", dedup_key: dedupKey });
    }

    // ── Build structured entry ───────────────────────────
    let sections: Record<string, string>;
    switch (source) {
      case "interview_completed":
        sections = buildInterviewEntry(data, dateStr);
        break;
      case "post_session_analysis":
        sections = buildPostSessionEntry(data, dateStr);
        break;
      case "state_transition":
        sections = buildStateTransitionEntry(data, dateStr);
        break;
      case "closure_summary":
        sections = buildClosureEntry(data, dateStr);
        break;
      default:
        return jsonRes({ error: `Unknown source: ${source}` }, 400);
    }

    // Filter empty sections
    const nonEmpty = Object.fromEntries(
      Object.entries(sections).filter(([_, v]) => v && v.trim() !== "")
    );

    if (Object.keys(nonEmpty).length === 0) {
      console.log(`[crisis-card-prop] No content to propagate for ${part_name} (${source})`);
      return jsonRes({ success: true, skipped: true, reason: "no_content" });
    }

    // ── Write to card via karel-did-card-update ──────────
    console.log(`[crisis-card-prop] Propagating ${source} → ${part_name}, sections: ${Object.keys(nonEmpty).join(",")}`);

    const { data: writeResult, error: writeErr } = await sb.functions.invoke("karel-did-card-update", {
      body: { partName: part_name, sections: nonEmpty },
      headers: { Authorization: `Bearer ${srvKey}` },
    });

    if (writeErr) {
      console.error(`[crisis-card-prop] Card write error:`, writeErr);
      // Log failure but don't throw — card write is non-blocking
      await sb.from("did_doc_sync_log").insert({
        source_type: "crisis_card_propagation",
        source_id: dedupKey,
        target_document: `card_${part_name}`,
        content_written: `FAILED: ${String(writeErr)}`,
        success: false,
      });
      return jsonRes({ success: false, error: "Card write failed", details: String(writeErr) }, 500);
    }

    // ── Also write profile claims for key observations ───
    const claims = buildProfileClaims(source, data, part_name, dateStr);
    for (const claim of claims) {
      try {
        await sb.functions.invoke("update-part-profile", {
          body: { partName: part_name, claims: [claim] },
          headers: { Authorization: `Bearer ${srvKey}` },
        });
      } catch (claimErr) {
        console.warn(`[crisis-card-prop] Profile claim error (non-fatal):`, claimErr);
      }
    }

    // ── Dedup record ─────────────────────────────────────
    await sb.from("did_doc_sync_log").insert({
      source_type: "crisis_card_propagation",
      source_id: dedupKey,
      target_document: `card_${part_name}`,
      content_written: `${source}: sections ${Object.keys(nonEmpty).join(",")} (${JSON.stringify(nonEmpty).length} chars)`,
      success: true,
    });

    console.log(`[crisis-card-prop] ✅ ${part_name} updated from ${source}`);

    return jsonRes({
      success: true,
      part_name,
      source,
      sections_written: Object.keys(nonEmpty),
      dedup_key: dedupKey,
      card_write_result: writeResult,
      profile_claims_count: claims.length,
    });

  } catch (err) {
    console.error("[crisis-card-prop] Error:", err);
    return jsonRes({ error: String(err) }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// PROFILE CLAIMS BUILDER
// ═══════════════════════════════════════════════════════

function buildProfileClaims(source: PropagationSource, data: Record<string, any>, partName: string, dateStr: string): any[] {
  const claims: any[] = [];

  if (source === "interview_completed") {
    if (data.observed_risk_signals?.length) {
      claims.push({
        card_section: "C",
        claim_type: "risk",
        claim_text: `[Krize ${dateStr}] Rizikové signály: ${data.observed_risk_signals.join(", ")}`,
        evidence_level: "D2",
        confidence: 0.8,
      });
    }
    if (data.stabilization_methods_used?.length) {
      for (const method of data.stabilization_methods_used.slice(0, 3)) {
        claims.push({
          card_section: "D",
          claim_type: "therapeutic_response",
          claim_text: `[Krize ${dateStr}] Stabilizační metoda: ${method}`,
          evidence_level: "D2",
          confidence: 0.7,
        });
      }
    }
  }

  if (source === "post_session_analysis") {
    if (data.what_worked) {
      claims.push({
        card_section: "D",
        claim_type: "therapeutic_response",
        claim_text: `[Krize ${dateStr}] Funguje: ${data.what_worked}`,
        evidence_level: "D2",
        confidence: 0.75,
      });
    }
    if (data.what_failed) {
      claims.push({
        card_section: "D",
        claim_type: "therapeutic_response",
        claim_text: `[Krize ${dateStr}] Nefunguje: ${data.what_failed}`,
        evidence_level: "D2",
        confidence: 0.75,
      });
    }
  }

  return claims;
}

// ═══════════════════════════════════════════════════════

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
