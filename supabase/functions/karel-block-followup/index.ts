/**
 * karel-block-followup (v2 — clinical state machine)
 * --------------------------------------------------
 * Bod programu vede pevný klinický playbook (viz _shared/clinicalPlaybooks.ts).
 * Karel jede stavový automat, ne volné improvizování:
 *
 *   phase: "setup" → "running" → ("trauma_pause" ⇄ "running") → "closure" → "done"
 *
 * Anti-loop guard: pokud má aktuální stimul vyplněnou odpověď a není trauma_flag,
 * Karel MUSÍ vrátit další stimul nebo closure — nikdy znovu stejný stimul.
 *
 * Trauma branch: detekce klíčových slov v poslední Hanině zprávě
 * (flashback, týrání, freeze, disociace, pláč, ztuhla, zbledla, schovala se,
 *  panika, zničila kresbu) → phase=trauma_pause, do_not_repeat_stimulus.
 *
 * Vstup:
 *   {
 *     part_name, therapist_name,
 *     program_block: { index, text, detail? },
 *     research?: ResearchOutput,
 *     turns: [{from, text, ts}],
 *     state?: ProtocolState,            // pokud chybí, vyrobí se z playbooku
 *     trigger: "auto_next"|"ask_karel"|"user_input"|"start"
 *   }
 *
 * Výstup:
 *   {
 *     karel_text: string,
 *     phase: PlaybookPhase,
 *     state_patch: Partial<ProtocolState>,
 *     done: boolean,
 *     missing_artifacts?: ("image"|"audio")[],
 *     suggested_close_message?: string,
 *     red_flags_seen?: string[],
 *   }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import {
  detectPlaybook,
  renderPlaybookForPrompt,
  type Playbook,
  type PlaybookPhase,
} from "../_shared/clinicalPlaybooks.ts";
import {
  parseProgramBlocks,
  resolveCurrentBlockIndex,
  isTherapistAcknowledgement,
  isTherapistCorrection,
  validateAiOutputForBlock,
  safeParseJsonString,
  buildEmptyAiFallback,
  type ParsedBlock,
  type ProgressItem,
} from "../_shared/blockStateMachine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

/** Nahlédnutí do nedávné historie metody u dané části (anti-repetition + promising). */
async function loadPartMethodHistory(partName: string): Promise<{
  banned: Array<{ method_key: string; variant_used: string; session_date: string }>;
  struggling: string[];
  promising: Array<{ method_key: string; hint: string | null }>;
}> {
  if (!partName) return { banned: [], struggling: [], promising: [] };
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("did_part_method_history")
      .select("method_key, variant_used, session_date, clinical_yield, tolerance, trauma_marker, next_step_hint")
      .eq("part_id", partName)
      .gte("session_date", cutoff)
      .order("session_date", { ascending: false })
      .limit(40);
    if (error || !data) return { banned: [], struggling: [], promising: [] };
    return {
      banned: data.map((r: any) => ({
        method_key: r.method_key,
        variant_used: r.variant_used ?? "(žádná konkrétní varianta)",
        session_date: r.session_date,
      })),
      struggling: Array.from(new Set(data.filter((r: any) => (r.tolerance ?? 5) < 2 || r.trauma_marker).map((r: any) => r.method_key))),
      promising: data.filter((r: any) => (r.clinical_yield ?? 0) >= 4).map((r: any) => ({ method_key: r.method_key, hint: r.next_step_hint })),
    };
  } catch (e) {
    console.warn("[block-followup] history load failed:", e);
    return { banned: [], struggling: [], promising: [] };
  }
}

/** Po uzavření bodu zaloguj historii pro learning. */
async function logMethodHistory(payload: {
  partName: string;
  method_key: string;
  variant_used?: string;
  session_id?: string;
  responses_count: number;
  trauma_flag: boolean;
  red_flags: string[];
  step_total: number;
}): Promise<void> {
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    // heuristický odhad clinical_yield (1-5) a tolerance (1-5)
    const completionRatio = payload.step_total > 0 ? Math.min(1, payload.responses_count / payload.step_total) : 1;
    const tolerance = Math.max(1, Math.min(5, Math.round(5 - (payload.trauma_flag ? 2.5 : 0) - (payload.red_flags.length * 0.5))));
    const clinical_yield = Math.max(1, Math.min(5, Math.round(2 + completionRatio * 2 + (payload.responses_count > 0 ? 1 : 0))));

    const { data: lib } = await sb
      .from("karel_method_library")
      .select("id")
      .eq("method_key", payload.method_key)
      .maybeSingle();

    await sb.from("did_part_method_history").insert({
      part_id: payload.partName,
      part_name: payload.partName,
      method_key: payload.method_key,
      method_library_id: lib?.id ?? null,
      variant_used: payload.variant_used ?? null,
      session_id: payload.session_id ?? null,
      clinical_yield,
      tolerance,
      trauma_marker: payload.trauma_flag,
      notes_md: payload.red_flags.length
        ? `Red flags: ${payload.red_flags.join(", ")}. Responses: ${payload.responses_count}/${payload.step_total}.`
        : `Responses: ${payload.responses_count}/${payload.step_total}.`,
      next_step_hint: payload.trauma_flag
        ? "U této části byla metoda emočně náročná — příště zvolit jemnější variantu / jinou modalitu."
        : completionRatio >= 0.8
        ? "Metoda byla dobře tolerována a poskytla data — možno opakovat jiné varianty stimulů."
        : "Metoda se nedokončila — příště zvážit jinou metodu nebo kratší formu.",
    });
  } catch (e) {
    console.warn("[block-followup] logMethodHistory failed:", e);
  }
}

