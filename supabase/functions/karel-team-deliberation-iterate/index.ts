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

function inferPlanChangeState(inputKind: "plan_change" | "followup_need" | "conclusion", before: AgendaBlock[], after: AgendaBlock[], text: string): "unchanged" | "revised" | "deferred" | "needs_followup_question" {
  const t = text.toLowerCase();
  if (/(nev[ií]m|nejsem si jist|nen[íi] jasn|potřebuju? doplnit|potrebuju? doplnit|doptat|ověřit|overit|chyb[íi].{0,40}(informac|odpověď|odpoved)|nen[íi] možné.{0,40}uzavř[ií]t)/i.test(t)) {
    return "needs_followup_question";
  }
  const beforeSig = JSON.stringify(before.map((b) => [b.block, b.minutes ?? null, b.detail ?? null, b.tool_id ?? null]));
  const afterSig = JSON.stringify(after.map((b) => [b.block, b.minutes ?? null, b.detail ?? null, b.tool_id ?? null]));
  if (beforeSig !== afterSig) return "revised";
  if (inputKind === "followup_need") return "deferred";
  return "unchanged";
}

function buildImplicationText(authorLabel: string, subjectPart: string, question: string | null, text: string): string {
  const q = question ? ` Na otázku „${question}“` : "";
  return `${authorLabel}${q} uvedla: ${text}. Pro plán s částí ${subjectPart} to musí být započítáno jako aktuální týmová informace, ne jako otevřené slepé místo.`;
}

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  return source.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 8);
}

function nonEmptyString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function hasRealTherapistAnswer(row: any): boolean {
  const allQuestions = [
    ...(Array.isArray(row?.questions_for_hanka) ? row.questions_for_hanka : []),
    ...(Array.isArray(row?.questions_for_kata) ? row.questions_for_kata : []),
  ];
  const answeredQuestion = allQuestions.some((q: any) => nonEmptyString(q?.answer));
  const answeredLog = (Array.isArray(row?.discussion_log) ? row.discussion_log : [])
    .some((e: any) => ["hanka", "kata"].includes(String(e?.author ?? "")) && nonEmptyString(e?.content));
  return answeredQuestion || answeredLog;
}

function sanitizeHybridContract(contract: Record<string, any> | null, therapistAnswered: boolean): Record<string, any> | null {
  if (!contract) return null;
  const next = { ...contract };
  if (next.theme_source === "therapist_answer" && !therapistAnswered) next.theme_source = "neutral_choice";
  if (!["confirmed_part_card", "therapist_answer", "neutral_choice", "unknown"].includes(String(next.theme_source ?? ""))) next.theme_source = "unknown";
  return next;
}

function scrubKarelOnlyText(value: string): string {
  return value
    .replace(/fyzick\S*|pom[uů]ck\S*|hračk\S*|kresb\S*|obrázk\S*|obrazk\S*|latenc\S*|neverb\S*|hlas\S*|afekt\S*|somatick\S*|projektiv\S*/gi, "textově-symbolické")
    .replace(/terapeutk[ay]?|Haničk[ay]?|Káť[ay]?/g, "Karel")
    .trim();
}

