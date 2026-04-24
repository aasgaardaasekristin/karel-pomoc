import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { detectPlaybook, renderPlaybookForPrompt } from "../_shared/clinicalPlaybooks.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function extractLatency(text: string): number | null {
  const m = text.match(/(?:latence|pauza|čekal|cekal)[^0-9]{0,20}(\d{1,3})(?:\s*(?:s|sec|sek|sekund))/i)
    ?? text.match(/(\d{1,3})\s*(?:s|sec|sek|sekund)/i);
  return m ? Number(m[1]) : null;
}

function buildEvidenceRows(turns: Array<{ from: string; text: string }>, plannedSteps: string[]) {
  const rows: Array<{ stimulus: string; response: string; latency_s: number | null; evidence_quality: string }> = [];
  let pending: string | null = null;
  for (const t of turns) {
    const text = String(t.text ?? "");
    if (t.from === "karel") {
      const lower = text.toLowerCase();
      pending = plannedSteps.find((s) => lower.includes(s.toLowerCase())) ?? (text.length < 100 ? text.trim() : pending);
    } else if (t.from === "hana" && pending) {
      rows.push({
        stimulus: pending,
        response: text,
        latency_s: extractLatency(text),
        evidence_quality: text.length > 8 ? "verbatim_or_note_present" : "weak",
      });
      pending = null;
    }
  }
  return rows;
}

function renderFallback(methodId: string, rows: ReturnType<typeof buildEvidenceRows>, hasImage: boolean, hasAudio: boolean) {
  const missing: string[] = [];
  if (!rows.length) missing.push("verbatim odpovědi / průběhový log");
  if (rows.some((r) => r.latency_s === null)) missing.push("latence v sekundách u části odpovědí");
  if (!hasAudio && methodId === "association_experiment_jung") missing.push("audio nebo přesný verbatim+latency log");
  if (!hasImage && /draw|tree|htp|kfd|sandtray|body_map/.test(methodId)) missing.push("foto artefaktu");

  const table = rows.length
    ? rows.map((r, i) => `| ${i + 1} | ${r.stimulus} | ${r.response.replace(/\|/g, "/").slice(0, 180)} | ${r.latency_s ?? "chybí"} | ${r.latency_s !== null && r.latency_s > 8 ? "možný komplexový marker" : "nelze / běžné"} |`).join("\n")
    : "| - | - | - | - | nehodnotitelné |";

  return `### Diagnostická validita
${missing.length ? `Validita je omezená: chybí ${missing.join(", ")}.` : "Minimální datové podmínky jsou splněné pro orientační klinickou analýzu."}

### Důkazní tabulka
| # | Stimul | Odpověď / zápis | Latence | Marker |
|---|---|---|---|---|
${table}

### Klinický závěr
${missing.length ? "Z těchto dat nelze dělat plnohodnotný profesionální diagnostický závěr; lze formulovat pouze pracovní hypotézy pro další terapeutické ověření." : "Závěr je třeba držet jako klinickou hypotézu, nikoli jako standardizovanou psychodiagnostiku."}

### Co ověřit příště
- Doplnit přesný verbatim zápis a latence.
- Oddělit popis pozorování od interpretace.
- U kresbových/projektivních metod doplnit artefakt a post-test inquiry.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json().catch(() => ({}));
    const methodId = String(body.method_id ?? "");
    const blockText = String(body.block_text ?? body.program_block?.text ?? methodId);
    const turns = Array.isArray(body.turns) ? body.turns : [];
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
    const playbook = detectPlaybook(`${methodId} ${blockText}`);
    const plannedSteps = Array.isArray(body.planned_steps) ? body.planned_steps : [];
    const rows = buildEvidenceRows(turns, plannedSteps);
    const hasImage = artifacts.some((a: any) => a?.kind === "image");
    const hasAudio = artifacts.some((a: any) => a?.kind === "audio");
    const fallback = renderFallback(methodId || playbook?.method_id || "unknown", rows, hasImage, hasAudio);

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const prompt = `Vyhodnoť konkrétní diagnostickou metodu na profesionální, důkazní úrovni.

${playbook ? renderPlaybookForPrompt(playbook, plannedSteps) : "Bez pevného playbooku — buď mimořádně opatrný."}

METODA: ${methodId || playbook?.method_id || "neznámá"}
BOD PROGRAMU: ${blockText}
ČÁST: ${body.part_name ?? "?"}

DŮKAZNÍ TABULKA (heuristicky z logu):
${JSON.stringify(rows, null, 2)}

ARTEFAKTY: image=${hasImage}, audio=${hasAudio}

POVINNÉ LIMITY:
- Bez chybějících vstupů nesmíš dělat závěr, který z nich závisí.
- ROR/Rorschach: nikdy nepředstírej standardizované skórování, pokud není kompletní licencovaná administrace a scoring.
- Odděl: doložený nález / hypotéza / nehodnotitelné.

Vrať markdown se sekcemi: Diagnostická validita, Důkazní tabulka, Interpretace markerů, Vývojová přiměřenost, Limity a diferenciální vysvětlení, Doporučení.`;

    const ai = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages: [{ role: "user", content: prompt }] }),
    });
    if (!ai.ok) return new Response(JSON.stringify({ ok: true, degraded: true, markdown: fallback }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const data = await ai.json();
    const markdown = data.choices?.[0]?.message?.content || fallback;
    return new Response(JSON.stringify({ ok: true, markdown, evidence_rows: rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("karel-method-analysis error:", e);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});