type Turn = { from: string; text: string; ts?: string };

type ProtocolState = {
  method_id: string | null;
  phase: PlaybookPhase;
  step_index: number;          // kolikátý stimul (0-based)
  planned_steps: string[];     // pro asocie: 8 slov
  responses: Array<{ stimulus: string; verbatim: string; latency_s?: number; affect?: string; nonverbal?: string; therapist_note?: string }>;
  trauma_flag: boolean;
  red_flags_seen: string[];
};

const TRAUMA_KEYWORDS = [
  "flashback","flash back","flešbek",
  "týrání","tyrani","tyran","zneuzit","zneužit",
  "freeze","ztuhl","zbledl","schova","schoval","zb[ďďl]",
  "disociac","disocia","ztratil kontakt",
  "plá[čc]","pla[čc]","brečí","brec",
  "panik","úzkost","uzkost",
  "trauma","abuz","násil","nasil",
  "ztichla","ztichl","mlčí","mlci",
  "rozbila kresbu","zničila","znicila","roztrhal","roztrhala",
];

function detectTraumaInLastHana(turns: Turn[]): { triggered: boolean; matched: string[] } {
  const lastHana = [...turns].reverse().find(t => t.from === "hana");
  if (!lastHana) return { triggered: false, matched: [] };
  const txt = lastHana.text.toLowerCase();
  const matched: string[] = [];
  for (const kw of TRAUMA_KEYWORDS) {
    try {
      if (new RegExp(kw).test(txt)) matched.push(kw);
    } catch { /* skip bad regex */ }
  }
  return { triggered: matched.length > 0, matched };
}

function bootstrapState(playbook: Playbook | null, plannedFromResearch: string[] = []): ProtocolState {
  const planned =
    playbook?.step_protocol.planned_steps && playbook.step_protocol.planned_steps.length
      ? playbook.step_protocol.planned_steps
      : plannedFromResearch;
  return {
    method_id: playbook?.method_id ?? null,
    phase: "setup",
    step_index: 0,
    planned_steps: planned,
    responses: [],
    trauma_flag: false,
    red_flags_seen: [],
  };
}

/**
 * Z turns rekonstruujeme responses[] (heuristicky):
 * každý sudý pár Karel→Hana = 1 zaznamenaná odpověď.
 * Tohle slouží JEN pro anti-loop guard, AI dostává plný transcript.
 */