function normalizeProgramBlock(raw: any, hybridContract: Record<string, any> | null): AgendaBlock & Record<string, any> {
  const mode = String(hybridContract?.therapist_led_vs_karel_only ?? hybridContract?.session_mode ?? "karel_only");
  const therapistLed = mode === "therapist_led" || mode === "tandem";
  const clinicalIntent = nonEmptyString(raw?.clinical_intent) ?? nonEmptyString(raw?.clinical_goal) ?? nonEmptyString(raw?.diagnostic_or_therapeutic_intent) ?? nonEmptyString(hybridContract?.clinical_goal) ?? nonEmptyString(hybridContract?.diagnostic_or_therapeutic_intent) ?? nonEmptyString(raw?.detail) ?? "Evidence-limited bezpečné ověření bez klinických závěrů.";
  const playfulForm = nonEmptyString(raw?.playful_form) ?? nonEmptyString(hybridContract?.playful_theme) ?? "neutrální bezpečná symbolická volba";
  const script = nonEmptyString(raw?.script) ?? asStringArray(hybridContract?.what_therapist_says)[0] ?? "Můžeme u toho zůstat jen krátce a bezpečně; kdykoli můžeme přestat.";
  const observe = therapistLed ? asStringArray(raw?.observe, asStringArray(hybridContract?.what_therapist_observes, ["míru bezpečného zapojení", "změnu napětí", "doslovnou odpověď"])) : ["textovou odpověď", "míru bezpečného zapojení", "přání pokračovat nebo skončit"];
  return {
    block: String(raw?.block ?? raw?.title ?? "").slice(0, 140).trim(),
    minutes: typeof raw?.minutes === "number" ? raw.minutes : 10,
    clinical_intent: therapistLed ? clinicalIntent : scrubKarelOnlyText(clinicalIntent),
    playful_form: therapistLed ? playfulForm : scrubKarelOnlyText(playfulForm || "neutrální textově-symbolická hra"),
    script: therapistLed ? script : scrubKarelOnlyText(script),
    observe: observe.map((x) => therapistLed ? x : scrubKarelOnlyText(x)).filter(Boolean),
    evidence_to_record: asStringArray(raw?.evidence_to_record, asStringArray(hybridContract?.data_needed_for_valid_review, ["co bylo skutečně řečeno", "co zůstalo nejasné", "zda kontakt zůstal bezpečný"])),
    stop_if: asStringArray(raw?.stop_if, asStringArray(hybridContract?.stop_rules, ["úzkost", "odmítnutí pokračovat", "ztráta bezpečí"])),
    fallback: nonEmptyString(raw?.fallback) ?? nonEmptyString(hybridContract?.fallback) ?? "Zastavit program a vrátit se k jednoduchému bezpečnému check-inu.",
    requires_physical_therapist: therapistLed ? Boolean(raw?.requires_physical_therapist ?? true) : false,
    karel_can_do_alone: therapistLed ? Boolean(raw?.karel_can_do_alone ?? false) : true,
  };
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

AKTUÁLNÍ HYBRIDNÍ KONTRAKT:
${row.session_params?.hybrid_contract ? JSON.stringify(row.session_params.hybrid_contract, null, 2) : "(zatím není uložený — vytvoř ho podle pravidel níže)"}

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
- Rozlišuj therapist-led vs Karel-only Herna. Therapist-led smí používat fyzické pomůcky, hračky, kresbu, knihu, pohybové/somatické prvky, asociační/projektivní prvky, latence, afekt, hlas a neverbální projevy — ale vždy napiš, co má Hanička/Káťa sledovat, co je validní evidence, co je jen dojem, kdy zastavit a fallback.
- Karel-only Herna smí používat jen bezpečný check-in, grounding, resource-building, symbolickou hru přes chat, příběhové mapování, imaginativní bezpečné prvky a nízkorizikové pozorování z textových odpovědí. NIKDY fyzické pomůcky, validní měření latencí, neverbální diagnostiku, hlubokou traumatickou práci ani pseudo-diagnostická tvrzení.
- Pokud blok vyžaduje fyzickou terapeutku, napiš výslovně: „Tuto část nemůže Karel validně provést sám v herně; vyžaduje fyzickou terapeutku kvůli pozorování latencí, afektu a neverbálních projevů."
- detail = 3-5 vět: klinický záměr, hravá forma, přesná věta, co sledovat, co zaznamenat, stop pravidlo a fallback.
- Témata/preference použij jen pokud jsou potvrzené kartou části, terapeutčinou odpovědí nebo jinou explicitní evidencí. Tundrupek hory/draci/tibetská tematika a Arthur Gruffalo/kniha jen jako potvrzené; jinak neutrální volba a theme_source="unknown" nebo "neutral_choice".

Vrať VÝHRADNĚ JSON (bez markdownu, bez fences):
{
  "hybrid_contract": {
    "clinical_goal": "",
    "treatment_phase": "stabilization|processing|integration|monitoring",
    "diagnostic_or_therapeutic_intent": "",
    "risk_gate": "",
    "readiness_today": "green|amber|red",
    "playful_theme": "",
    "theme_source": "confirmed_part_card|therapist_answer|neutral_choice|unknown",
    "confirmed_preferences_only": true,
    "therapist_led_vs_karel_only": "therapist_led|karel_only|tandem",
    "materials_or_props": [],
    "what_therapist_says": [],
    "what_therapist_observes": [],
    "data_needed_for_valid_review": [],
    "stop_rules": [],
    "fallback": "",
    "writeback_target": ["review"]
  },
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

    const parsedHybrid = parsed.hybrid_contract && typeof parsed.hybrid_contract === "object"
      ? parsed.hybrid_contract as Record<string, any>
      : (row.session_params?.hybrid_contract && typeof row.session_params.hybrid_contract === "object" ? row.session_params.hybrid_contract as Record<string, any> : null);
    const programDraft: Array<AgendaBlock & Record<string, any>> = Array.isArray(parsed.program_draft)
      ? parsed.program_draft.slice(0, 8).map((b: any) => normalizeProgramBlock(b, parsedHybrid)).filter((b: AgendaBlock) => b.block.length > 0)
      : currentProgram.map((b: any) => normalizeProgramBlock(b, parsedHybrid)).filter((b: AgendaBlock) => b.block.length > 0);
    const karelComment = String(parsed.karel_inline_comment ?? "").slice(0, 600);

    // Append to discussion_log: terapeutčin vstup + Karlova reakce
    const nowIso = new Date().toISOString();
    const newLog = [
      ...log,
      { author, content: text, created_at: nowIso },
      { author: "karel", content: karelComment, created_at: nowIso, is_plan_revision: true },
    ];

    const inputKind = inferInputKind(text);
    const planChangeState = inferPlanChangeState(inputKind, currentProgram, programDraft, text);
    const sessionParams = row.session_params && typeof row.session_params === "object"
      ? { ...(row.session_params as Record<string, any>) }
      : {};
    sessionParams.last_plan_change_state = planChangeState;
    sessionParams.last_plan_change_at = nowIso;
    sessionParams.last_plan_change_source = `${author}:${fingerprint(text)}`;
    if (parsed.hybrid_contract && typeof parsed.hybrid_contract === "object") {
      sessionParams.hybrid_contract = parsed.hybrid_contract;
    }
    const hybridContract = sessionParams.hybrid_contract && typeof sessionParams.hybrid_contract === "object"
      ? sessionParams.hybrid_contract as Record<string, any>
      : null;
    if (hybridContract) {
      sessionParams.readiness_today = String(sessionParams.readiness_today ?? hybridContract.readiness_today ?? "").trim() || null;
      sessionParams.risk_gate = sessionParams.risk_gate ?? hybridContract.risk_gate ?? null;
      sessionParams.stop_rules = Array.isArray(sessionParams.stop_rules) && sessionParams.stop_rules.length > 0
        ? sessionParams.stop_rules
        : (Array.isArray(hybridContract.stop_rules) ? hybridContract.stop_rules.map((x: any) => String(x)).slice(0, 8) : []);
      sessionParams.session_mode = String(sessionParams.session_mode ?? hybridContract.session_mode ?? hybridContract.therapist_led_vs_karel_only ?? "standard").trim() || "standard";
    }

    // Save program_draft + log; invalidovat starou syntézu (vstup změnil situaci)
    const { error: updErr } = await admin
      .from("did_team_deliberations")
      .update({
        program_draft: programDraft,
        session_params: sessionParams,
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

      // MVP-SESSION-1 guard: iterate is pre-signoff working state. It must not
      // enqueue a 05A write that can look like approved operational truth.
      // Durable memory stays in observations/Pantry B/team agreements; 05A is
      // produced only after signoff by karel-team-deliberation-signoff.
    } catch (memoryErr) {
      console.warn("[delib-iterate] memory write failed (non-fatal):", memoryErr);
    }

    return new Response(JSON.stringify({
      program_draft: programDraft,
      karel_inline_comment: karelComment,
      last_plan_change_state: planChangeState,
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
