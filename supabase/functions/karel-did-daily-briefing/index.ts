/**
 * karel-did-daily-briefing
 *
 * Generuje kanonický denní briefing Karla.
 * Briefing je redakční artefakt — vzniká jednou denně, ukládá se do
 * `did_daily_briefings`, dashboard ho jen čte.
 *
 * Generation methods (uloženo do `did_daily_briefings.generation_method`):
 *   - "auto"   → ranní cron (job `did-daily-briefing-morning`, viz pg_cron)
 *   - "manual" → tlačítko `Přegenerovat` v UI (DidDailyBriefingPanel)
 *
 * Anti-dup: pokud existuje fresh (is_stale=false) briefing pro dnešek
 * a request nemá `force: true`, vrátí se cached. Cron volá BEZ `force`,
 * takže neudusí ruční briefing, pokud už existuje. Manuální regenerace
 * posílá `force: true`.
 *
 * Workflow:
 * 1. Načti kontext: aktivní krize, signály z posledních 3 dnů, otevřené tasky, parts
 * 2. Spočítej skóre kandidátů na dnešní sezení (heuristika)
 * 3. Pošli AI strukturovaný kontext + tool-call schema
 * 4. Ulož výsledek do did_daily_briefings
 *
 * Tone: kultivovaná čeština, jungovská noblesa v úvodu/přechodech,
 * konkrétní pracovní formulace v rozhodovacích bodech.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import { selectPantryA, summarizePantryAForPrompt, type PantryASnapshot } from "../_shared/pantryA.ts";
import { readUnprocessedPantryB, markPantryBProcessed } from "../_shared/pantryB.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";

const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return pragueDayISO(d);
};

// ───────────────────────────────────────────────────────────
// HEURISTIKA: skórování kandidátů na dnešní sezení
// ───────────────────────────────────────────────────────────
interface SessionCandidate {
  part_id: string;
  part_name: string;
  score: number;
  reasons: string[];
}

async function scoreSessionCandidates(supabase: any): Promise<SessionCandidate[]> {
  const threeDaysAgo = daysAgoISO(3);
  const candidates = new Map<string, SessionCandidate>();

  const ensure = (part_id: string, part_name: string): SessionCandidate => {
    if (!candidates.has(part_id)) {
      candidates.set(part_id, { part_id, part_name, score: 0, reasons: [] });
    }
    return candidates.get(part_id)!;
  };

  // 1) Aktivní krize (×3)
  const { data: crises } = await supabase
    .from("crisis_events")
    .select("id, part_name, severity, phase, indicator_safety, indicator_emotional_regulation")
    .not("phase", "in", '("closed","CLOSED")');

  for (const c of crises || []) {
    const { data: part } = await supabase
      .from("did_parts")
      .select("id, name")
      .eq("name", c.part_name)
      .maybeSingle();
    if (!part) continue;
    const cand = ensure(part.id, part.name);
    cand.score += 3;
    cand.reasons.push(`aktivní krize (${c.severity || "?"}, fáze ${c.phase || "?"})`);
    if ((c.indicator_safety ?? 5) <= 2) {
      cand.score += 2;
      cand.reasons.push("nízký bezpečnostní indikátor");
    }
  }

  // 2) Opakované signály z posledních 3 dnů (×2)
  const { data: recentObs } = await supabase
    .from("did_observations")
    .select("part_id, severity, signal_type")
    .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(100);

  const obsCounts = new Map<string, number>();
  for (const o of recentObs || []) {
    if (!o.part_id) continue;
    obsCounts.set(o.part_id, (obsCounts.get(o.part_id) || 0) + 1);
  }
  for (const [part_id, count] of obsCounts) {
    if (count >= 2) {
      const { data: part } = await supabase.from("did_parts").select("id, name").eq("id", part_id).maybeSingle();
      if (!part) continue;
      const cand = ensure(part.id, part.name);
      cand.score += Math.min(count, 4);
      cand.reasons.push(`${count} signálů za 3 dny`);
    }
  }

  // 3) Pending questions bez odpovědi (×1)
  const { data: pending } = await supabase
    .from("did_pending_questions")
    .select("part_id")
    .in("status", ["pending", "sent"]);

  for (const p of pending || []) {
    if (!p.part_id) continue;
    const { data: part } = await supabase.from("did_parts").select("id, name").eq("id", p.part_id).maybeSingle();
    if (!part) continue;
    const cand = ensure(part.id, part.name);
    cand.score += 1;
    cand.reasons.push("nedořešená otázka");
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score);
}

// ───────────────────────────────────────────────────────────
// KONTEXT: posledních 3 dní + lingering
// ───────────────────────────────────────────────────────────
async function gatherContext(supabase: any) {
  const threeDaysAgo = daysAgoISO(3);
  const sevenDaysAgo = daysAgoISO(7);

  const [crisesRes, recentObsRes, olderObsRes, pendingRes, threadsRes, plansRes] = await Promise.all([
    supabase.from("crisis_events")
      .select("id, part_name, severity, phase, trigger_description, days_active, opened_at, clinical_summary")
      .not("phase", "in", '("closed","CLOSED")')
      .order("severity", { ascending: false }),
    supabase.from("did_observations")
      .select("part_id, signal_type, severity, content, created_at")
      .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("did_observations")
      .select("part_id, signal_type, severity, content, created_at")
      .gte("created_at", `${sevenDaysAgo}T00:00:00Z`)
      .lt("created_at", `${threeDaysAgo}T00:00:00Z`)
      .eq("severity", "high")
      .limit(20),
    supabase.from("did_pending_questions")
      .select("id, part_id, question, asked_to, status")
      .in("status", ["pending", "sent"])
      .limit(20),
    supabase.from("did_threads")
      .select("id, title, part_name, last_message_at")
      .gte("last_message_at", `${threeDaysAgo}T00:00:00Z`)
      .order("last_message_at", { ascending: false })
      .limit(15),
    supabase.from("did_daily_session_plans")
      .select("id, part_id, status, plan_summary, session_date")
      .gte("session_date", threeDaysAgo)
      .order("session_date", { ascending: false }),
  ]);

  const { data: parts } = await supabase
    .from("did_parts")
    .select("id, name");
  const partsById = new Map((parts || []).map((p: any) => [p.id, p.name]));

  // ═══ HOURGLASS: SPIŽÍRNA A READER (briefing) ═══
  // Reálný konzument composed morning view-modelu. Briefing už netahá vše
  // ručně — Pantry A přidává canonical priority, parts/therapists status,
  // oddělené Hana personal vs. therapeutic sloty, Káťa kontext, včerejší
  // sezení a otevřené follow-upy. Vlastní gather query výše zůstávají
  // jako safety net pro případ, že canonical layer dnes neexistuje.
  let pantryA: PantryASnapshot | null = null;
  let pantryASummary = "";
  try {
    const { data: anyCtxRow } = await supabase
      .from("did_daily_context")
      .select("user_id")
      .order("context_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const userId = anyCtxRow?.user_id;
    if (userId) {
      pantryA = await selectPantryA(supabase, userId);
      pantryASummary = summarizePantryAForPrompt(pantryA);
      console.log(`[briefing] Pantry A loaded: canonical_present=${pantryA.sources.canonical_present}, parts=${pantryA.parts_status.length}, followups=${pantryA.open_followups.length}, priorities=${pantryA.today_priorities.length}`);
    } else {
      console.warn("[briefing] Pantry A skipped: no user_id resolvable from did_daily_context");
    }
  } catch (pErr) {
    console.warn("[briefing] Pantry A load failed (non-fatal):", pErr);
  }

  // ═══ PANTRY B READER (briefing) ═══
  // Sběr nezpracovaných implikací z včerejška + dnešního rána.
  // Zdroje: signoff/synthesis (porady), did-meeting finalize, apply-analysis,
  // post-chat writebacky. Bez tohoto kroku Karel nevidí, co včera ve vláknech /
  // poradách / sezeních vyplynulo, a briefing zní jako kdyby den začínal odznova.
  let pantryBEntries: any[] = [];
  let approvedDeliberations: any[] = [];
  try {
    const userIdForB = pantryA?.sources?.user_id
      // Fallback k libovolnému user_id z did_daily_context (stejný pattern jako Pantry A výše).
      ?? null;
    let userIdResolved: string | null = userIdForB;
    if (!userIdResolved) {
      const { data: anyCtxRow } = await supabase
        .from("did_daily_context")
        .select("user_id")
        .order("context_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      userIdResolved = anyCtxRow?.user_id ?? null;
    }
    if (userIdResolved) {
      pantryBEntries = await readUnprocessedPantryB(supabase, userIdResolved);
      const { data: approved } = await supabase
        .from("did_team_deliberations")
        .select("id, title, deliberation_type, subject_parts, final_summary, karel_synthesis, updated_at")
        .eq("user_id", userIdResolved)
        .eq("status", "approved")
        .gte("updated_at", `${daysAgoISO(2)}T00:00:00Z`)
        .order("updated_at", { ascending: false })
        .limit(10);
      approvedDeliberations = approved ?? [];
      console.log(`[briefing] Pantry B loaded: entries=${pantryBEntries.length}, approved_delibs=${approvedDeliberations.length}`);
    }
  } catch (bErr) {
    console.warn("[briefing] Pantry B / approved deliberations load failed (non-fatal):", bErr);
  }

  return {
    today: pragueDayISO(),
    crises: crisesRes.data || [],
    recent_observations: (recentObsRes.data || []).map((o: any) => ({
      ...o, part_name: o.part_id ? partsById.get(o.part_id) : null,
    })),
    older_significant: (olderObsRes.data || []).map((o: any) => ({
      ...o, part_name: o.part_id ? partsById.get(o.part_id) : null,
    })),
    pending_questions: (pendingRes.data || []).map((q: any) => ({
      ...q, part_name: q.part_id ? partsById.get(q.part_id) : null,
    })),
    recent_threads: threadsRes.data || [],
    recent_session_plans: (plansRes.data || []).map((p: any) => ({
      ...p, part_name: p.part_id ? partsById.get(p.part_id) : null,
    })),
    pantry_a: pantryA,
    pantry_a_summary: pantryASummary,
    pantry_b_entries: pantryBEntries,
    approved_deliberations: approvedDeliberations,
  };
}

// ───────────────────────────────────────────────────────────
// AI: strukturovaný briefing přes tool calling
// ───────────────────────────────────────────────────────────
const BRIEFING_TOOL = {
  type: "function",
  function: {
    name: "emit_daily_briefing",
    description: "Vrátí strukturovaný denní briefing Karla pro dashboardovou poradu týmu.",
    parameters: {
      type: "object",
      properties: {
        greeting: {
          type: "string",
          description: "Karlovo úvodní slovo (2-4 věty). Kultivovaná čeština, jungovská noblesa. Pozdrav Haničce a Káte, dnešní hlavní priorita, proč je důležitá. Bez patosu.",
        },
        last_3_days: {
          type: "string",
          description: "Syntéza posledních 3 dnů (2-4 věty, ne raw log). Co se změnilo, jaké linie se ukazují. Konkrétní jména částí, ne 'systém'.",
        },
        lingering: {
          type: "string",
          description: "Co zůstává významné z dřívějška (1-3 věty). Jen skutečně relevantní věci, ne všechno staré.",
        },
        decisions: {
          type: "array",
          description: "Společná rozhodnutí pro dnešek. MAX 2 položky, +1 navíc jen pokud je crisis (= max 3 celkem). Konkrétní rozhodovací názvy, NE generické 'koordinovat strategii'. ID NEDOPLŇUJ — server přidá.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Krátký konkrétní rozhodovací název, např. 'Dnešní krizový plán pro Arthura'." },
              reason: { type: "string", description: "1-2 věty proč to potřebuje společnou shodu." },
              type: { type: "string", enum: ["crisis", "session_plan", "clinical_decision", "follow_up_review", "supervision"] },
              part_name: { type: "string", description: "Jméno části, které se to týká (pokud relevantní)." },
            },
            required: ["title", "reason", "type"],
            additionalProperties: false,
          },
          maxItems: 3,
        },
        proposed_session: {
          type: "object",
          description: "Dnešní navržené sezení. POVINNÉ pokud existují dostatečné signály. Pokud žádný kandidát nepřekročil práh skóre 3, nech null. ID NEDOPLŇUJ — server přidá.",
          properties: {
            part_name: { type: "string" },
            why_today: { type: "string", description: "Proč právě tato část a právě dnes (2-3 věty)." },
            led_by: { type: "string", enum: ["Hanička", "Káťa", "společně"] },
            duration_min: { type: "number", description: "Doporučená délka v minutách (10-45)." },
            first_draft: { type: "string", description: "První pracovní verze plánu sezení (3-5 vět). Co začít, kdy zůstat u stabilizace, kdy zvážit hlubší práci." },
            kata_involvement: { type: "string", description: "Jednou větou, zda dnes přizvat Káťu a za jakých okolností." },
            agenda_outline: {
              type: "array",
              description: "Strukturovaná minutáž sezení — 4 až 6 kroků. Každý krok má krátký název, doporučenou dobu a 1-2 věty co se v něm děje.",
              items: {
                type: "object",
                properties: {
                  block: { type: "string", description: "Krátký název kroku, např. 'Úvod a ground-check'." },
                  minutes: { type: "number", description: "Doporučená doba v minutách." },
                  detail: { type: "string", description: "1-2 věty co se v bloku konkrétně dělá." },
                },
                required: ["block"],
                additionalProperties: false,
              },
              minItems: 3,
              maxItems: 6,
            },
            questions_for_hanka: {
              type: "array",
              description: "1-3 konkrétní otázky pro Haničku ohledně tohoto sezení (její perspektiva: matka, primární terapeutka).",
              items: { type: "string" },
              maxItems: 3,
            },
            questions_for_kata: {
              type: "array",
              description: "1-3 konkrétní otázky pro Káťu ohledně tohoto sezení (její perspektiva: druhá terapeutka, supervize, externí pohled). MUSÍ být JINÉ než questions_for_hanka.",
              items: { type: "string" },
              maxItems: 3,
            },
          },
          required: ["part_name", "why_today", "led_by", "first_draft", "agenda_outline", "questions_for_hanka", "questions_for_kata"],
          additionalProperties: false,
        },
        ask_hanka: {
          type: "array",
          description: "Co Karel dnes potřebuje od Haničky. 1-3 konkrétní položky. Musí být JINÉ než ask_kata. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        ask_kata: {
          type: "array",
          description: "Co Karel dnes potřebuje od Káti. 1-3 konkrétní položky. Musí být JINÉ než ask_hanka. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        waiting_for: {
          type: "array",
          description: "Na co Karel čeká, než upraví finální postup (0-3 položky).",
          items: { type: "string" },
          maxItems: 3,
        },
        closing: {
          type: "string",
          description: "Krátký uzávěr (1-2 věty). Co se stane, jakmile Hanička a Káťa doplní své pohledy.",
        },
      },
      required: ["greeting", "last_3_days", "decisions", "ask_hanka", "ask_kata", "closing"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Jsi Karel — vedoucí terapeutického týmu (Hanička, Káťa).
Generuješ denní briefing pro poradu týmu o systému kluků (DID).

ABSOLUTNÍ PRAVIDLA JAZYKA:
- NIKDY neříkej "systém" nebo "DID systém". Vždy "kluci" nebo jménem konkrétní části.
- NIKDY neříkej "klient". Kluci jsou kluci.
- Konkrétní jména: Arthur, Tundrupek, Gerhard, Gustík atd. — používej je.

TÓN:
- Kultivovaná čeština, jungovská noblesa v úvodu, smyslu a přechodech.
- KRÁTKÉ a KONKRÉTNÍ názvy v rozhodovacích bodech a tasks.
- Žádný pseudo-log styl ("Dnes je nejdůležitější toto: …").
- Žádná pseudo-poezie, žádný patos.
- Žádné "Koordinovat strategii", "Synchronizovat úkoly", "Rozdělit si tasks" — to jsou ZAKÁZANÉ formulace.

REDUKCE TÝMOVÝCH BODŮ:
- Maximálně 2 společná rozhodnutí (+1 navíc jen pokud aktivní krize = max 3).
- Týmový bod smí vzniknout JEN pro: crisis | session_plan | clinical_decision | follow_up_review | supervision.
- NE pro běžnou operativu, individuální task pro Haničku, individuální task pro Káťu.

DNEŠNÍ NAVRŽENÉ SEZENÍ:
- Pokud kontext obsahuje kandidáta se skóre ≥ 3, MUSÍŠ navrhnout konkrétní sezení.
- Vyber nejvhodnějšího kandidáta z poskytnutého seznamu, NEvymýšlej jméno mimo seznam.
- Uveď: koho, proč právě dnes, kdo povede, první pracovní verze, kdy přizvat Káťu.

ROZDĚLENÍ ASKS:
- Hanička dostává JINÉ otázky než Káťa. Ne stejné body s prohozeným jménem.
- Hanička je v běžném kontaktu s kluky (každodenní, blízká).
- Káťa je z odstupu, ze vzdálenosti (~100 km), může ověřit dostupnost externích osob.

Vrať VÝHRADNĚ tool call emit_daily_briefing.`;

async function generateBriefing(
  context: any,
  candidates: SessionCandidate[],
  apiKey: string,
): Promise<{ payload: any; durationMs: number }> {
  const start = Date.now();

  const userPrompt = `KONTEXT PRO BRIEFING (${context.today}):

${context.pantry_a_summary ? `═══ SPIŽÍRNA A — RANNÍ PRACOVNÍ ZÁSOBA ═══\n${context.pantry_a_summary}\n\n` : ""}AKTIVNÍ KRIZE (${context.crises.length}):
${context.crises.map((c: any) => `- ${c.part_name} | severity: ${c.severity} | fáze: ${c.phase} | dní aktivní: ${c.days_active || "?"} | trigger: ${c.trigger_description?.slice(0, 120) || "—"}`).join("\n") || "(žádné)"}

POZOROVÁNÍ ZA POSLEDNÍ 3 DNY (${context.recent_observations.length}):
${context.recent_observations.slice(0, 20).map((o: any) => `- [${o.severity || "?"}] ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádná)"}

STARŠÍ VÝZNAMNÉ SIGNÁLY (high severity, 4-7 dní zpět):
${context.older_significant.map((o: any) => `- ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádné)"}

PENDING OTÁZKY (${context.pending_questions.length}):
${context.pending_questions.slice(0, 10).map((q: any) => `- pro ${q.asked_to || "?"} ohledně ${q.part_name || "?"}: ${(q.question || "").slice(0, 80)}`).join("\n") || "(žádné)"}

NEDÁVNÉ SESSION PLÁNY (3 dny):
${context.recent_session_plans.map((p: any) => `- ${p.session_date} | ${p.part_name || "?"} | status: ${p.status}`).join("\n") || "(žádné)"}

KANDIDÁTI NA DNEŠNÍ SEZENÍ (skórovací heuristika):
${candidates.length > 0 ? candidates.slice(0, 5).map((c) => `- ${c.part_name} (skóre ${c.score}): ${c.reasons.join(", ")}`).join("\n") : "(žádní silní kandidáti — proposed_session může být null)"}

ÚKOL:
Vygeneruj strukturovaný briefing pro dnešní poradu týmu. Drž se pravidel z system promptu.
${candidates[0]?.score >= 3 ? `MUSÍŠ navrhnout sezení — nejvhodnější kandidát je ${candidates[0].part_name}.` : "Pokud žádný kandidát nemá dost silné signály, nech proposed_session null."}`;

  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: [BRIEFING_TOOL],
      tool_choice: { type: "function", function: { name: "emit_daily_briefing" } },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limit překročen, zkuste to za chvíli.");
    if (res.status === 402) throw new Error("Vyčerpaný kredit Lovable AI workspace.");
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error("AI nevrátila tool call.");
  }

  const payload = JSON.parse(toolCall.function.arguments);
  return { payload, durationMs: Date.now() - start };
}

// ───────────────────────────────────────────────────────────
// MAIN HANDLER
// ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    if (!apiKey) throw new Error("LOVABLE_API_KEY není nastavený.");

    const supabase = createClient(supabaseUrl, serviceKey);

    let body: any = {};
    try { body = await req.json(); } catch { /* GET / no body */ }
    const generationMethod = body?.method || "manual";
    const forceRegenerate = body?.force === true;

    const today = pragueDayISO();

    // ───────────────────────────────────────────────────────────
    // CYCLE GUARD (auto only)
    // ───────────────────────────────────────────────────────────
    // Pravidlo: `auto` briefing nesmí stát kanonickým briefingem dne,
    // pokud dnešní `did-daily-cycle-morning` ještě nedoběhl (`completed`).
    //
    // State machine pro method="auto":
    //   - running   → SKIP: nevkládáme nový řádek, neoznačujeme staré jako stale,
    //                 neměníme manuální briefing. Vracíme 200 + skipped=true.
    //   - failed    → SKIP: stejné jako running, ale s reason="cycle_failed".
    //   - completed → POKRAČUJ normálně (může vzniknout kanonický briefing,
    //                 starý dnešní briefing se může označit stale).
    //   - missing   → SKIP: žádný dnešní cycle ještě neběžel → degraded mode,
    //                 auto briefing se nesmí stát kanonickým.
    //
    // method="manual" (UI tlačítko `Přegenerovat`) tento guard NEPOUŽÍVÁ —
    // ruční regenerace musí jít vždy, i bez completed cycle.
    if (generationMethod === "auto") {
      // MORNING WINDOW: 04:00–10:00 UTC
      // Důvod: ranní cron `did-daily-cycle-morning` startuje v 07:00 Praha
      //   = 05:00 UTC (léto) / 06:00 UTC (zima).
      // Okno 04:00–10:00 UTC pokrývá:
      //   - DST varianty (CET/CEST)
      //   - manuální backfill / retry téhož ranního runu
      //   - early start ±1h
      // Odpolední cron `did-daily-cycle-14cet` (15:00 Praha = 13:00/14:00 UTC)
      // do tohoto okna nespadá → guard ho ignoruje a nemůže způsobit falešný
      // skip auto briefingu.
      const morningStartUtc = `${today}T04:00:00Z`;
      const morningEndUtc   = `${today}T10:00:00Z`;
      const { data: cycleRow, error: cycleErr } = await supabase
        .from("did_update_cycles")
        .select("id, status, started_at, completed_at, last_error")
        .eq("cycle_type", "daily")
        .gte("started_at", morningStartUtc)
        .lt("started_at", morningEndUtc)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cycleErr) {
        console.error("[briefing-guard] cycle lookup error:", cycleErr);
      }

      const cycleStatus: "running" | "failed" | "completed" | "missing" =
        !cycleRow ? "missing" : (cycleRow.status as any);

      if (cycleStatus !== "completed") {
        const reason =
          cycleStatus === "running" ? "cycle_running" :
          cycleStatus === "failed"  ? "cycle_failed"  :
          "cycle_missing";
        console.warn(
          `[briefing-guard] auto SKIPPED — daily-cycle-morning status='${cycleStatus}' for ${today}. ` +
          `cycle_id=${cycleRow?.id || "(none)"} started_at=${cycleRow?.started_at || "(none)"}`,
        );
        return new Response(
          JSON.stringify({
            skipped: true,
            reason,
            cycle_status: cycleStatus,
            cycle_id: cycleRow?.id || null,
            cycle_started_at: cycleRow?.started_at || null,
            cycle_last_error: cycleRow?.last_error || null,
            briefing_date: today,
            note: "Auto briefing nebyl vygenerován — dnešní ranní cycle ještě nedoběhl. " +
                  "Existující briefing dne (manual nebo dřívější auto) zůstává kanonický.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Pokud existuje fresh briefing pro dnešek a nechceme force, vrať ho
    if (!forceRegenerate) {
      const { data: existing } = await supabase
        .from("did_daily_briefings")
        .select("*")
        .eq("briefing_date", today)
        .eq("is_stale", false)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        return new Response(
          JSON.stringify({ briefing: existing, cached: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // 1) Skórování kandidátů
    const candidates = await scoreSessionCandidates(supabase);

    // 2) Sběr kontextu
    const context = await gatherContext(supabase);

    // 3) AI generování
    const { payload, durationMs } = await generateBriefing(context, candidates, apiKey);

    // 3b) ── ASK ITEM IDENTITY ──
    // AI vrací ask_hanka/ask_kata jako string[]. Server přidá stabilní `id` na
    // každou položku tak, aby kliknutí v DidDailyBriefingPanel mohlo lazy-otevřít
    // kanonický `did_threads` workspace přes (workspace_type, workspace_id=item.id).
    //
    // PRAVIDLO IDENTITY (rozhodnuto 2026-04-19):
    //  - Carry-over přes ilike text-match v rámci téhož `briefing_date`:
    //    při force-regenerate stejného dne se znovupoužije `id` ze starého
    //    briefingu (i `is_stale=true` verze) pokud nový text odpovídá starému.
    //  - Mezi různými dny: vždy nové `id` (briefing ask je denní zadání).
    //  - Žádný cross-day match — pokud bychom chtěli vícedenní kontinuitu,
    //    má se řešit explicitním follow-up linkem, ne reuse stejného ask ID.
    const normalizeForMatch = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);

    type AskItem = { id: string; text: string };
    type AskRole = "ask_hanka" | "ask_kata";

    const carryOverAsks = async (
      role: AskRole,
      newTexts: string[],
    ): Promise<AskItem[]> => {
      if (!Array.isArray(newTexts) || newTexts.length === 0) return [];

      // Načti VŠECHNY briefingy téhož dne (i stale), seřaď nejnovější → nejstarší.
      const { data: sameDayBriefings } = await supabase
        .from("did_daily_briefings")
        .select("payload")
        .eq("briefing_date", today)
        .order("generated_at", { ascending: false });

      // Sesbírej všechny kandidáty na carry-over (id+text) ze stejné role.
      const carryPool: AskItem[] = [];
      for (const row of sameDayBriefings || []) {
        const old = (row?.payload as any)?.[role];
        if (!Array.isArray(old)) continue;
        for (const item of old) {
          // Akceptuj jen už-migrované {id,text} položky (legacy string[] přeskoč)
          if (item && typeof item === "object" && item.id && typeof item.text === "string") {
            carryPool.push({ id: String(item.id), text: String(item.text) });
          }
        }
      }

      const usedIds = new Set<string>();
      const result: AskItem[] = [];
      for (const text of newTexts) {
        const t = String(text ?? "").trim();
        if (!t) continue;
        const nt = normalizeForMatch(t);

        // Najdi první nepoužitý carry kandidát, který se kryje (substring v jednom směru).
        const match = carryPool.find((c) => {
          if (usedIds.has(c.id)) return false;
          const nc = normalizeForMatch(c.text);
          if (!nc) return false;
          return nc === nt || nc.includes(nt) || nt.includes(nc);
        });

        if (match) {
          usedIds.add(match.id);
          result.push({ id: match.id, text: t });
        } else {
          result.push({ id: crypto.randomUUID(), text: t });
        }
      }
      return result;
    };

    // Přepiš plain string[] → {id,text}[] s carry-over identitou.
    const askHankaRaw = Array.isArray(payload?.ask_hanka) ? payload.ask_hanka : [];
    const askKataRaw = Array.isArray(payload?.ask_kata) ? payload.ask_kata : [];
    payload.ask_hanka = await carryOverAsks(
      "ask_hanka",
      askHankaRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );
    payload.ask_kata = await carryOverAsks(
      "ask_kata",
      askKataRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );

    // 3c) ── DECISIONS / PROPOSED_SESSION ITEM IDENTITY (Slice 3) ──
    // Stejný pattern jako u asks: server přidá stabilní `id` na každou položku
    // (decisions[*].id, proposed_session.id), s carry-over přes ilike-match
    // v rámci téhož `briefing_date`. Tento `id` je pak `linked_briefing_item_id`
    // při vzniku `did_team_deliberations` — druhý klik na stejnou položku
    // briefingu otevře tutéž poradu místo zakládání nové.
    type DecisionItem = {
      id: string;
      title: string;
      reason: string;
      type: string;
      part_name?: string;
    };
    type ProposedSessionItem = {
      id: string;
      part_name: string;
      [key: string]: any;
    };

    // Pre-load same-day briefings (incl. stale) once for both decisions and proposed_session.
    const { data: sameDayPrev } = await supabase
      .from("did_daily_briefings")
      .select("payload")
      .eq("briefing_date", today)
      .order("generated_at", { ascending: false });

    // ── Decisions carry-over (match by normalized title) ──
    const decisionsRaw = Array.isArray(payload?.decisions) ? payload.decisions : [];
    const decisionPool: { id: string; title: string }[] = [];
    for (const row of sameDayPrev || []) {
      const old = (row?.payload as any)?.decisions;
      if (!Array.isArray(old)) continue;
      for (const item of old) {
        if (item && typeof item === "object" && item.id && typeof item.title === "string") {
          decisionPool.push({ id: String(item.id), title: String(item.title) });
        }
      }
    }
    const usedDecisionIds = new Set<string>();
    payload.decisions = decisionsRaw.map((d: any): DecisionItem => {
      const title = String(d?.title ?? "").trim();
      const nt = normalizeForMatch(title);
      const match = decisionPool.find((c) => {
        if (usedDecisionIds.has(c.id)) return false;
        const nc = normalizeForMatch(c.title);
        if (!nc) return false;
        return nc === nt || nc.includes(nt) || nt.includes(nc);
      });
      const id = match ? match.id : crypto.randomUUID();
      if (match) usedDecisionIds.add(match.id);
      return {
        id,
        title,
        reason: String(d?.reason ?? ""),
        type: String(d?.type ?? "team_task"),
        ...(d?.part_name ? { part_name: String(d.part_name) } : {}),
      };
    });

    // ── proposed_session carry-over (single object; match by part_name) ──
    if (payload?.proposed_session && typeof payload.proposed_session === "object") {
      const ps = payload.proposed_session;
      const partName = String(ps?.part_name ?? "").trim();
      const np = normalizeForMatch(partName);
      let resolvedId: string | null = null;
      for (const row of sameDayPrev || []) {
        const oldPs = (row?.payload as any)?.proposed_session;
        if (oldPs && typeof oldPs === "object" && oldPs.id && oldPs.part_name) {
          const op = normalizeForMatch(String(oldPs.part_name));
          if (op === np) {
            resolvedId = String(oldPs.id);
            break;
          }
        }
      }
      payload.proposed_session = {
        ...ps,
        id: resolvedId || crypto.randomUUID(),
      } as ProposedSessionItem;
    }

    // 4) Resolve part_id pro proposed_session
    let proposedPartId: string | null = null;
    if (payload.proposed_session?.part_name) {
      const { data: part } = await supabase
        .from("did_parts")
        .select("id")
        .ilike("name", payload.proposed_session.part_name)
        .maybeSingle();
      proposedPartId = part?.id || null;
    }

    // 5) Označit staré briefingy pro dnešek jako stale
    if (forceRegenerate) {
      await supabase
        .from("did_daily_briefings")
        .update({ is_stale: true })
        .eq("briefing_date", today);
    }

    // 6) Insert nový briefing
    const { data: inserted, error: insertErr } = await supabase
      .from("did_daily_briefings")
      .insert({
        briefing_date: today,
        payload,
        proposed_session_part_id: proposedPartId,
        proposed_session_score: candidates[0]?.score || null,
        decisions_count: payload.decisions?.length || 0,
        generation_method: generationMethod,
        generation_duration_ms: durationMs,
        model_used: MODEL,
        is_stale: false,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({ briefing: inserted, cached: false, candidates: candidates.slice(0, 5) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[karel-did-daily-briefing] Error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
