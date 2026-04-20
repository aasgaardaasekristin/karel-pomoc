/**
 * karel-team-deliberation-synthesize
 *
 * Karel přečte odpovědi Haničky a Káti + discussion_log, syntetizuje je
 * a zapíše:
 *   - final_summary (markdown stručný výstup)
 *   - karel_synthesis (strukturovaný JSON: verdict, next_step, …)
 *   - karel_synthesized_at (timestamp)
 *
 * Bez tohoto kroku NESMÍ být u typu `crisis` aktivní Karlův podpis.
 *
 * Vstup:
 *   { deliberation_id: string }
 *
 * Výstup:
 *   { deliberation: TeamDeliberation, synthesis: KarelSynthesis }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

interface KarelSynthesis {
  verdict: "crisis_persists" | "crisis_easing" | "crisis_resolvable" | "non_crisis";
  next_step: string;
  needs_karel_interview: boolean;
  key_insights: string[];
  drive_writeback_md: string;
  recommended_session_focus: string | null;
  risk_signals: string[];
  protective_signals: string[];
}

function buildPrompt(d: any): string {
  const qH = (d.questions_for_hanka ?? []) as Array<{ question: string; answer?: string | null }>;
  const qK = (d.questions_for_kata ?? []) as Array<{ question: string; answer?: string | null }>;
  const log = (d.discussion_log ?? []) as Array<{ author: string; content: string }>;

  const fmtQ = (label: string, list: typeof qH) =>
    list.length === 0
      ? `(${label} — žádné otázky)`
      : list.map((q, i) =>
          `${i + 1}. ${q.question}\n   ${label} odpověděla: ${q.answer?.trim() || "(bez odpovědi)"}`
        ).join("\n");

  const fmtLog = log.length === 0
    ? "(žádná diskuse)"
    : log.map((m) =>
        `- ${m.author === "karel" ? "Karel" : m.author === "hanka" ? "Hanička" : "Káťa"}: ${m.content}`
      ).join("\n");

  const isCrisis = d.deliberation_type === "crisis" || d.priority === "crisis";

  return `Jsi **Karel** — vedoucí terapeutického týmu.
Právě jsi dostal odpovědi Haničky a Káti na otázky z porady, kterou jsi sám svolal.
Teď je MUSÍŠ syntetizovat dřív, než cokoliv podepíšeš.

PORADA:
- typ: ${d.deliberation_type}
- priorita: ${d.priority}
- dotčené části: ${(d.subject_parts ?? []).join(", ") || "(neuvedeno)"}
- důvod: ${d.reason ?? "(neuvedeno)"}
- tvůj brief při svolání: ${d.initial_karel_brief ?? "(prázdný)"}
- tvůj pracovní návrh: ${d.karel_proposed_plan ?? "(prázdný)"}

ODPOVĚDI HANIČKY:
${fmtQ("Hanička", qH)}

ODPOVĚDI KÁTI:
${fmtQ("Káťa", qK)}

DISKUSE:
${fmtLog}

POŽADOVANÝ VÝSTUP — ČISTÝ JSON, žádný markdown, žádné fences:
{
  "verdict": ${isCrisis
    ? '"crisis_persists" | "crisis_easing" | "crisis_resolvable"'
    : '"non_crisis" | "crisis_persists" | "crisis_easing" | "crisis_resolvable"'},
  "next_step": "1-2 věty: co Karel udělá jako další krok",
  "needs_karel_interview": true | false,
  "key_insights": [
    "3-5 konkrétních klinických vhledů, které z odpovědí plynou (ne obecné fráze)"
  ],
  "drive_writeback_md": "krátký strukturovaný markdown blok (max 600 slov), který se zapíše do operativního plánu (05A) v Drive — obsahuje: stav krize, co Hanička sdělila, co Káťa sdělila, Karlovo vyhodnocení, doporučený další krok",
  "recommended_session_focus": "1 věta — na co se zaměřit v dalším Karlově sezení s ${(d.subject_parts ?? [])[0] || "částí"}, nebo null pokud sezení teď nepotřeba",
  "risk_signals": ["konkrétní rizikové signály, které z odpovědí vyplynuly"],
  "protective_signals": ["konkrétní ochranné/stabilizační signály, které z odpovědí vyplynuly"]
}

PRAVIDLA:
- mluv věcně, jako Karel-supervisor
- nevymýšlej, co terapeutky neřekly
- pokud terapeutky popisují polevující napětí → "crisis_easing"
- pokud popisují trvající denní stres / switching / nespavost → "crisis_persists"
- pokud popisují stabilní stav několik dní + funkční regulaci → "crisis_resolvable"
- u crisis_persists / crisis_easing nastav needs_karel_interview = true (Karel si přizve část)`;
}

async function callAI(prompt: string): Promise<KarelSynthesis> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Vrať VÝHRADNĚ čistý JSON. Bez markdownu, bez fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AI gateway ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(clean);

  // Defensive normalization
  return {
    verdict: ["crisis_persists", "crisis_easing", "crisis_resolvable", "non_crisis"]
      .includes(parsed.verdict) ? parsed.verdict : "crisis_persists",
    next_step: String(parsed.next_step ?? "").slice(0, 600),
    needs_karel_interview: Boolean(parsed.needs_karel_interview),
    key_insights: Array.isArray(parsed.key_insights)
      ? parsed.key_insights.slice(0, 8).map((x: any) => String(x).slice(0, 400))
      : [],
    drive_writeback_md: String(parsed.drive_writeback_md ?? "").slice(0, 6000),
    recommended_session_focus: parsed.recommended_session_focus
      ? String(parsed.recommended_session_focus).slice(0, 400) : null,
    risk_signals: Array.isArray(parsed.risk_signals)
      ? parsed.risk_signals.slice(0, 8).map((x: any) => String(x).slice(0, 300)) : [],
    protective_signals: Array.isArray(parsed.protective_signals)
      ? parsed.protective_signals.slice(0, 8).map((x: any) => String(x).slice(0, 300)) : [],
  };
}

function buildFinalSummary(d: any, s: KarelSynthesis): string {
  const verdictLabel: Record<string, string> = {
    crisis_persists: "🔴 Krize trvá",
    crisis_easing: "🟡 Krize polevuje",
    crisis_resolvable: "🟢 Krizi lze uzavřít",
    non_crisis: "Bez krizového stavu",
  };
  const lines: string[] = [];
  lines.push(`**Karlovo vyhodnocení:** ${verdictLabel[s.verdict] ?? s.verdict}`);
  lines.push("");
  lines.push(`**Další krok:** ${s.next_step}`);
  if (s.needs_karel_interview) {
    lines.push("");
    lines.push(`**Karel si přizve ${(d.subject_parts ?? [])[0] || "část"} k vlastnímu rozhovoru.**`);
  }
  if (s.recommended_session_focus) {
    lines.push("");
    lines.push(`**Zaměření sezení:** ${s.recommended_session_focus}`);
  }
  if (s.key_insights.length) {
    lines.push("");
    lines.push("**Klíčové vhledy:**");
    s.key_insights.forEach((k) => lines.push(`- ${k}`));
  }
  if (s.risk_signals.length) {
    lines.push("");
    lines.push("**Rizikové signály:**");
    s.risk_signals.forEach((k) => lines.push(`- ${k}`));
  }
  if (s.protective_signals.length) {
    lines.push("");
    lines.push("**Ochranné signály:**");
    s.protective_signals.forEach((k) => lines.push(`- ${k}`));
  }
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const deliberationId = String(body?.deliberation_id ?? "");
    if (!deliberationId) {
      return new Response(JSON.stringify({ error: "missing deliberation_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: row, error: fetchErr } = await admin
      .from("did_team_deliberations")
      .select("*")
      .eq("id", deliberationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchErr || !row) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Soft guard: vyžadujeme alespoň jednu odpověď nebo discussion message,
    // jinak nemá smysl syntetizovat.
    const qH = (row.questions_for_hanka ?? []) as Array<{ answer?: string | null }>;
    const qK = (row.questions_for_kata ?? []) as Array<{ answer?: string | null }>;
    const anyAnswer = qH.some((q) => q.answer?.trim()) || qK.some((q) => q.answer?.trim());
    const anyDiscussion = (row.discussion_log ?? []).length > 0;
    if (!anyAnswer && !anyDiscussion) {
      return new Response(JSON.stringify({
        error: "no_input",
        message: "Karel nemá co syntetizovat — žádné odpovědi ani diskuse.",
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const synthesis = await callAI(buildPrompt(row));
    const finalSummary = buildFinalSummary(row, synthesis);

    const { data: updated, error: updErr } = await admin
      .from("did_team_deliberations")
      .update({
        karel_synthesis: synthesis,
        karel_synthesized_at: new Date().toISOString(),
        final_summary: finalSummary,
      })
      .eq("id", deliberationId)
      .select("*")
      .single();

    if (updErr) {
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      deliberation: updated,
      synthesis,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[delib-synthesize] failed:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