function reconstructResponses(turns: Turn[], plannedSteps: string[]): ProtocolState["responses"] {
  const out: ProtocolState["responses"] = [];
  let pendingStimulus: string | null = null;
  for (const t of turns) {
    if (t.from === "karel") {
      // detekuj, jestli Karel právě dal stimul (krátká fráze, často slovo z planned_steps)
      const lower = t.text.toLowerCase();
      const matched = plannedSteps.find(s => lower.includes(s.toLowerCase()));
      if (matched) pendingStimulus = matched;
      else if (t.text.length < 80) pendingStimulus = t.text.trim();
    } else if (t.from === "hana" && pendingStimulus) {
      out.push({ stimulus: pendingStimulus, verbatim: t.text });
      pendingStimulus = null;
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Accept either: (a) Bearer user JWT, (b) Bearer service-role, or
    // (c) X-Karel-Cron-Secret header validated against vault. Path (c) is
    // used by acceptance tests + cron without exposing service-role.
    const auth = req.headers.get("Authorization") ?? "";
    const cronSecret = req.headers.get("x-karel-cron-secret") ?? req.headers.get("X-Karel-Cron-Secret") ?? "";
    let isServiceRole = false;
    let isCronAuth = false;

    if (cronSecret) {
      try {
        const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
        const { data: ok } = await sb.rpc("verify_karel_cron_secret", { p_secret: cronSecret });
        isCronAuth = ok === true;
      } catch (e) {
        console.warn("[block-followup] cron secret verify failed:", e);
      }
      if (!isCronAuth) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      if (!auth.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "missing auth" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const bearerToken = auth.slice("Bearer ".length).trim();
      isServiceRole = !!(SERVICE_ROLE && bearerToken === SERVICE_ROLE);
      if (!isServiceRole) {
        const userClient = createClient(SUPABASE_URL, ANON_KEY, {
          global: { headers: { Authorization: auth } },
        });
        const { data: userData, error: userErr } = await userClient.auth.getUser();
        if (userErr || !userData?.user) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const body = await req.json().catch(() => ({}));

    // ─── TEST-ONLY HOOKS ───
    // Forced fallback paths return only the deterministic safe text (no
    // sensitive data), so they are accepted from any authenticated caller.
    const forceAiEmpty = body?.test_force_ai_empty_body === true;
    const forceAiInvalid = body?.test_force_ai_invalid_json === true;
    const partName = String(body?.part_name ?? "").trim();
    const therapistName = String(body?.therapist_name ?? "Hanka").trim();
    const block = body?.program_block ?? null;
    const research = body?.research ?? null;
    const turns: Turn[] = Array.isArray(body?.turns) ? body.turns : [];
    const trigger = String(body?.trigger ?? "user_input");
    const incomingState: Partial<ProtocolState> | null = body?.state ?? null;

    if (!partName || !block?.text) {
      return new Response(JSON.stringify({ error: "bad input" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── SERVER-SIDE BLOCK AUTHORITY (SEV-1 fix 2026-04-30) ───
    // The DB row in did_live_session_progress is the single source of truth
    // for "which block is current". Client may send a stale block.index.
    // We override with DB authority and detect if the proposed block doesn't
    // match what's actually current.
    const sessionId = typeof body?.session_id === "string" ? body.session_id : null;
    let authoritativeBlock: ParsedBlock | null = null;
    let authoritativeIndex: number = typeof block.index === "number" ? block.index : 0;
    let allBlocksDone = false;
    let authorityReason = "client_only";
    let parsedBlocks: ParsedBlock[] = [];

    if (sessionId) {
      try {
        const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
        const [{ data: planRow }, { data: progRow }] = await Promise.all([
          sb.from("did_daily_session_plans").select("plan_markdown").eq("id", sessionId).maybeSingle(),
          sb.from("did_live_session_progress").select("items").eq("plan_id", sessionId).maybeSingle(),
        ]);
        const planMd = String((planRow as any)?.plan_markdown ?? "");
        parsedBlocks = parseProgramBlocks(planMd);
        const items = ((progRow as any)?.items ?? null) as ProgressItem[] | null;
        const resolution = resolveCurrentBlockIndex(parsedBlocks, items, typeof block.index === "number" ? block.index : null);
        authoritativeIndex = resolution.index;
        authoritativeBlock = resolution.block;
        allBlocksDone = resolution.allDone;
        authorityReason = resolution.reason;
      } catch (e) {
        console.warn("[block-followup] authority lookup failed (continuing with client hint):", e);
      }
    }

    // If authority disagrees with client, log it. We DO NOT override the
    // text content (client text is what therapist sees), but we DO use
    // authoritative isFinal/kind for guardrails.
    const effectiveBlock: ParsedBlock = authoritativeBlock ?? {
      index: typeof block.index === "number" ? block.index : 0,
      title: String(block.text || "").split(" — ")[0] || String(block.text || ""),
      detail: typeof block.detail === "string" ? block.detail : undefined,
      kind: "generic",
      isFinal: false,
    };

    // ─── THERAPIST INTENT GUARD ───
    // Short ack ("ano") on a FINAL block must NOT trigger new diagnostic
    // activity. Return a deterministic stay-in-closure response.
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const lastFromTherapist = lastTurn && lastTurn.from !== "karel";
    const lastTherapistText = lastFromTherapist ? String(lastTurn.text || "") : "";
    const isAck = lastFromTherapist && isTherapistAcknowledgement(lastTherapistText);
    const isCorrection = lastFromTherapist && isTherapistCorrection(lastTherapistText);

    if (effectiveBlock.isFinal && (isAck || isCorrection || allBlocksDone)) {
      const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";
      const text = isCorrection
        ? `${therapistAddr}, máš pravdu — zůstáváme v závěrečném bloku „${effectiveBlock.title}". Žádnou novou aktivitu nezavádím. Prosím:\n• Krátce shrň, co dnes opravdu společně proběhlo.\n• Zaznamenej poslední reakci kluků verbatim.\n• Měkce uzavři: poděkuj, řekni „uvidíme se příště".`
        : `${therapistAddr}, jsme v závěrečném bloku „${effectiveBlock.title}". Pokračuj v měkkém uzavření — žádnou novou aktivitu nezavádíme. Prosím zaznamenej poslední reakci kluků verbatim a jemně uzavři.`;
      return new Response(JSON.stringify({
        karel_text: text,
        phase: "closure",
        state_patch: { phase: "closure" },
        done: false,
        missing_artifacts: [],
        authority: { source: "server_state_machine", reason: authorityReason, block_index: authoritativeIndex, is_final: true, ack_detected: !!isAck, correction_detected: !!isCorrection, all_done: allBlocksDone },
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const blockNum = typeof block.index === "number" ? block.index + 1 : "?";
    const blockText = String(block.text + (block.detail ? ` — ${block.detail}` : ""));

    // 1) DETEKUJ PLAYBOOK
    const playbook = detectPlaybook(blockText);

    // 2) STAV — bootstrap nebo doplnění
    // ── HARD GUARD (2026-04-23): planned_steps z research přijmeme JEN tehdy,
    // když detekovaný playbook je sequence_words (asociační experiment).
    // Bez této pojistky AI v karel-block-research občas vrátí 8 slov i pro
    // šachy / kresbu / hru → followup pak spustí asociační režim místo
    // skutečné metody bodu. Stejně tak ignorujeme planned_steps z incomingState,
    // pokud bod NENÍ sequence_words (state mohl prosáknout z předchozího bodu).
    const playbookIsSequence = playbook?.step_protocol.kind === "sequence_words";
    const plannedFromResearchRaw: string[] = Array.isArray(research?.planned_steps) ? research.planned_steps : [];
    const plannedFromResearch = playbookIsSequence ? plannedFromResearchRaw : [];
    const baseState = bootstrapState(playbook, plannedFromResearch);
    const incomingPlanned = (incomingState?.planned_steps && incomingState.planned_steps.length && playbookIsSequence)
      ? incomingState.planned_steps
      : null;
    const state: ProtocolState = {
      ...baseState,
      ...(incomingState || {}),
      planned_steps: incomingPlanned ?? baseState.planned_steps,
    };

    // Rekonstrukce responses (anti-loop guard) — jen pokud máme reálné stimuly
    if (state.responses.length === 0 && state.planned_steps.length) {
      state.responses = reconstructResponses(turns, state.planned_steps);
      // step_index = počet zaznamenaných odpovědí (další volný stimul)
      state.step_index = Math.max(state.step_index, state.responses.length);
    }

    // 3) TRAUMA DETEKCE
    const trauma = detectTraumaInLastHana(turns);
    if (trauma.triggered && state.phase !== "closure" && state.phase !== "done") {
      state.phase = "trauma_pause";
      state.trauma_flag = true;
      for (const m of trauma.matched) if (!state.red_flags_seen.includes(m)) state.red_flags_seen.push(m);
    }

    // 3b) ANTI-REPETITION + LEARNING (per-part historie metod, 14 dní)
    const partHistory = await loadPartMethodHistory(partName);
    const nextStimulus =
      state.planned_steps.length > 0 && state.step_index < state.planned_steps.length
        ? state.planned_steps[state.step_index]
        : null;
    const isAtEnd = state.planned_steps.length > 0 && state.step_index >= state.planned_steps.length;

    // pokud nejsme v setup a nejsme v traumě a máme další stimul → AI ho MUSÍ použít
    const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";
    let phaseDirective = "";
    if (trigger === "start" || (state.phase === "setup" && turns.length === 0)) {
      phaseDirective = `FÁZE = SETUP pro KONKRÉTNÍ bod #${blockNum}: "${blockText}".

POVINNÁ STRUKTURA setupu (cca 8–14 řádků, ne víc):
1) **Cíl tohoto konkrétního bodu** (1 věta): proč ho děláme PRÁVĚ TEĎ s ${partName} a co od něj klinicky čekáme. NEPřepisuj cíl z jiné metody. Cíl MUSÍ vycházet z přesného textu bodu výše.
2) **Pomůcky na míru** — konkrétní pro tento bod (papír, tužka/pastelky, sdílená obrazovka, hračka, audio…). Pokud je to kresba imaginární postavy (např. "strážce", "ochránce", "monstrum"), POVOL barevné pastelky/fixy — nejde o standardní DAP test, kde se používá jen tužka.
3) **Pozice a prostředí** (1 věta).
4) **Doslovná instrukce ${partName}** v uvozovkách — MUSÍ obsahovat klíčová slova z textu bodu (např. když bod říká "strážce spánku, který ho v noci ochrání před lékem", instrukce musí mluvit o strážci, spánku a léku, ne o "postavě" obecně).
5) **Co terapeutka NEsmí** dělat (1–2 body specifické pro tento bod).
6) **Co POVINNĚ zaznamenat** každý turn: latence (s), verbatim, afekt, neverbální. Plus 2–3 specifická pozorování pro tento bod (např. u kresby strážce: jaké barvy zvolí, kam strážce umístí, co o něm spontánně řekne, zda nakreslí i ohrožení).

ZÁKAZY:
- NEPřepisuj setup z předchozího bodu programu (žádné "asociační hra", žádné "kresba postavy podle Machover", pokud to není opravdu tato metoda).
- Pokud playbook níže neodpovídá tématu bodu, IGNORUJ jeho doslovnou instrukci a vyrob NOVOU na míru bodu — playbook ber jen jako rámcovou inspiraci pro to, co měřit.
- ŽÁDNÝ stimulus, žádná otázka pro ${partName} v tomto turnu.

Konči přesně otázkou: „Rozumíš všemu, ${therapistAddr}? Když ano, dej mi vědět a začneme."`;
      state.phase = "setup";
    } else if (state.phase === "trauma_pause") {
      phaseDirective = `FÁZE = TRAUMA_PAUSE. Detekované trauma signály: ${state.red_flags_seen.join(", ")}.
TVOJE POVINNÁ STRUKTURA odpovědi:
1) Validace pro terapeutku: „${therapistName}, to co popisuješ je klinicky významné — je to indikátor komplexu vázaného k tématu, ne selhání metody."
2) Klinické vysvětlení v 1-2 větách (proč právě toto slovo / podnět spustil reakci).
3) ZÁKAZ opakování stejného stimulu (do_not_repeat_stimulus = true u asociačního experimentu).
4) Konkrétní grounding skript dítěti (cituj z playbooku).
5) Rozhodnutí: a) pokračovat dalším stimulem za X minut / b) přerušit zbytek metody / c) přejít rovnou do closure.
6) Co PŘESNĚ má terapeutka teď zaznamenat (formulace dítěte verbatim, neverbální).
NIKDY se neptej znovu na poslední stimul. NIKDY neříkej „bez zásahu — drž prostor".`;
    } else if (isAtEnd) {
      phaseDirective = `FÁZE = CLOSURE. Všech ${state.planned_steps.length} stimulů proběhlo. Vyžádej:
1) Reprodukční zkoušku (pokud playbook má): pauza 5–10 min, pak požádej dítě o zopakování slov a odpovědí. Reprodukční chyba = silný indikátor komplexu.
2) Debrief otázky (cituj z playbooku).
3) Vyhodnoť, jestli máš dost dat pro analýzu. POVINNĚ zkontroluj verbatim odpovědi, latence v sekundách, afekt/neverbální reakce a reprodukční kontrolu.
4) Pokud něco chybí, explicitně napiš, že pozdější diagnostická analýza bude jen orientační, a uveď chybějící data. Pokud chybí audio/foto, vrať je v missing_artifacts.
Když je vše splněno nebo terapeutka vědomě uzavírá s omezenou validitou, nastav done=true.`;
    } else if (nextStimulus) {
      phaseDirective = `FÁZE = RUNNING. Zaznamenáno ${state.step_index}/${state.planned_steps.length} odpovědí.
DALŠÍ POVINNÝ STIMULUS k podání = "${nextStimulus}" (krok ${state.step_index + 1}/${state.planned_steps.length}).

TVOJE odpověď MUSÍ obsahovat PŘESNĚ tyto části:
A) Krátký klinický komentář k poslední odpovědi dítěte (1 věta) — co to indikuje (latence, klang, perseverace, neutrální…). Pokud zatím žádná odpověď není, vynech.
B) Stimulus na další krok přesně ve formátu: „Slovo ${state.step_index + 1}/${state.planned_steps.length}: **${nextStimulus.toUpperCase()}**".
C) Připomeň co měřit: „Zapiš verbatim odpověď + latenci v sekundách + afekt + neverbální."

NIKDY neopakuj žádný stimul, který už má v responses zaznamenanou odpověď. NIKDY se neptej „chceš pokračovat?" — pokračuj.`;
    } else {
      // playbook bez planned_steps (kresba, narativ, hra) — open dialog
      phaseDirective = `FÁZE = RUNNING (volný protokol — kresba/narativ/hra).
Reaguj klinicky na poslední Haninu poznámku, polož další KONKRÉTNÍ post-drawing/inquiry otázku z playbooku.
Připomeň co měřit (tlak tužky, pořadí, umístění, verbatim, afekt, neverbální reakce, věk/vývojová přiměřenost).
Pokud jde o kresbu/artefakt, bez fotky a post-drawing inquiry NESMÍŠ formulovat profesionální závěr — jen orientační hypotézu.
Když máš dost dat (pokrylo se min. 70 % observe_criteria), navrhni closure (done=true a missing_artifacts).`;
    }

    // 5) SESTAV PROMPT
    const playbookBlock = playbook
      ? renderPlaybookForPrompt(playbook, state.planned_steps)
      : `(pro tento bod nebyl nalezen pevný playbook — řiď se obecnými klinickými principy a níže uvedenou rešerší)`;

    const researchBlock = research
      ? `\n═══ DOPLŇUJÍCÍ REŠERŠE ═══
${research.method_label ? `Metoda: ${research.method_label}` : ""}
${(research.observe_criteria ?? []).length ? `Co sledovat: ${(research.observe_criteria ?? []).join("; ")}` : ""}
${(research.expected_artifacts ?? []).length ? `Očekávané artefakty: ${(research.expected_artifacts ?? []).join(", ")}` : ""}`
      : "";

    const stateBlock = `═══ AKTUÁLNÍ STAV PROTOKOLU ═══
method_id: ${state.method_id ?? "(neidentifikováno)"}
phase: ${state.phase}
step_index: ${state.step_index} / ${state.planned_steps.length || "n/a"}
planned_steps: ${state.planned_steps.length ? state.planned_steps.map((s, i) => `${i + 1}.${s}`).join(" | ") : "(žádné — open dialog)"}
zaznamenané odpovědi (responses): ${state.responses.length === 0 ? "(zatím žádné)" : state.responses.map((r, i) => `[${i + 1}] "${r.stimulus}" → "${r.verbatim.slice(0, 80)}"`).join(" || ")}
trauma_flag: ${state.trauma_flag ? "ANO" : "ne"}
red_flags_seen: ${state.red_flags_seen.join(", ") || "(žádné)"}`;

    const turnsText = turns.length
      ? turns
          .slice(-30)
          .map((t, i) => `${i + 1}. [${t.from === "karel" ? "KAREL" : therapistName.toUpperCase()}]: ${String(t.text).slice(0, 500)}`)
          .join("\n")
      : "(zatím žádné turny)";

    const tools = [
      {
        type: "function",
        function: {
          name: "emit_followup",
          description: "Klinická reakce ve struktuře (povinný state machine).",
          parameters: {
            type: "object",
            properties: {
              karel_text: { type: "string", description: "Co Karel teď říká terapeutce. Strukturovaně dle phaseDirective. Česky, vřele, profesionálně, KONKRÉTNĚ." },
              phase_next: { type: "string", enum: ["setup", "running", "trauma_pause", "closure", "done"] },
              advance_step: { type: "boolean", description: "True pokud Karel právě podal nový stimulus (step_index += 1)." },
              done: { type: "boolean", description: "True jen když je celý protokol splněn a Karel má dost dat pro analýzu." },
              missing_artifacts: {
                type: "array",
                items: { type: "string", enum: ["image", "audio"] },
                description: "Pokud done=true ale chybí artefakty.",
              },
              suggested_close_message: { type: "string", description: "Závěrečné shrnutí pro terapeutku (jen když done=true)." },
            },
            required: ["karel_text", "phase_next"],
            additionalProperties: false,
          },
        },
      },
    ];

    const sysPrompt = `Jsi Karel — zkušený klinický psycholog/psychoterapeut a expert na disociativní poruchy (DID), traumaterapii a dětskou psychodiagnostiku. Vedeš ${therapistName} (terapeutku) krok-za-krokem v živém sezení s částí "${partName}" (DID kluk).

PRAVIDLA, KTERÁ NESMÍŠ PORUŠIT:
1. Playbook níže = METODOLOGICKÝ RÁMEC (co měřit, jaké red flags, jak debriefovat). OBSAH a CÍL aktivity vždy vychází z TEXTU KONKRÉTNÍHO BODU PROGRAMU, ne z generické šablony playbooku. Pokud se text bodu zaměřuje na specifický symbol (strážce, ochránce, rodina, místo z noční můry, lék jménem X…), MUSÍ se to přímo objevit v doslovné instrukci pro ${partName}.
2. NIKDY nerecykluj setup z předchozího bodu programu (žádný copy-paste asociační hry / kresby postavy, pokud aktuální bod není přesně to).
3. NIKDY se neptej znovu na stimulus, který už má zaznamenanou odpověď (anti-loop). Sleduj responses[].
4. Při traumatickém signálu (flashback, týrání, freeze, pláč, ztuhnutí, schování, panika, disociace) OKAMŽITĚ přejdi do trauma_pause — žádné mechanické pokračování v testu. Validuj, vysvětli klinický význam, dej grounding, rozhodni o tempu.
5. Před prvním stimulem POVINNĚ vysvětli pre-session setup (pomůcky, pozice, co říct dítěti, co měřit). Bez setupu Karlova analýza nebude validní.
6. Buď KONKRÉTNÍ a STRUČNÝ. Žádné meta-rady, žádné „drž prostor". Žádné obecné fráze. Vždy: konkrétní další krok + co přesně sledovat/zapsat.
7. Mluvíš česky, vřele, ale s autoritou klinika.
8. PROFESIONÁLNÍ DIAGNOSTICKÁ VALIDITA: nikdy nepředstírej standardizovanou psychodiagnostiku. Bez povinných dat (verbatim, latence, afekt, neverbální, artefakt, inquiry) označ závěry jako omezené pracovní hypotézy. ROR/Rorschach nikdy neskóruj jako plný Rorschach bez kompletní licencované administrace.`;

    const historyBlock = (partHistory.banned.length || partHistory.struggling.length || partHistory.promising.length)
      ? `\n═══ HISTORIE METOD U ČÁSTI „${partName}" (posledních 14 dní) ═══
ZAKÁZANÉ KOMBINACE (anti-repetition — POVINNÁ VARIACE pokud tutéž metodu volíš znovu):
${partHistory.banned.length ? partHistory.banned.map((b) => `• ${b.method_key} | varianta: ${b.variant_used} | ${b.session_date}`).join("\n") : "(žádné)"}
KULHAJÍCÍ METODY (nízká tolerance / trauma marker — zvol jinou modalitu nebo zjemni):
${partHistory.struggling.length ? partHistory.struggling.map((m) => `• ${m}`).join("\n") : "(žádné)"}
PROSPÍVAJÍCÍ METODY (clinical_yield ≥ 4 — můžeš na ně navázat jinou variantou):
${partHistory.promising.length ? partHistory.promising.map((p) => `• ${p.method_key}${p.hint ? ` — hint: ${p.hint}` : ""}`).join("\n") : "(žádné)"}
PRAVIDLO: pokud aktuální metoda spadá do BANNED, MUSÍŠ použít NOVOU variantu (jiný materiál, jiný framing, jiný cíl) — uveď ji v karel_text.`
      : "";

    const userPrompt = `${playbookBlock}
${researchBlock}
${historyBlock}

${stateBlock}

═══ POSLEDNÍCH 30 TURNŮ ═══
${turnsText}

═══ DIREKTIVA PRO TENTO TURN (závazné) ═══
${phaseDirective}

═══ TRIGGER ═══
${trigger}

Vrať reakci přes tool emit_followup. karel_text musí být přímo použitelný (terapeutka ho čte v inline chatu).`;

    // ─── TEST-ONLY: force AI fallback paths (service-role only) ───
    if (forceAiEmpty || forceAiInvalid) {
      const fakeBody = forceAiEmpty ? "" : "{not valid json";
      const parsedFake = safeParseJsonString<any>(fakeBody);
      // parsedFake.ok will be false; mirror the real fallback branch
      console.warn("[block-followup] TEST-FORCE AI fallback:", parsedFake.reason);
      return new Response(JSON.stringify({
        karel_text: buildEmptyAiFallback(effectiveBlock, therapistName),
        phase: state.phase,
        state_patch: { phase: state.phase, preserve_current_block: true },
        done: false,
        missing_artifacts: [],
        fallback: true,
        fallback_reason: `ai_response_${parsedFake.ok ? "unknown" : parsedFake.reason}`,
        test_forced: forceAiEmpty ? "AI_EMPTY_RESPONSE" : "AI_INVALID_JSON",
        authority: { source: "server_state_machine", reason: authorityReason, block_index: authoritativeIndex, is_final: effectiveBlock.isFinal },
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "emit_followup" } },
        temperature: 0.4,
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[block-followup] AI error", aiRes.status, t);
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Lovable AI kredit vyčerpán." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Other AI errors → fallback (HTTP 200) to keep UI alive
      return new Response(JSON.stringify({
        karel_text: buildEmptyAiFallback(effectiveBlock, therapistName),
        phase: state.phase,
        state_patch: { phase: state.phase },
        done: false,
        missing_artifacts: [],
        fallback: true,
        fallback_reason: `ai_gateway_${aiRes.status}`,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── ROBUST AI RESPONSE PARSING (SEV-1 fix 2026-04-30) ───
    // Read response as text first; if empty/invalid, return 200 fallback
    // instead of throwing (which would 500 and trigger a UI error overlay).
    const aiBodyText = await aiRes.text();
    const parsedBody = safeParseJsonString<any>(aiBodyText);
    if (!parsedBody.ok) {
      console.warn("[block-followup] AI returned unparseable body:", parsedBody.reason, parsedBody.raw);
      return new Response(JSON.stringify({
        karel_text: buildEmptyAiFallback(effectiveBlock, therapistName),
        phase: state.phase,
        state_patch: { phase: state.phase },
        done: false,
        missing_artifacts: [],
        fallback: true,
        fallback_reason: `ai_response_${parsedBody.reason}`,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const aiData = parsedBody.value;
    const toolCall = aiData?.choices?.[0]?.message?.tool_calls?.[0];
    const argsStr = toolCall?.function?.arguments;
    const argsParse = safeParseJsonString<any>(argsStr);
    const parsed: any = argsParse.ok ? argsParse.value : {};

    let karelText = String(parsed?.karel_text ?? "").trim();
    if (!karelText) {
      karelText = buildEmptyAiFallback(effectiveBlock, therapistName);
    }

    // ─── OUTPUT VALIDATION: block off-plan activity in FINAL block ───
    const validation = validateAiOutputForBlock(karelText, effectiveBlock, therapistName);
    let validationFallbackUsed = false;
    if (!validation.ok && validation.safeFallback) {
      console.warn("[block-followup] AI output violated final-block guard:", validation.violations);
      karelText = validation.safeFallback;
      validationFallbackUsed = true;
    }

    const phaseNext: PlaybookPhase = (["setup", "running", "trauma_pause", "closure", "done"] as PlaybookPhase[])
      .includes(parsed?.phase_next) ? parsed.phase_next : (effectiveBlock.isFinal ? "closure" : state.phase);

    const advanceStep = !!parsed?.advance_step && phaseNext === "running" && !validationFallbackUsed;
    const newStepIndex = advanceStep ? state.step_index + 1 : state.step_index;

    const out: any = {
      karel_text: karelText,
      phase: phaseNext,
      state_patch: {
        method_id: state.method_id,
        phase: phaseNext,
        step_index: newStepIndex,
        planned_steps: state.planned_steps,
        trauma_flag: state.trauma_flag,
        red_flags_seen: state.red_flags_seen,
      },
      done: !!parsed?.done && !validationFallbackUsed,
      missing_artifacts: Array.isArray(parsed?.missing_artifacts)
        ? parsed.missing_artifacts.filter((x: string) => ["image", "audio"].includes(x))
        : [],
      suggested_close_message:
        typeof parsed?.suggested_close_message === "string" && parsed.suggested_close_message.trim()
          ? String(parsed.suggested_close_message).trim()
          : undefined,
      red_flags_seen: state.red_flags_seen,
      authority: {
        source: "server_state_machine",
        reason: authorityReason,
        block_index: authoritativeIndex,
        is_final: effectiveBlock.isFinal,
        violations: validation.violations,
        validation_fallback_used: validationFallbackUsed,
      },
    };

    // 6) Po uzavření bodu (done=true) zaloguj historii (fire-and-forget v rámci requestu)
    if (out.done && state.method_id) {
      await logMethodHistory({
        partName,
        method_key: state.method_id,
        variant_used: research?.method_label ?? undefined,
        session_id: typeof body?.session_id === "string" ? body.session_id : undefined,
        responses_count: state.responses.length,
        trauma_flag: state.trauma_flag,
        red_flags: state.red_flags_seen,
        step_total: state.planned_steps.length,
      });
    }

    return new Response(JSON.stringify(out), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[block-followup] fatal:", e);
    // ─── FATAL → HTTP 200 fallback (SEV-1 fix 2026-04-30) ───
    // Returning 500 caused a blank-screen RUNTIME_ERROR overlay in the
    // client. Return 200 with a fallback text so the UI stays usable.
    return new Response(JSON.stringify({
      karel_text: "AI teď nezvládla odpovědět. Zkus to prosím za chvíli znovu, nebo pokračuj podle plánu.",
      phase: "running",
      state_patch: {},
      done: false,
      missing_artifacts: [],
      fallback: true,
      fallback_reason: "fatal_exception",
      error_detail: String(e?.message ?? e).slice(0, 200),
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
