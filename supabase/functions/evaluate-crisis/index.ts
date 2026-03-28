import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function callGemini(system: string, user: string): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(timer); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const { crisisId, sessionSummary, forcePhaseChange } = await req.json();
    if (!crisisId) return new Response(JSON.stringify({ error: "crisisId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: crisis, error: crisisErr } = await sb.from("crisis_events").select("*").eq("id", crisisId).single();
    if (crisisErr || !crisis) return new Response(JSON.stringify({ error: "Crisis not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: logs } = await sb.from("crisis_session_logs").select("*").eq("crisis_id", crisisId).order("session_date", { ascending: true });

    // Handle forced phase change
    if (forcePhaseChange && ["acute", "stabilizing", "diagnostic", "closing"].includes(forcePhaseChange)) {
      await sb.from("crisis_events").update({
        phase: forcePhaseChange,
        updated_at: new Date().toISOString(),
        ...(forcePhaseChange === "closing" ? { closure_proposed_at: new Date().toISOString() } : {}),
      }).eq("id", crisisId);

      if (forcePhaseChange === "diagnostic") {
        await sb.from("planned_sessions").insert({
          part_name: crisis.part_name,
          therapist: "karel",
          method_name: "Diagnostický krizový rozhovor",
          priority: "urgent",
          description: "Karel provede diagnostický rozhovor pro vyhodnocení krizového stavu",
          horizon: "short",
        });
      }

      return new Response(JSON.stringify({ success: true, phase: forcePhaseChange, forced: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const logsText = (logs || []).map(l =>
      `[${l.session_date}] ${l.session_type}\nEmoční regulace OK: ${l.emotional_regulation_ok}\nBezpečnost OK: ${l.safety_ok}\nKoherence: ${l.coherence_score}/10\nDůvěra: ${l.trust_level}/10\nZmínky o budoucnosti: ${l.future_mentions}\nShrnutí: ${l.summary || "—"}\nRizikové signály: ${(l.risk_signals || []).join(", ") || "—"}\nPozitivní signály: ${(l.positive_signals || []).join(", ") || "—"}`
    ).join("\n\n");

    const prompt = `Jsi Karel — klinický psycholog hodnotící průběh krizového stavu části DID systému.

AKTUÁLNÍ KRIZE:
Část: ${crisis.part_name}
Fáze: ${crisis.phase}
Severity: ${crisis.severity}
Popis: ${crisis.trigger_description}
Otevřena: ${crisis.opened_at}
Počet sezení: ${crisis.sessions_count}
Dní aktivní: ${crisis.days_active}

HISTORIE SEZENÍ:
${logsText || "(žádná sezení)"}

NOVÉ SEZENÍ:
${sessionSummary || "(žádné nové sezení)"}

PRAVIDLA HODNOCENÍ:
1. AKUTNÍ → STABILIZACE: Pokud 3+ po sobě jdoucí sezení kde emotional_regulation_ok=true, safety_ok=true, coherence_score>=6 → navrhni 'stabilizing'
2. STABILIZACE → DIAGNOSTIKA: Pokud 3+ po sobě jdoucí sezení kde VŠECH 5 indikátorů v normě, žádné risk_signals, 2+ positive_signals → navrhni 'diagnostic'
3. DIAGNOSTIKA → UZAVŘENÍ: Pokud diagnostický rozhovor proběhl a celkové skóre >= 65/100 → navrhni 'closing'
4. RELAPS: Pokud v JAKÉKOLI fázi se objeví safety_ok=false, coherence_score<4, nový risk_signal typu self-harm/agrese → navrhni návrat do 'acute'

VÝSTUP (JSON):
{
  "current_assessment": "popis aktuálního stavu",
  "indicators": { "emotional_regulation": 0-10, "safety": 0-10, "coherence": 0-10, "trust": 0-10, "time_orientation": 0-10 },
  "phase_recommendation": "acute|stabilizing|diagnostic|closing|no_change",
  "phase_reason": "důvod",
  "severity_recommendation": "medium|high|critical|no_change",
  "risk_level": "low|medium|high|critical",
  "next_steps": ["krok 1", "krok 2"],
  "diagnostic_needed": true/false,
  "sessions_until_review": číslo,
  "message_for_therapists": "text pro Hanku a Káťu"
}`;

    const raw = await callGemini("Jsi Karel, klinický psycholog. Odpovídej POUZE JSON.", prompt);
    let result: any = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) result = JSON.parse(m[0]);
    } catch { result = { phase_recommendation: "no_change", indicators: {} }; }

    const indicators = result.indicators || {};
    const updates: any = {
      indicator_emotional_regulation: indicators.emotional_regulation ?? crisis.indicator_emotional_regulation,
      indicator_safety: indicators.safety ?? crisis.indicator_safety,
      indicator_coherence: indicators.coherence ?? crisis.indicator_coherence,
      indicator_trust: indicators.trust ?? crisis.indicator_trust,
      indicator_time_orientation: indicators.time_orientation ?? crisis.indicator_time_orientation,
      sessions_count: (crisis.sessions_count || 0) + (sessionSummary ? 1 : 0),
      days_active: Math.ceil((Date.now() - new Date(crisis.opened_at).getTime()) / 86400000),
      updated_at: new Date().toISOString(),
    };

    const newPhase = result.phase_recommendation;
    if (newPhase && newPhase !== "no_change") {
      updates.phase = newPhase;
      // Reset banner dismiss on phase change
      updates.banner_dismissed = false;
      updates.banner_dismissed_at = null;
    }

    if (result.severity_recommendation && result.severity_recommendation !== "no_change") {
      updates.severity = result.severity_recommendation;
      // Reset banner dismiss on severity change
      updates.banner_dismissed = false;
      updates.banner_dismissed_at = null;
    }

    await sb.from("crisis_events").update(updates).eq("id", crisisId);

    // Create diagnostic session if recommended
    if (newPhase === "diagnostic") {
      await sb.from("planned_sessions").insert({
        part_name: crisis.part_name,
        therapist: "karel",
        method_name: "Diagnostický krizový rozhovor",
        priority: "urgent",
        description: "Karel provede diagnostický rozhovor pro vyhodnocení krizového stavu",
        horizon: "short",
      });
    }

    // Send email if closing proposed
    if (newPhase === "closing") {
      updates.closure_proposed_at = new Date().toISOString();
      await sb.from("crisis_events").update({ closure_proposed_at: new Date().toISOString() }).eq("id", crisisId);

      try {
        const { Resend } = await import("npm:resend@2.0.0");
        const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
        const kataEmail = Deno.env.get("KATA_EMAIL") || "";
        if (kataEmail) {
          await resend.emails.send({
            from: "Karel <onboarding@resend.dev>",
            to: [kataEmail],
            subject: `Karel navrhuje uzavření krize — ${crisis.part_name}`,
            html: `<h2>Návrh uzavření krize</h2>
<p><strong>Část:</strong> ${crisis.part_name}</p>
<p><strong>Diagnostické skóre:</strong> ${crisis.diagnostic_score || "N/A"}/100</p>
<p><strong>Důvod:</strong> ${result.phase_reason || "Podmínky splněny"}</p>
<p>Prosím potvrďte v administraci.</p>`,
          });
        }
      } catch (emailErr) {
        console.warn("[evaluate-crisis] Email error:", emailErr);
      }
    }

    // Log session if summary provided
    if (sessionSummary) {
      await sb.from("crisis_session_logs").insert({
        crisis_id: crisisId,
        session_type: "therapeutic",
        emotional_regulation_ok: (indicators.emotional_regulation ?? 0) >= 6,
        safety_ok: (indicators.safety ?? 0) >= 6,
        coherence_score: indicators.coherence ?? 5,
        trust_level: indicators.trust ?? 5,
        future_mentions: (indicators.time_orientation ?? 0) >= 5,
        summary: sessionSummary?.slice(0, 2000),
        karel_notes: result.current_assessment?.slice(0, 2000),
        risk_signals: result.next_steps?.filter((s: string) => /rizik|nebezpeč|self.?harm/i.test(s)) || [],
        positive_signals: result.next_steps?.filter((s: string) => /pozitiv|zlepš|stabiliz/i.test(s)) || [],
      });
    }

    return new Response(JSON.stringify({ success: true, ...result, phase: updates.phase || crisis.phase }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[evaluate-crisis] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
