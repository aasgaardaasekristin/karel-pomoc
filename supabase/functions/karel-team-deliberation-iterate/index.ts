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
  *     latest_input: { author: "hanka"|"kata", text: string, question?: string }
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
import { appendPantryB } from "../_shared/pantryB.ts";
import { createObservation, routeObservation } from "../_shared/observations.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
  tool_id?: string | null;
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

function inferInputKind(text: string): "plan_change" | "followup_need" | "conclusion" {
  const t = text.toLowerCase();
  if (/l[eé]k|derin|medik|tablet|doktor|psychiatr|příbal|pribal|bolest|hlav/.test(t)) return "plan_change";
  if (/zjistit|ověřit|overit|domluvit|pohl[ií]dat|připomen/.test(t)) return "followup_need";
  return "conclusion";
}

function buildImplicationText(authorLabel: string, subjectPart: string, question: string | null, text: string): string {
  const q = question ? ` Na otázku „${question}“` : "";
  return `${authorLabel}${q} uvedla: ${text}. Pro plán s částí ${subjectPart} to musí být započítáno jako aktuální týmová informace, ne jako otevřené slepé místo.`;
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
    const question = latest?.question ? String(latest.question).trim() : null;
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
    const implicationText = buildImplicationText(authorLabel, subjectPart, question, text);

    const prompt = `Jsi Karel — vedoucí terapeutického týmu, esence C. G. Junga. Pracuješ na ŽIVÉM, HRAVÉM programu sezení s částí "${subjectPart}".

PŮVODNÍ PRACOVNÍ NÁVRH:
${row.karel_proposed_plan ?? "(bez návrhu)"}

AKTUÁLNÍ PROGRAM (bod po bodu):
${currentProgram.length > 0
  ? currentProgram.map((b, i) => `${i + 1}. ${b.block}${b.minutes ? ` (${b.minutes} min)` : ""}${b.detail ? ` — ${b.detail}` : ""}`).join("\n")
  : "(zatím žádné body)"}

NOVÝ VSTUP OD ${authorLabel.toUpperCase()}:
"${text}"

${summarizeToolboxForPrompt()}

ÚKOL:
Zapracuj tento vstup do programu. Můžeš:
- přidat nový bod (s konkrétním nástrojem z arzenálu — uveď tool_id)
- upravit existující bod (změnit nástroj, detail, minutáž, pořadí)
- nahradit generický bod konkrétním hravým nástrojem (např. „úvodní rozhovor" → „Asociační otevření — 8 slov o domově")
- odstranit bod, pokud ${authorLabel} říká že nedává smysl
- nechat program beze změny, pokud vstup je jen souhlas / poznámka

PRAVIDLA HRAVOSTI (POVINNÁ):
- Žádný blok nesmí mít generický název („úvod", „práce s emocemi", „uzávěr"). VŽDY pojmenuj konkrétní nástroj z arzenálu.
- Program po každé iteraci musí obsahovat alespoň 2 nástroje z arzenálu.
- Vše REMOTE (chat / hlas / foto kresby / screen canvas / posílání obrázků). NIKDY fyzické pomůcky.
- detail = 3-5 vět: jakou má Karel připravit pomůcku (digitální), jaký prompt řekne, čeho si všímá v reakci.

Vrať VÝHRADNĚ JSON (bez markdownu, bez fences):
{
  "program_draft": [
    { "block": "konkrétní hravý název (max 100 znaků)", "minutes": 10, "detail": "3-5 vět: digitální pomůcka, Karlův prompt, co sledovat", "tool_id": "wat | rorschach_lite | active_imagination | …" }
  ],
  "karel_inline_comment": "1-2 věty terapeutkám: co konkrétně jsi v programu změnil podle jejich vstupu, a jaký nástroj jsi použil/přesunul."
}

PRAVIDLA STRUKTURY:
- max 8 bloků celkem
- každý detail max 320 znaků
- tool_id volitelný, ale doporučený
- minutáž volitelná
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
          block: String(b?.block ?? "").slice(0, 140).trim(),
          minutes: typeof b?.minutes === "number" ? b.minutes : null,
          detail: b?.detail ? String(b.detail).slice(0, 380) : null,
          tool_id: b?.tool_id ? String(b.tool_id).slice(0, 40).trim() : null,
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

    try {
      const inputKind = inferInputKind(text);
      const obsId = await createObservation(admin as any, {
        subject_type: "part",
        subject_id: subjectPart,
        source_type: "therapist_message",
        source_ref: deliberationId,
        fact: implicationText,
        evidence_level: "D2",
        confidence: 0.85,
        time_horizon: inputKind === "conclusion" ? "0_14d" : "hours",
      });
      await routeObservation(admin as any, obsId, {
        subject_type: "part",
        subject_id: subjectPart,
        evidence_level: "D2",
        time_horizon: inputKind === "conclusion" ? "0_14d" : "hours",
        fact: implicationText,
      }, inputKind === "conclusion" ? "team_coordination" : "immediate_plan");

      await appendPantryB(admin as any, {
        user_id: userId,
        entry_kind: inputKind,
        source_kind: "team_deliberation_answer",
        source_ref: `${deliberationId}:${author}:${fingerprint(text)}`,
        summary: implicationText,
        detail: {
          deliberation_id: deliberationId,
          deliberation_title: row.title,
          question,
          answer: text,
          program_draft: programDraft,
          karel_inline_comment: karelComment,
        },
        intended_destinations: ["briefing_input", "did_implications", "did_therapist_tasks"],
        related_part_name: subjectPart,
        related_therapist: author as "hanka" | "kata",
      });

      await admin.from("did_team_agreements").insert({
        user_id: userId,
        subject_type: "part",
        subject_id: subjectPart,
        agreement_text: text,
        implication_text: implicationText,
        source_table: "did_team_deliberations",
        source_record_id: deliberationId,
        source_detail: { question, author, title: row.title },
        agreed_by: [author],
        evidence_level: "D2",
        priority: inputKind === "plan_change" ? "high" : "normal",
      });

      const drivePayload = `\n\n## Týmová dohoda / odpověď terapeutky — ${subjectPart} (${new Date().toISOString().slice(0, 10)})\n_Zdroj: týmová porada ${deliberationId.slice(0, 8)}, ${authorLabel}_\n\n${implicationText}\n`;
      await admin.from("did_pending_drive_writes").insert({
        user_id: userId,
        target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
        write_type: "append",
        content: encodeGovernedWrite(drivePayload, {
          source_type: "team_deliberation_answer",
          source_id: `${deliberationId}:${author}:${fingerprint(text)}`,
          content_type: inputKind === "plan_change" ? "care_plan_change" : "team_coordination",
          subject_type: "part",
          subject_id: subjectPart,
          payload_fingerprint: fingerprint(drivePayload),
        }),
        priority: inputKind === "plan_change" ? "high" : "normal",
        status: "pending",
      });
    } catch (memoryErr) {
      console.warn("[delib-iterate] memory write failed (non-fatal):", memoryErr);
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
