/**
 * karel-team-deliberation-iterate
 *
 * Po každém novém vstupu terapeutky (odpověď na otázku NEBO podnět
 * v diskuzi) Karel okamžitě upraví `program_draft` (živá agenda) a
 * vrátí krátký inline komentář, co konkrétně změnil. Tím je program
 * iterativně zdokonalován do okamžiku, kdy obě terapeutky podepíšou.
 *
 * Vstup:
 *   {
 *     deliberation_id: string,
 *     latest_input: { author: "hanka"|"kata", text: string }
 *   }
 *
 * Výstup:
 *   {
 *     program_draft: AgendaBlock[],
 *     karel_inline_comment: string
 *   }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { summarizeToolboxForPrompt } from "../_shared/therapeuticToolbox.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
}

function safeJsonParse(text: string): any {
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Try to extract first JSON object
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

function fingerprint(s: string): string {
  // jednoduchý hash pro idempotenci (žádné crypto, ale stačí)
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
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
    const latest = body?.latest_input ?? {};
    const author = String(latest?.author ?? "");
    const text = String(latest?.text ?? "").trim();
    if (!deliberationId || !["hanka", "kata"].includes(author) || !text) {
      return new Response(JSON.stringify({ error: "bad input" }), {
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

    if (row.status === "approved" || row.status === "closed" || row.status === "archived") {
      return new Response(JSON.stringify({
        error: "locked",
        message: "Porada je už uzavřená — program nelze dál upravovat.",
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotence guard — pokud poslední záznam v discussion_log je shodný
    // (stejný author + stejný text fingerprint), nic nedělej.
    const log = Array.isArray(row.discussion_log) ? row.discussion_log : [];
    const last = log[log.length - 1];
    const fp = fingerprint(`${author}::${text}`);
    if (last && last.author === author && fingerprint(String(last.content ?? "")) === fp) {
      return new Response(JSON.stringify({
        program_draft: row.program_draft ?? [],
        karel_inline_comment: "(žádný nový vstup — vstup už byl započítán)",
        no_op: true,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Stávající program (preferuj program_draft, fallback na agenda_outline z prefillu)
    const currentProgram: AgendaBlock[] = Array.isArray(row.program_draft) && row.program_draft.length > 0
      ? row.program_draft
      : (Array.isArray(row.agenda_outline) ? row.agenda_outline : []);

    const subjectPart = (row.subject_parts ?? [])[0] ?? "(neurčeno)";
    const authorLabel = author === "hanka" ? "Hanička" : "Káťa";

    const prompt = `Jsi Karel — vedoucí terapeutického týmu. Pracuješ na živém programu sezení s částí "${subjectPart}".

PŮVODNÍ PRACOVNÍ NÁVRH:
${row.karel_proposed_plan ?? "(bez návrhu)"}

AKTUÁLNÍ PROGRAM (bod po bodu):
${currentProgram.length > 0
  ? currentProgram.map((b, i) => `${i + 1}. ${b.block}${b.minutes ? ` (${b.minutes} min)` : ""}${b.detail ? ` — ${b.detail}` : ""}`).join("\n")
  : "(zatím žádné body)"}

NOVÝ VSTUP OD ${authorLabel.toUpperCase()}:
"${text}"

ÚKOL:
Zapracuj tento vstup do programu. Můžeš:
- přidat nový bod
- upravit existující bod (změnit detail / minutáž / pořadí)
- odstranit bod, pokud ${authorLabel} říká že nedává smysl
- nechat program beze změny, pokud vstup je jen souhlas / poznámka

Vrať VÝHRADNĚ JSON (bez markdownu, bez fences):
{
  "program_draft": [
    { "block": "krátký název kroku (max 80 znaků)", "minutes": 10, "detail": "1-2 věty co se v bloku děje" }
  ],
  "karel_inline_comment": "1-2 věty terapeutkám: co konkrétně jsi v programu změnil podle jejich vstupu (buď konkrétní: 'Bod 2 jsem zkrátil na 8 minut a přidal otázku o…')"
}

PRAVIDLA:
- max 8 bloků celkem
- každý detail max 240 znaků
- minutáž volitelná (vynech, pokud nedává smysl)
- žádné prázdné bloky`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Vrať VÝHRADNĚ čistý JSON. Bez markdownu, bez fences, bez komentářů." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[delib-iterate] AI error", aiRes.status, t);
      return new Response(JSON.stringify({ error: `ai gateway ${aiRes.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const aiData = await aiRes.json();
    const aiText = aiData?.choices?.[0]?.message?.content ?? "";
    const parsed = safeJsonParse(aiText);
    if (!parsed) {
      console.error("[delib-iterate] AI returned non-JSON:", aiText.slice(0, 400));
      return new Response(JSON.stringify({ error: "ai_invalid_json" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const programDraft: AgendaBlock[] = Array.isArray(parsed.program_draft)
      ? parsed.program_draft.slice(0, 8).map((b: any) => ({
          block: String(b?.block ?? "").slice(0, 120).trim(),
          minutes: typeof b?.minutes === "number" ? b.minutes : null,
          detail: b?.detail ? String(b.detail).slice(0, 280) : null,
        })).filter((b: AgendaBlock) => b.block.length > 0)
      : [];
    const karelComment = String(parsed.karel_inline_comment ?? "").slice(0, 600);

    // Append to discussion_log: terapeutčin vstup + Karlova reakce
    const nowIso = new Date().toISOString();
    const newLog = [
      ...log,
      { author, content: text, created_at: nowIso },
      { author: "karel", content: karelComment, created_at: nowIso, is_plan_revision: true },
    ];

    // Save program_draft + log; invalidovat starou syntézu (vstup změnil situaci)
    const { error: updErr } = await admin
      .from("did_team_deliberations")
      .update({
        program_draft: programDraft,
        discussion_log: newLog,
        karel_synthesis: null,
        karel_synthesized_at: null,
        final_summary: null,
      })
      .eq("id", deliberationId);

    if (updErr) {
      console.error("[delib-iterate] update failed:", updErr);
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      program_draft: programDraft,
      karel_inline_comment: karelComment,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[delib-iterate] fatal:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
