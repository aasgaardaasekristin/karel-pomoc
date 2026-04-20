import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";
import { routeWrite, buildAuditEntry, type GovernanceRequest } from "../_shared/documentGovernance.ts";

/**
 * approve-crisis-closure — v3
 *
 * Tvrdý closure protocol:
 * 1. Ověří 4-vrstvou closure readiness přes karel-crisis-closure-meeting
 * 2. Vyžaduje closure meeting + Karel statement
 * 3. Teprve pak uzavře krizi
 * 4. Closure summary se rozdělí do správných sekcí karty (E, M, D)
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, srvKey);

  try {
    const { crisisId, approver } = await req.json();
    if (!crisisId || !approver) {
      return jsonRes({ error: "crisisId and approver required" }, 400);
    }
    if (!["hanka", "kata"].includes(approver)) {
      return jsonRes({ error: "approver must be hanka or kata" }, 400);
    }

    const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisisId).single();
    if (!crisis) return jsonRes({ error: "Crisis not found" }, 404);

    // ── Check closure readiness via closure-meeting function ──
    const { data: readiness, error: readinessErr } = await sb.functions.invoke("karel-crisis-closure-meeting", {
      body: { action: "check_closure_readiness", crisis_event_id: crisisId },
      headers: { Authorization: `Bearer ${srvKey}` },
    });

    if (readinessErr) {
      console.error("[approve-closure] Readiness check failed:", readinessErr);
    }

    const approved = crisis.closure_approved_by || [];
    if (approved.includes(approver)) {
      return jsonRes({ error: "Already approved by this person" }, 400);
    }

    const newApproved = [...approved, approver];

    // ── Record approval ──
    await sb.from("crisis_events").update({
      closure_approved_by: newApproved,
      updated_at: new Date().toISOString(),
    }).eq("id", crisisId);

    // ── Submit position to closure meeting if exists ──
    if (crisis.closure_meeting_id) {
      try {
        await sb.functions.invoke("karel-crisis-closure-meeting", {
          body: {
            action: "submit_position",
            meeting_id: crisis.closure_meeting_id,
            therapist: approver,
            position: `Souhlasím s uzavřením krize (${new Date().toISOString().slice(0, 10)})`,
          },
          headers: { Authorization: `Bearer ${srvKey}` },
        });
      } catch (e) {
        console.warn("[approve-closure] Position submit error:", e);
      }
    }

    // ── Check if we can actually close ──
    const bothApproved = newApproved.includes("hanka") && newApproved.includes("kata");
    const hasKarelStatement = crisis.closure_statement != null;
    const hasClosureMeeting = crisis.closure_meeting_id != null;
    const canClose = bothApproved && hasKarelStatement && hasClosureMeeting;

    if (canClose) {
      // Use state machine for proper transition
      const { data: transResult, error: transErr } = await sb.functions.invoke("karel-crisis-closure-meeting", {
        body: {
          action: "transition_state",
          crisis_event_id: crisisId,
          target_state: "closed",
          reason: `Schváleno: ${newApproved.join(", ")}. Diagnostické skóre: ${crisis.diagnostic_score || "N/A"}/100`,
        },
        headers: { Authorization: `Bearer ${srvKey}` },
      });

      if (transErr) {
        console.warn("[approve-closure] State transition blocked:", transErr);
        return jsonRes({
          success: true,
          closed: false,
          approvedBy: newApproved,
          blocked_reason: "State machine blocked closure — check readiness",
          readiness: readiness || null,
        });
      }

      // Finalize closure meeting
      if (crisis.closure_meeting_id) {
        await sb.from("did_meetings").update({
          status: "finalized",
          finalized_at: new Date().toISOString(),
          outcome_summary: `Krize ${crisis.part_name} uzavřena. Trvání: ${crisis.days_active || "?"} dní.`,
        }).eq("id", crisis.closure_meeting_id);
      }

      // Update crisis with full closure data
      await sb.from("crisis_events").update({
        closure_approved_at: new Date().toISOString(),
        closure_reason: `Schváleno: ${newApproved.join(", ")}. Diagnostické skóre: ${crisis.diagnostic_score || "N/A"}/100`,
        updated_at: new Date().toISOString(),
      }).eq("id", crisisId);

      // Downgrade urgency in planned_sessions
      await sb.from("planned_sessions")
        .update({ priority: "normal" })
        .eq("part_name", crisis.part_name)
        .eq("priority", "urgent");

      // ── Propagate closure summary to part card — SPLIT INTO E, M, D ──
      try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const partName = crisis.part_name;

        // SECTION E — Chronologický log: co se stalo, průběh
        const closureChronology = [
          `## Uzavření krize — ${dateStr}`,
          `- **Trvání:** ${crisis.days_active || "?"} dní, ${crisis.sessions_count || "?"} sezení`,
          `- **Závažnost:** ${crisis.severity}`,
          `- **Trigger:** ${crisis.trigger_description || "nespecifikován"}`,
          `- **Schváleno:** ${newApproved.join(", ")}`,
          crisis.clinical_summary ? `- **Průběh:** ${crisis.clinical_summary.slice(0, 800)}` : null,
        ].filter(Boolean).join("\n");

        // SECTION M — Karlova analytická poznámka: závěr, co fungovalo/nefungovalo
        const closureAnalysis = crisis.closure_statement
          ? [
              `## Karlův závěr krize — ${dateStr}`,
              crisis.closure_statement.slice(0, 1000),
              `- **Diagnostické skóre:** ${crisis.diagnostic_score || "N/A"}/100`,
            ].join("\n")
          : "";

        // SECTION D — Terapeutická doporučení: jen doporučení pro další práci
        const closureRecommendations = [
          `## Doporučení po krizi — ${dateStr}`,
          `- Přechod do monitorovacího režimu`,
          crisis.trigger_description
            ? `- Sledovat trigger: ${crisis.trigger_description.slice(0, 200)}`
            : null,
        ].filter(Boolean).join("\n");

        // Build sections object for card-update
        const sections: Record<string, string> = { E: closureChronology };
        if (closureAnalysis) sections["M"] = closureAnalysis;
        sections["D"] = closureRecommendations;

        await sb.functions.invoke("karel-did-card-update", {
          body: { partName, sections },
          headers: { Authorization: `Bearer ${srvKey}` },
        });

        // Audit each content type via governance
        const auditEntries = [
          { content_type: "closure_chronology" as const, payload: closureChronology, section: "E" },
          ...(closureAnalysis ? [{ content_type: "closure_analysis" as const, payload: closureAnalysis, section: "M" }] : []),
          { content_type: "closure_recommendations" as const, payload: closureRecommendations, section: "D" },
        ];

        for (const entry of auditEntries) {
          const govReq: GovernanceRequest = {
            source_type: "approve-crisis-closure",
            source_id: crisisId,
            content_type: entry.content_type,
            subject_type: "crisis",
            subject_id: partName,
            payload: entry.payload,
          };
          const govResult = routeWrite(govReq);
          const audit = buildAuditEntry(govReq, govResult, true);
          await sb.from("did_doc_sync_log").insert({
            ...audit,
            crisis_event_id: crisisId,
          });
        }
      } catch (cardErr) {
        console.warn("[approve-closure] Card propagation error:", cardErr);
        await sb.from("did_doc_sync_log").insert({
          source_type: "approve-crisis-closure",
          source_id: crisisId,
          // Audit-only sync_log entry — record the canonical KARTA_<PART> target name
          // so reports can attribute the failure to the correct Drive document.
          target_document: `KARTA_${String(crisis.part_name || "UNKNOWN").toUpperCase()}`,
          content_written: "",
          success: false,
          error_message: String(cardErr),
          sync_type: "closure_summary_sync",
          content_type: "closure_summary",
          subject_type: "crisis",
          subject_id: crisis.part_name,
          crisis_event_id: crisisId,
          status: "failed",
        });
      }

      // Send closure email
      try {
        const { Resend } = await import("https://esm.sh/resend@2.0.0");
        const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
        const kataEmail = Deno.env.get("KATA_EMAIL") || "";
        if (kataEmail) {
          await resend.emails.send({
            from: "Karel <onboarding@resend.dev>",
            to: [kataEmail],
            subject: `✅ Krize uzavřena — ${crisis.part_name}`,
            html: `<h2>Krize uzavřena</h2>
<p><strong>Část:</strong> ${crisis.part_name}</p>
<p><strong>Trvání:</strong> ${crisis.days_active} dní, ${crisis.sessions_count} sezení</p>
<p><strong>Diagnostické skóre:</strong> ${crisis.diagnostic_score || "N/A"}/100</p>
<p><strong>Schváleno:</strong> ${newApproved.join(", ")}</p>
<p>Část přechází do monitorovacího režimu.</p>`,
          });
        }
      } catch (emailErr) {
        console.warn("[approve-closure] Email error:", emailErr);
      }

      return jsonRes({ success: true, closed: true, approvedBy: newApproved });
    }

    // ── Not ready to close yet ──
    const missing: string[] = [];
    if (!newApproved.includes("hanka")) missing.push("Chybí souhlas Hanky");
    if (!newApproved.includes("kata")) missing.push("Chybí souhlas Káti");
    if (!hasKarelStatement) missing.push("Chybí Karlův finální statement");
    if (!hasClosureMeeting) missing.push("Closure meeting nebyl založen");

    return jsonRes({
      success: true,
      closed: false,
      approvedBy: newApproved,
      missing_for_closure: missing,
      readiness: readiness || null,
    });
  } catch (err) {
    console.error("[approve-closure] Error:", err);
    return jsonRes({ error: String(err) }, 500);
  }
});

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
