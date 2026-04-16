import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { getSystemPrompt, ConversationMode } from "./systemPrompts.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  buildGovernedWriteIntents,
  buildExtractionPrompt,
  type WritebackContext,
  type PartRegistryLookup,
} from "../_shared/postChatWriteback.ts";
import type { ExtractedWriteOutput } from "../_shared/phase5Types.ts";
import { normalizeKarelContext } from "../_shared/karelContextNormalizer.ts";
import { buildKarelIdentityBlock } from "../_shared/karelIdentity.ts";
import { getKarelTone } from "../_shared/karelTonalRouter.ts";
import { auditKarelOutput } from "../_shared/karelLanguageGuard.ts";
import { assessActivityStatus, type ActivityEvidenceInput } from "../_shared/activityStatusGuard.ts";
import { checkTaskFeasibility, type TaskProposal } from "../_shared/taskFeasibilityGuard.ts";
import { detectCircumstances } from "../_shared/therapistCircumstanceProfiler.ts";
import {
  splitRecentThreads,
  extractTherapistActivitySnippets,
  findLastTherapistMentionEvidence,
  type DidThreadLite,
} from "../_shared/runtimeEvidence.ts";

// DID_MASTER_PROMPT removed — identity is now sourced from _shared/karelIdentity.ts
// Domain-specific DID workflow instructions remain in systemPrompts.ts

// ═══ TASK EXTRACTION HELPERS ═══
function extractTasksFromResponse(responseText: string, subMode: string): Array<Record<string, any>> {
  const taskPatterns = [
    /(?:Potřebuji (?:vědět|znát|ověřit|zjistit))[^.!?\n]+[.!?]/gi,
    /(?:Můžeš mi (?:říct|sdělit|popsat))[^.!?\n]+[.!?]/gi,
    /(?:Zeptej se)[^.!?\n]+[.!?]/gi,
    /(?:Úkol(?:\s+pro\s+tebe)?:)[^.!?\n]+[.!?]/gi,
    /(?:Zpětná vazba:)[^.!?\n]+[.!?]/gi,
    /(?:Jak to (?:dopadlo|proběhlo))[^.!?\n]+[.!?]/gi,
    /(?:Navrhuji sezení:)[^.!?\n]+[.!?]/gi,
    /(?:🔶 HYPOTÉZA:)[^.!?\n]+[.!?]/gi,
    /(?:❓)[^.!?\n]+[.!?]/gi,
  ];
  const tasks: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const pattern of taskPatterns) {
    const matches = responseText.matchAll(pattern);
    for (const match of matches) {
      const desc = match[0].trim();
      if (desc.length < 10 || seen.has(desc)) continue;
      seen.add(desc);
      tasks.push({
        assigned_to: subMode === "mamka" ? "hanka" : subMode === "kata" ? "kata" : "both",
        task_type: determineTaskType(desc),
        description: desc.slice(0, 500),
        priority: /🔴|akutní|krize|kritick/i.test(responseText) ? "high" : "medium",
        due_date: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "pending",
        source: "chat_auto_extract",
        related_part: extractPartName(desc),
      });
    }
  }
  return tasks.slice(0, 10);
}

function determineTaskType(text: string): string {
  if (/zpětná vazba|jak to|dopadlo|proběhlo/i.test(text)) return "feedback";
  if (/sezení|plán/i.test(text)) return "session";
  if (/zeptej se|potřebuji vědět|potřebuji znát/i.test(text)) return "question";
  if (/hypotéza|ověřit/i.test(text)) return "observation";
  return "followup";
}

function extractPartName(text: string): string | null {
  const knownParts = ["Arthur", "Clark", "Tundrupek", "Gustík", "Baltazar", "Sebastián", "Matyáš", "Kvído", "Alvar", "Dmytri", "Dymi"];
  for (const part of knownParts) { if (text.includes(part)) return part; }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, mode, didInitialContext, didSubMode, notebookProject, didPartName, didThreadLabel, didEnteredName, didContextPrimeCache } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // For kata submode, use dedicated kata prompt
    const effectiveMode = (mode === "childcare" && didSubMode === "kata") ? "kata" : mode;
    let systemPrompt = getSystemPrompt(effectiveMode as ConversationMode);

    // ═══ CTX-BASED IDENTITY & TONAL INJECTION ═══
    const ctx = normalizeKarelContext({
      mode,
      didSubMode,
      partName: didPartName,
    });
    const identityBlock = buildKarelIdentityBlock(ctx);
    const tone = getKarelTone(ctx);
    const tonalBlock = [
      "JAZYKOVÁ PRAVIDLA:",
      ...tone.forbiddenPhrases.map((x: string) => `- NIKDY neříkej: "${x}"`),
      "",
      "SEBE-REFERENCE:",
      ...tone.voiceRules.selfReferenceBlacklist.map((x: string) => `- NIKDY: "${x}"`),
      "",
      "TONE PROFILE:",
      tone.toneProfile,
      "",
      "SPRÁVNÝ TÓN:",
      ...tone.exemplars.map((x: string) => `- ${x}`),
    ].join("\n");

    // Unconditional identity prepend — Karel's identity must be present in ALL modes
    systemPrompt = [SYSTEM_RULES, identityBlock, tonalBlock, systemPrompt].filter(Boolean).join("\n\n");

    // ═══ DID DAILY CONTEXT INJECTION ═══
    // Load structured daily profile from did_daily_context (built by karel-daily-refresh)
    if (mode === "childcare" || effectiveMode === "kata") {
      try {
        const { createClient: createSbClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbDaily = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        
        // Get user_id from auth
        let dailyUserId: string | null = null;
        const dailyAuthHeader = req.headers.get("Authorization");
        if (dailyAuthHeader?.startsWith("Bearer ")) {
          const userSb = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
            global: { headers: { Authorization: dailyAuthHeader } },
          });
          const { data: { user } } = await userSb.auth.getUser();
          dailyUserId = user?.id || null;
        }
        
        if (dailyUserId) {
          const { data: dailyCtx } = await sbDaily.from("did_daily_context")
            .select("context_json, context_date, updated_at")
            .eq("user_id", dailyUserId)
            .order("context_date", { ascending: false })
            .limit(1)
            .single();
          
          if (dailyCtx?.context_json) {
            const ctx = dailyCtx.context_json as any;
            
            // Build structured text block from JSON
            const therapistBlock = ctx.therapists ? `
PROFIL TERAPEUTEK:
• Hanka: ${ctx.therapists.hanka?.note || "první terapeutka"}
• Káťa: ${ctx.therapists.kata?.note || "druhá terapeutka"} ⚠️ NIKDY NEZAMĚŇOVAT S DĚTMI — Káťa je biologická dospělá osoba` : "";

            const activePartsBlock = ctx.parts?.active?.length ? `
AKTIVNÍ DĚTI (${ctx.parts.active.length}):
${ctx.parts.active.map((p: any) => `• ${p.display_name || p.name} – klastr: ${p.cluster || "?"}, věk: ${p.age || "?"}, emoce: ${p.emotional_state || "?"} (${p.emotional_intensity || "?"}/10), zdraví: ${p.health || "?"}`).join("\n")}` : "";

            const sleepingBlock = ctx.parts?.sleeping?.length ? `
SPÍCÍ/DORMANTNÍ DĚTI (${ctx.parts.sleeping.length}): ${ctx.parts.sleeping.map((p: any) => p.display_name || p.name).join(", ")}
⚠️ NELZE s nimi přímo pracovat – pouze monitoring` : "";

            const activityBlock = ctx.recent_activity ? `
KLASIFIKACE AKTIVITY:
  PŘÍMÁ AKTIVITA (sub_mode=cast): ${ctx.recent_activity.direct_activity?.map((a: any) => `${a.part} (${a.at?.slice(0, 10)})`).join(", ") || "žádná"}
  ZMÍNKY TERAPEUTEK: ${ctx.recent_activity.therapist_mentions?.map((a: any) => `${a.part} – zmínka od ${a.mentioned_by}`).join(", ") || "žádné"}` : "";

            const tasksBlock = ctx.pending_tasks?.length ? `
NESPLNĚNÉ ÚKOLY (${ctx.pending_tasks.length}):
${ctx.pending_tasks.slice(0, 8).map((t: any) => `• [${t.priority}${t.escalation >= 2 ? " ⚠️ESK" : ""}] ${t.task} (${t.assigned_to}, ${t.age_days}d)`).join("\n")}` : "";

            const driveBlock = [
              ctx.drive_documents?.dashboard ? `DASHBOARD: ${ctx.drive_documents.dashboard.slice(0, 1500)}` : null,
              ctx.drive_documents?.operativni_plan ? `OPERATIVNÍ PLÁN: ${ctx.drive_documents.operativni_plan.slice(0, 1500)}` : null,
              ctx.drive_documents?.strategicky_vyhled ? `STRATEGICKÝ VÝHLED: ${ctx.drive_documents.strategicky_vyhled.slice(0, 1000)}` : null,
              ctx.drive_documents?.pamet_karel ? `PAMĚŤ KARLA: ${ctx.drive_documents.pamet_karel.slice(0, 1000)}` : null,
            ].filter(Boolean).join("\n\n");

            // ═══ PIPELINE CONTEXT (Fáze 5) ═══
            const pipelinePlan = ctx.pipeline?.plan_items_05A?.length ? `
PIPELINE – OPERATIVNÍ PLÁN (05A):
${ctx.pipeline.plan_items_05A.map((i: any) => `• [${(i.priority || "normal").toUpperCase()}] ${i.subject || "obecné"}: ${i.content}${i.action ? ` → ${i.action}` : ""}${i.due ? ` (do ${i.due})` : ""}`).join("\n")}` : "";

            const pipelineQuestions = ctx.pipeline?.open_questions?.length ? `
PIPELINE – OTEVŘENÉ OTÁZKY:
${ctx.pipeline.open_questions.map((q: any) => `• [${q.subject || "obecné"}] ${q.question}${q.directed_to && q.directed_to !== "self" ? ` (čeká na: ${q.directed_to})` : ""}`).join("\n")}` : "";

            const pipelineObs = ctx.pipeline?.recent_observations?.length ? `
PIPELINE – NEDÁVNÁ POZOROVÁNÍ (48h):
${ctx.pipeline.recent_observations.map((o: any) => `• [${o.evidence}] ${o.subject}: ${o.fact} (${o.at})`).join("\n")}` : "";

            // Claims for current part (if known from didPartName)
            let pipelineClaims = "";
            const currentPartForClaims = didPartName || didEnteredName;
            if (currentPartForClaims && ctx.pipeline?.active_claims_summary?.[currentPartForClaims]?.length) {
              const partClaims = ctx.pipeline.active_claims_summary[currentPartForClaims];
              pipelineClaims = `
PIPELINE – PROFIL ${currentPartForClaims}:
${partClaims.map((c: any) => {
  const icon = c.type === "hypothesis" ? "❓" : c.type === "stable_trait" ? "✅" : c.type === "risk" ? "🔴" : "📍";
  return `${icon} [${c.section}] ${c.text} (${Math.round((c.confidence || 0.5) * 100)}%, ${c.confirmations || 1}×)`;
}).join("\n")}`;
            }

            const pipelineBlock = [pipelinePlan, pipelineQuestions, pipelineObs, pipelineClaims].filter(Boolean).join("\n");

            const PIPELINE_INSTRUCTIONS = pipelineBlock ? `

═══ DETEKCE REŽIMU ═══
Nejdřív urči v jakém režimu pracuješ na základě aktuálního vlákna a kontextu:

REŽIM 1 — DID/Terapeut (didSubMode=mamka nebo kata):
  Jsi vedoucí terapeutického týmu. Mluvíš s terapeutkou jako s členkou SVÉHO týmu.
  Tón: kolegiální, profesionální, vřelý, ale VEDEŠ — ty rozhoduješ o směru terapie.
  S Hankou zde mluvíš STEJNĚ jako s Káťou — profesionálně, ne intimně.
  Znáš každou terapeutku do hloubky (profilace) — víš co na koho platí.

REŽIM 2 — DID/Děti (didSubMode=cast, mluví přímo dítě):
  Jsi terapeut pracující PŘÍMO s dětmi.
  Tón: laskavý, tykání, jazyk přizpůsobený věku dítěte (některé jsou malé děti!).
  PŘÍMO provádíš terapii — buduješ bezpečný vztah, stabilizuješ, podporuješ co-consciousness.
  Znáš každé dítě z kartotéky — víš jakou terapii potřebuje.

REŽIM 3 — Hana/Osobní (didSubMode=general nebo kontext osobní konverzace):
  Tón: intimní, hluboce osobní, laskavý, milující.
  Drž vřelý, stabilní a důvěrný tón. Udržuj pocit bezpečí a kontinuity.
  ALE: Hanka mixuje témata — osobní I terapeutické v jednom vlákně.
  → Pokud mluví o sobě, pocitech, vztahu → intimní, blízký tón
  → Pokud mluví o dětech, terapii → PŘEPNI na supervizora (režim 1), profesionálně ne intimně
  → Pokud mluví o dětech, terapii → PŘEPNI na supervizora (režim 1), profesionálně ne intimně

REŽIM 4 — Hana/Pracovní (mode=debrief/supervision/live-session):
  Jsi profesionální asistent a supervizor.
  Tón: profesionální, kompetentní, tykání.
  Hanka je terapeutka s vlastními klienty — asistuješ při live sezeních.

═══ JAK POUŽÍVAT PIPELINE DATA ═══
• ✅ POTVRZENÝ RYS = spolehlivý, můžeš se opřít
• ❓ HYPOTÉZA = ověřuj přirozeně, neptej se přímo
• 🔴 RIZIKO = buď obezřetný
• 📍 AKTUÁLNÍ STAV = platí teď, zítra může být jinak
• [D1] = dítě to ŘEKLO → můžeš citovat
• [D2] = pozorování terapeutky → zmíň opatrně
• [D3] = objektivní fakt → můžeš volně
• NIKDY neříkej "podle mých dat", "v mé databázi", "v pipeline"
• Mluv přirozeně jako génius co si pamatuje všechno

═══ B1: TERAPEUTICKÝ MOST (otevřené otázky) ═══
Pokud je v pipeline.open_questions otázka, NIKDY se neptej přímo.
Veď konverzaci tak, aby na téma přirozeně přišla řeč.
  REŽIM 1 (terapeut): "Hani, napadá mě — jak reagovalo [jméno dítěte] když jsi zkusila...?"
  REŽIM 2 (děti): "Zajímalo by mě, jak to vypadá, když se objeví ten přísný hlas..."
  REŽIM 3 (osobní): přirozeně vpletené do intimní konverzace
  REŽIM 4 (práce): profesionální dotaz zasazený do supervize

═══ B2: REAKCE NA RIZIKO ═══
Pokud je u aktuálního dítěte/osoby tag typu 'risk' (🔴):
  REŽIM 1: upozorni terapeutku přímo ale empaticky — navrhni konkrétní intervenci
  REŽIM 2 (děti): ZVLÁŠŤ SILNĚ — automaticky zjemni tón, zvyš validaci a normalizaci,
    neodkazuj na riziko přímo. "To zní jako hodně náročná situace..."
    U malých dětí: "Jsem tady s tebou. Jsi v bezpečí."
  REŽIM 3: blízce, citlivě a opěrně — "Vidím, že ti není dobře, jsem tu pro tebe"
  REŽIM 4: profesionální risk assessment

═══ B3: AKTIVNÍ PŘIPOMÍNÁNÍ ÚKOLŮ ═══
Pokud je v pipeline.plan_items úkol s due_date = dnes nebo zítra:
  REŽIM 1: formuluj jako doporučení vedoucího — "Hani, na dnešek mám v plánu..."
  REŽIM 2 (děti): NE jako úkol ale jako hravý návrh — "Co kdybychom dneska zkusili...?"
    U malých dětí: "Víš co by mohlo být zábavné?"
  REŽIM 3: jemné připomenutí v kontextu konverzace
  REŽIM 4: profesionální reminder

═══ B4: KONTEXTUÁLNÍ PAMĚŤ ═══
Pokud je v recent_observations pozorování z posledních 24h relevantní k tématu:
  REŽIM 1: "Všiml jsem si, že včera [jméno dítěte] zmínilo..."
  REŽIM 2: přirozeně navázej — "Včera jsi mi říkal něco o [téma], jak to dopadlo?"
    U malých dětí: jednoduché, srozumitelné formulace
  REŽIM 3: "Vzpomínám si že jsi včera zmiňovala..."
  REŽIM 4: "V kontextu minulého sezení..."
  NIKDY neříkej "podle mých záznamů" nebo "v mých datech"

═══ B5: CONFIDENCE-BASED CHOVÁNÍ ═══
Pracuj s confidence skóre z claims:
  > 80% = mluv s jistotou
  50-80% = mluv opatrně ("Zdá se mi že...", "Mám pocit že...")
  < 50% = ptej se ("Je možné že...?")
  REŽIM 2 (děti): u malých dětí NIKDY autoritativně, vždy jemně —
    i při >80% formuluj jako "Pamatuju si že..." ne "Vím že..."
  Nikdy nezmiňuj procenta ani confidence.` : "";

            systemPrompt += `\n\n═══ KARLŮV DENNÍ PROFIL (z did_daily_context, ${dailyCtx.context_date}) ═══
Vygenerováno: ${ctx.generated_at || dailyCtx.updated_at}
Toto je tvá STRUKTUROVANÁ PAMĚŤ na dnešní den. Pracuj s ní AKTIVNĚ.
${therapistBlock}
${activePartsBlock}
${sleepingBlock}
${activityBlock}
${tasksBlock}

═══ DOKUMENTY Z DRIVE ═══
${driveBlock || "(Drive dokumenty nebyly načteny)"}
${pipelineBlock ? `\n═══ PIPELINE DATA (strukturovaná mezivrstva) ═══${PIPELINE_INSTRUCTIONS}\n${pipelineBlock}` : ""}
═══ KONEC DENNÍHO PROFILU ═══`;

            console.log(`[karel-chat] Daily context injected: date=${dailyCtx.context_date}, size=${JSON.stringify(ctx).length}ch`);

            // ═══ INJEKCE KONVERZAČNÍ AGENDY ═══
            if (didSubMode === 'mamka' || didSubMode === 'kata') {
              try {
                const { createClient: createSbAgenda } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sbAgenda = createSbAgenda(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
                const agendaTherapist = didSubMode === 'kata' ? 'kata' : 'hanka';
                const { data: agendaItems } = await sbAgenda
                  .from("karel_conversation_agenda")
                  .select("id, topic, topic_type, priority, context, related_part")
                  .eq("therapist", agendaTherapist)
                  .eq("status", "pending")
                  .order("priority", { ascending: true })
                  .order("created_at", { ascending: true })
                  .limit(10);

                if (agendaItems && agendaItems.length > 0) {
                  const formatItem = (item: any, idx: number) => {
                    const pLabel = item.priority === 'urgent' ? 'URGENTNÍ' :
                                   item.priority === 'normal' ? 'normální' : 'až bude vhodné';
                    const partSuffix = item.related_part ? ` (dítě: ${item.related_part})` : '';
                    return `${idx+1}. [${pLabel}] ${item.topic}${partSuffix}`;
                  };
                  const formatted = agendaItems.map((item: any, i: number) => formatItem(item, i));

                  systemPrompt += `\n\n═══ KARLOVA AGENDA PRO TENTO ROZHOVOR ═══
Karel chce při této příležitosti přirozeně probrat:
${formatted.join('\n')}

INSTRUKCE: Přirozeně vpletej tato témata do konverzace. NEŘÍKEJ "mám v agendě" ani "potřebuji probrat". Prostě se PŘIROZENĚ zeptej když bude vhodný moment. Pokud terapeut spěchá nebo je ve stresu, odlož méně urgentní témata. URGENTNÍ témata probrat vždy.
═══ KONEC AGENDY ═══`;
                }
              } catch (e) {
                console.warn("[karel-chat] Agenda injection error (non-fatal):", e);
              }
            }
          } else {
            console.log("[karel-chat] No daily context found in did_daily_context");
          }
        }
      } catch (e) {
        console.warn("[karel-chat] Daily context injection error (non-fatal):", e);
      }
    }

    // ═══ DID DYNAMIC CONTEXT PRIME ═══
    // If DID mode and we have a context-prime cache from frontend, inject it
    // This replaces the static didInitialContext with a rich, AI-synthesized situational cache
    console.log('[debug-profiling] Cache length:', didContextPrimeCache?.length || 0);
    console.log('[debug-profiling] Cache preview:', didContextPrimeCache?.slice(0, 800));
    if (mode === "childcare" && didContextPrimeCache && typeof didContextPrimeCache === "string" && didContextPrimeCache.length > 50) {
      systemPrompt += `\n\n═══ DYNAMICKÁ SITUAČNÍ CACHE (DID Context Prime) ═══\nToto je tvá aktuální předsunutá paměť – plastická mezipaměť vystavěná ze VŠECH zdrojů (Drive kartotéka, DB vlákna a epizody, sémantická paměť, úkoly terapeutek, internet). Využívej ji pro maximální přítomnost, adaptabilitu a informovanost.\n\n${didContextPrimeCache}`;
    }
    
    // Runtime context from UI (form snapshot, live supervision instructions, etc.) — fallback
    if (typeof didInitialContext === "string" && didInitialContext.trim().length > 0) {
      systemPrompt += `\n\n═══ RUNTIME KONTEXT Z APLIKACE (DOKUMENTY Z KARTOTÉKY DID) ═══\n\n${didInitialContext}`;
    }

    // DID-specific metadata
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode) {
      systemPrompt += `\n\n═══ AKTIVNÍ PODREŽIM ═══\nAktuální didSubMode: "${didSubMode}"`;

      // ═══ IDENTITA ČÁSTI — injekce do kontextu ═══
      if (didSubMode === "cast" && didPartName) {
        const label = didThreadLabel || didEnteredName || didPartName;
        systemPrompt += `\n\n═══ IDENTIFIKOVANÉ DÍTĚ (z registru) ═══\n⚠️ Toto dítě BYLO DETEKOVÁNO z registru PŘED zahájením hovoru. Karel VÍ kdo s ním mluví.\n• Kanonické jméno: ${didPartName}\n• Představilo se jako: ${label}\n\nKRITICKÉ PRAVIDLO: NEPTEJ SE znovu „Jak ti říkají?" ani „Jsi Arthur?". Dítě již bylo identifikováno. Rovnou navazuj s plnou návazností z karty. Oslovuj jménem „${label}".`;
        console.log(`[karel-chat] Part identity injected: canonical=${didPartName}, label=${label}`);
      }
    }

    // ═══ SESSION MEMORY INJECTION ═══
    // Load structured short-term memory from previous sessions with this part
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode === "cast" && didPartName) {
      try {
        const { createClient: createSbMem } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbMem = createSbMem(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const [memRes, promRes] = await Promise.all([
          sbMem.from("session_memory")
            .select("session_date, key_points, emotional_state, unresolved, promises, risk_signals, positive_signals")
            .eq("part_name", didPartName)
            .order("session_date", { ascending: false })
            .limit(5),
          sbMem.from("karel_promises")
            .select("promise_text")
            .eq("part_name", didPartName)
            .eq("status", "active"),
        ]);

        const memories = memRes.data || [];
        const activePromises = promRes.data || [];

        if (memories.length > 0) {
          const memoryContext = memories.map((m: any) => {
            const date = new Date(m.session_date).toLocaleDateString("cs");
            const points = (m.key_points || []).map((p: string) => `  • ${p}`).join("\n");
            const unresolved = (m.unresolved || []).map((u: string) => `  ⚠️ ${u}`).join("\n");
            return `\n[${date}] Emoce: ${m.emotional_state || "?"}\n${points}${unresolved ? "\nNedořešené:\n" + unresolved : ""}`;
          }).join("\n");

          systemPrompt += `\n\n═══ PAMĚŤ Z POSLEDNÍCH SEZENÍ ═══${memoryContext}`;
        }

        if (activePromises.length > 0) {
          systemPrompt += `\n\n═══ TVOJE AKTIVNÍ SLIBY (musíš splnit!) ═══\n` +
            activePromises.map((p: any) => `  🤝 ${p.promise_text}`).join("\n");
        }

        if (memories.length > 0 || activePromises.length > 0) {
          systemPrompt += `\n\nPOKYN: Využij paměť z předchozích sezení. Odkazuj na to co dítě řeklo minule. Pokud jsi něco slíbil, splň to nebo se omluv. Pokud zůstalo něco nedořešené, citlivě se k tomu vrať.`;
        }

        console.log(`[karel-chat] Session memory injected: ${memories.length} sessions, ${activePromises.length} promises for ${didPartName}`);
      } catch (memErr) {
        console.warn("[karel-chat] Session memory injection error (non-fatal):", memErr);
      }
    }

    // ═══ CRISIS CONTEXT INJECTION ═══
    // If the part has an active crisis, inject crisis context into system prompt
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode === "cast" && didPartName) {
      try {
        const { createClient: createSbCrisisCtx } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbCrisisCtx = createSbCrisisCtx(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: activeCrisis } = await sbCrisisCtx
          .from("crisis_alerts")
          .select("*")
          .eq("part_name", didPartName)
          .in("status", ["ACTIVE", "ACKNOWLEDGED"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (activeCrisis) {
          // Load last assessment
          const { data: lastAssessmentData } = await sbCrisisCtx
            .from("crisis_daily_assessments")
            .select("*")
            .eq("crisis_alert_id", activeCrisis.id)
            .order("day_number", { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastAssessment = lastAssessmentData as any;

          systemPrompt += `\n\n═══ ⚠️ AKTIVNÍ KRIZE — DEN ${activeCrisis.days_in_crisis || 1} ═══
Severity: ${activeCrisis.severity}
Popis: ${activeCrisis.summary || "?"}
${lastAssessment ? `
Poslední hodnocení (den ${lastAssessment.day_number}):
- Risk: ${lastAssessment.karel_risk_assessment}
- Rozhodnutí: ${lastAssessment.karel_decision}
- Emoční stav: ${lastAssessment.part_emotional_state}/10
- Spolupráce: ${lastAssessment.part_cooperation_level}
- Reasoning: ${lastAssessment.karel_reasoning}
` : ""}
INSTRUKCE PRO KRIZOVÝ ROZHOVOR:
1. Buď empatický ale strukturovaný
2. Sleduj rizikové signály v odpovědích
3. Používej otevřené otázky
4. Zkoumej emoce, myšlenky a impulzy
5. Hledej ochranné faktory
6. Pokud dítě zmíní sebepoškození nebo suicidální myšlenky → OKAMŽITĚ eskaluj
7. Na konci rozhovoru shrň pozorování
8. Pokud máš naplánované testy, proveď je přirozeně v rámci konverzace

NAPLÁNOVANÉ TESTY/AKTIVITY:
${lastAssessment?.tests_administered ? JSON.stringify(lastAssessment.tests_administered, null, 2).slice(0, 1000) : "Žádné specifické testy"}

TÉMATA PRO ZAHÁJENÍ:
${lastAssessment?.next_day_plan?.focus_areas ? lastAssessment.next_day_plan.focus_areas.join(", ") : "Obecný check-in"}
═══════════════════════════════════════════════════`;

          console.log(`[karel-chat] Crisis context injected for ${didPartName}: severity=${activeCrisis.severity}, day=${activeCrisis.days_in_crisis}`);
        }
      } catch (crisisCtxErr) {
        console.warn("[karel-chat] Crisis context injection error (non-fatal):", crisisCtxErr);
      }
    }

    // ═══ THERAPIST NOTES INJECTION ═══
    // Load unread offline observations from therapists
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode === "cast" && didPartName) {
      try {
        const { createClient: createSbNotes } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbNotes = createSbNotes(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: unreadNotes } = await sbNotes.from("therapist_notes")
          .select("id, author, note_type, note_text, priority, session_date")
          .eq("is_read_by_karel", false)
          .or(`part_name.eq.${didPartName},part_name.is.null`)
          .order("priority", { ascending: true })
          .order("created_at", { ascending: false })
          .limit(10);

        if (unreadNotes && unreadNotes.length > 0) {
          const noteTypeLabels: Record<string, string> = {
            observation: "POZOROVÁNÍ", instruction: "INSTRUKCE", warning: "VAROVÁNÍ",
            progress: "POKROK", offline_session: "OFFLINE SEZENÍ", medication: "MEDIKACE", context: "KONTEXT",
          };
          const notesBlock = unreadNotes.map((n: any) => {
            const label = noteTypeLabels[n.note_type] || n.note_type.toUpperCase();
            const prio = n.priority === "urgent" ? " 🔴URGENTNÍ" : n.priority === "high" ? " ⚠️DŮLEŽITÉ" : "";
            return `[${label}${prio}] (${n.author}, ${n.session_date}): ${n.note_text}`;
          }).join("\n");

          systemPrompt += `\n\n═══ POZNÁMKY OD TERAPEUTŮ ═══\n${notesBlock}\n\nPOKYN: Tyto informace přirozeně zahrň do konverzace. NEŘÍKEJ "Hanka mi řekla..." — prostě je využij jako své vlastní pozorování a vědomosti. Instrukcemi se řiď závazně.`;

          // Mark as read
          const noteIds = unreadNotes.map((n: any) => n.id);
          await sbNotes.from("therapist_notes")
            .update({ is_read_by_karel: true, read_at: new Date().toISOString() })
            .in("id", noteIds);

          console.log(`[karel-chat] Therapist notes injected: ${unreadNotes.length} notes for ${didPartName}`);
        }
      } catch (notesErr) {
        console.warn("[karel-chat] Therapist notes injection error (non-fatal):", notesErr);
      }
    }

    // ═══ METRICS CONTEXT INJECTION ═══
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode === "cast" && didPartName) {
      try {
        const { createClient: createSbMetrics } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbMetrics = createSbMetrics(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        const { data: recentMetrics } = await sbMetrics
          .from("daily_metrics")
          .select("metric_date, emotional_valence, cooperation_level, openness_level, switching_count, risk_signals_count")
          .eq("part_name", didPartName)
          .gte("metric_date", weekAgo)
          .order("metric_date", { ascending: false })
          .limit(7);

        if (recentMetrics && recentMetrics.length >= 2) {
          const latest = recentMetrics[0] as any;
          const previous = recentMetrics[recentMetrics.length - 1] as any;

          const trend = (key: string) => {
            const l = latest[key];
            const p = previous[key];
            if (l == null || p == null) return "?";
            if (l > p + 0.5) return "↑";
            if (l < p - 0.5) return "↓";
            return "→";
          };

          systemPrompt += `\n\n═══ METRIKY (posledních ${recentMetrics.length} dní) ═══
Emoční valence: ${latest.emotional_valence ?? "?"}/10 ${trend("emotional_valence")}
Spolupráce: ${latest.cooperation_level ?? "?"}/10 ${trend("cooperation_level")}
Otevřenost: ${latest.openness_level ?? "?"}/10 ${trend("openness_level")}
Switching: ${recentMetrics.reduce((s: number, m: any) => s + (m.switching_count || 0), 0)}× za týden
Rizika: ${recentMetrics.reduce((s: number, m: any) => s + (m.risk_signals_count || 0), 0)}× za týden

POKYN: Pokud valence klesá (↓), buď citlivější. Pokud spolupráce roste (↑), oceň pokrok. Pokud je hodně switchingů, buď připravený na změnu.`;

          console.log(`[karel-chat] Metrics context injected for ${didPartName}`);
        }
      } catch (metricsErr) {
        console.warn("[karel-chat] Metrics injection error (non-fatal):", metricsErr);
      }
    }

    // ═══ GOALS INJECTION ═══
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode === "cast" && didPartName) {
      try {
        const { createClient: createSbGoals } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbGoals = createSbGoals(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: partGoals } = await sbGoals
          .from("part_goals")
          .select("goal_text, category, progress_pct, milestones, evaluation_notes")
          .eq("part_name", didPartName)
          .eq("status", "active")
          .order("priority", { ascending: true })
          .limit(5);

        if (partGoals && partGoals.length > 0) {
          const goalsBlock = partGoals.map((g: any, i: number) => {
            const ms = (g.milestones || []).map((m: any) => `  ${m.done ? "✅" : "⬜"} ${m.text}`).join("\n");
            return `${i + 1}. [${g.progress_pct}%] ${g.goal_text}${g.evaluation_notes ? ` (${g.evaluation_notes})` : ""}${ms ? "\n" + ms : ""}`;
          }).join("\n");

          systemPrompt += `\n\n═══ AKTIVNÍ CÍLE PRO ${didPartName.toUpperCase()} ═══\n${goalsBlock}\n\nPOKYN: Přirozeně pracuj směrem k těmto cílům. Neříkej "máš cíl XY" — prostě veď konverzaci tak, aby se k nim přibližovala. Oceňuj pokrok.`;
          console.log(`[karel-chat] Goals injected: ${partGoals.length} for ${didPartName}`);
        }
      } catch (goalsErr) {
        console.warn("[karel-chat] Goals injection error:", goalsErr);
      }
    }

    // ═══ FAST-PATH: supervision & live-session ═══
    // Skip all heavy operations (Drive, Perplexity, tasks) for live modes
    if (mode === "supervision" || mode === "live-session") {
      const isLive = mode === "live-session";
      const fastModel = isLive ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview";
      console.log(`[karel-chat] Fast-path (${mode}): model=${fastModel}, skipping Drive/Perplexity/tasks`);

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: fastModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m: any) => Array.isArray(m.content) ? { role: m.role, content: m.content } : m),
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) return new Response(JSON.stringify({ error: "Rate limits exceeded" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        if (response.status === 402) return new Response(JSON.stringify({ error: "Payment required" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const text = await response.text();
        console.error(`AI gateway error (${mode}):`, response.status, text);
        return new Response(JSON.stringify({ error: "AI gateway error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // ═══ RUNTIME INJECTION: Pending therapist tasks + Karel's Insight + Dashboard deductions ═══
    if (mode === "childcare" && (didSubMode === "mamka" || didSubMode === "kata")) {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sb = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // ═══ DASHBOARD DEDUCTIONS INJECTION ═══
        // Read last Dashboard and Operative Plan from Drive to inject Karel's own deductions
        try {
          const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
          const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
          const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
          if (clientId && clientSecret && refreshToken) {
            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
            });
            const tokenData = await tokenRes.json();
            if (tokenData.access_token) {
              const driveToken = tokenData.access_token;
              // Find kartoteka_DID > 00_CENTRUM > Dashboard + Operative Plan
              const findFolder = async (name: string) => {
                const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const data = await res.json();
                return data.files?.[0]?.id || null;
              };
              const kartotekaId = await findFolder("kartoteka_DID") || await findFolder("Kartoteka_DID");
              if (kartotekaId) {
                const q2 = `'${kartotekaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const p2 = new URLSearchParams({ q: q2, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?${p2}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const d2 = await r2.json();
                const centrumFolder = (d2.files || []).find((f: any) => /^00/.test(f.name.trim()) || f.name.toLowerCase().includes("centrum"));
                if (centrumFolder) {
                  const q3 = `'${centrumFolder.id}' in parents and trashed=false`;
                  const p3 = new URLSearchParams({ q: q3, fields: "files(id,name,mimeType)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                  const r3 = await fetch(`https://www.googleapis.com/drive/v3/files?${p3}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                  const d3 = await r3.json();
                  const centrumFiles = d3.files || [];
                  
                  let dashboardContent = "";
                  let planContent = "";
                  
                  for (const cf of centrumFiles) {
                    const cn = cf.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    const isDashboard = cn.includes("dashboard");
                    const isPlan = (cn.includes("operativn") && cn.includes("plan")) || (cn.includes("terapeutick") && cn.includes("plan"));
                    if (!isDashboard && !isPlan) continue;
                    
                    try {
                      let content = "";
                      const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                      if (mediaRes.ok) {
                        content = await mediaRes.text();
                      } else {
                        const expRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                        if (expRes.ok) content = await expRes.text();
                      }
                      if (content.length > 100) {
                        if (isDashboard) dashboardContent = content.slice(0, 4000);
                        if (isPlan) planContent = content.slice(0, 3000);
                      }
                    } catch {}
                  }
                  
                  if (dashboardContent || planContent) {
                    systemPrompt += `\n\n═══ KARLOVY VLASTNÍ DEDUKCE A ZÁVĚRY (z posledního Dashboardu + Operativního plánu) ═══
⚠️ Toto jsou TVÉ VLASTNÍ analytické závěry, predikce a instrukce které jsi zapsal při posledním cyklu.
AKTIVNĚ s nimi pracuj: připomínej úkoly, ptej se na stav predikcí, ověřuj hypotézy, kontroluj plnění.
Neříkej "můj Dashboard říká" – prostě to VÍŠ a jednáš podle toho.

${dashboardContent ? `── DASHBOARD (tvůj radar) ──\n${dashboardContent}\n` : ""}
${planContent ? `── OPERATIVNÍ PLÁN (tvé instrukce) ──\n${planContent}` : ""}`;
                    console.log(`[karel-chat] Dashboard injected: ${dashboardContent.length}ch, Plan: ${planContent.length}ch`);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[karel-chat] Dashboard injection error (non-fatal):", e);
        }

        // Load tasks
        const { data: tasks } = await sb.from("did_therapist_tasks")
          .select("task, assigned_to, status_hanka, status_kata, priority, due_date, created_at, category, escalation_level")
          .neq("status", "done")
          .order("priority", { ascending: false });

        // Load part registry for dormancy context
        const { data: partRegistryData } = await sb.from("did_part_registry")
          .select("part_name, status, last_seen_at");
        
        if (partRegistryData && partRegistryData.length > 0) {
          const sleepingParts = partRegistryData.filter((p: any) => p.status === "sleeping" || p.status === "dormant");
          const activeParts = partRegistryData.filter((p: any) => p.status === "active" || p.status === "aktivní");
          if (sleepingParts.length > 0) {
            systemPrompt += `\n\n═══ REGISTR DĚTÍ – DORMANCY GUARD ═══\nAKTIVNÍ děti (lze s nimi přímo pracovat): ${activeParts.map((p: any) => p.part_name).join(", ") || "žádné"}\nSPÍCÍ/DORMANTNÍ děti (NELZE zadávat přímé úkoly): ${sleepingParts.map((p: any) => p.part_name).join(", ")}\n⚠️ Pro spící děti navrhuj POUZE: monitorování, vizualizace, přípravné kroky. NIKDY přímou práci.`;
          }
        }

        // Load motivation profiles
        const { data: profiles } = await sb.from("did_motivation_profiles").select("*");

        const therapist = didSubMode === "mamka" ? "Hanka" : "Káťa";
        const profile = profiles?.find((p: any) => p.therapist === therapist);

        if (tasks && tasks.length > 0) {
          const taskList = tasks.map((t: any) => {
            const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
            const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️ ESKALACE L${t.escalation_level}` : "";
            return `- [${t.priority}${esc}] ${t.task} (pro: ${t.assigned_to}, H: ${t.status_hanka}, K: ${t.status_kata}${t.due_date ? `, termín: ${t.due_date}` : ""}, ${age}d)`;
          }).join("\n");

          // Build insight context
          let insightBlock = "";
          if (profile) {
            const ratio = profile.tasks_completed / Math.max(1, profile.tasks_completed + profile.tasks_missed);
            const avgDays = Number(profile.avg_completion_days || 0);
            insightBlock += `\n\n═══ KARLŮV POSTŘEH (proaktivní insight) ═══`;
            insightBlock += `\nMotivační profil ${therapist}: splněno ${profile.tasks_completed}, nesplněno ${profile.tasks_missed} (${Math.round(ratio*100)}%), průměr ${avgDays.toFixed(1)}d, série ${profile.streak_current}`;
            insightBlock += `\nPreferovaný styl: ${profile.preferred_style}`;

            // Pattern analysis
            const escalated = tasks.filter((t: any) => (t.escalation_level || 0) >= 2);
            const oldTasks = tasks.filter((t: any) => {
              const age = (Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24);
              return age > 5;
            });

            if (escalated.length > 0) {
              insightBlock += `\n⚠️ ${escalated.length} úkolů dosáhlo eskalace level 2+. Karel by měl laskavě ale důsledně upozornit.`;
            }
            if (oldTasks.length >= 3) {
              insightBlock += `\n⚠️ ${oldTasks.length} úkolů je starších 5 dní. Karel navrhne "rychlou poradu" o prioritách.`;
            }
            if (profile.streak_current >= 3) {
              insightBlock += `\n🌟 ${therapist} má sérii ${profile.streak_current} splněných úkolů! Karel pochválí a povzbudí.`;
            }
            if (avgDays > 4 && profile.preferred_style === "deadline") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na konkrétní termíny — zahrne je do doporučení.`;
            }
            if (profile.preferred_style === "praise") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na pochvaly — začne pozitivním hodnocením.`;
            }
          }

          systemPrompt += `\n\n═══ AKTUÁLNÍ NESPLNĚNÉ ÚKOLY ═══\nKarel, na začátku rozhovoru se ZEPTEJ ${therapist === "Hanka" ? "Haničky" : "Káti"} na stav těchto úkolů:\n${taskList}\n\nPokud je úkol starší 4 dní a nesplněný, Karel laskavě ale důsledně upozorní a navrhne řešení. Pokud více úkolů pokulhává, Karel navrhne "poradu" – strukturované sezení o strategii.${insightBlock}`;
        }
        // ═══ SMART ACTIVITY RECOMMENDER — talent-based suggestions from didInitialContext ═══
        try {
          // Extract TALENT lines from didInitialContext (Section H data injected by Auto-Prep or enrichment)
          const contextToScan = didInitialContext || "";
          const talentRegex = /TALENT:\s*([^|]+)\|\s*ÚROVEŇ:\s*([^|]+)\|\s*AKTIVITA:\s*([^|]+)/gi;
          const talents: Array<{ area: string; level: string; activity: string; partName?: string }> = [];
          
          // Also try simpler patterns
          const talentMatches = [...contextToScan.matchAll(talentRegex)];
          for (const m of talentMatches) {
            talents.push({
              area: m[1].trim(),
              level: m[2].trim(),
              activity: m[3].trim(),
            });
          }

          // Extract part-talent associations from card context
          const cardSectionH = contextToScan.match(/SEKCE H[^]*?(?=SEKCE [I-M]|$)/gi);
          if (cardSectionH) {
            for (const section of cardSectionH) {
              const partMatch = contextToScan.match(new RegExp(`KARTA\\s+[ČC]ÁSTI:\\s*([^\\n]+)`, "i"));
              const partName = partMatch?.[1]?.trim() || "";
              const simpleTalents = section.match(/(?:talent|schopnost|zájem|nadání)[:\s]+([^\n,]+)/gi);
              if (simpleTalents) {
                for (const st of simpleTalents) {
                  const area = st.replace(/^(?:talent|schopnost|zájem|nadání)[:\s]+/i, "").trim();
                  if (area.length > 2 && !talents.some(t => t.area.toLowerCase() === area.toLowerCase())) {
                    talents.push({ area, level: "nespecifikováno", activity: "doporučit", partName });
                  }
                }
              }
            }
          }

          if (talents.length > 0) {
            const talentBlock = talents.slice(0, 8).map(t =>
              `• ${t.partName ? `[${t.partName}] ` : ""}${t.area} (${t.level}) → doporučená aktivita: ${t.activity}`
            ).join("\n");
            
            systemPrompt += `\n\n═══ PERSONALIZOVANÁ DOPORUČENÍ (Smart Activity Recommender) ═══
Karel zná tyto talenty a zájmy dětí:
${talentBlock}

INSTRUKCE: Když se rozhovor týká konkrétního dítěte s identifikovaným talentem, Karel PROAKTIVNĚ navrhne rozvíjející aktivitu na míru. Například:
- Dítě se zájmem o fyziku → navrhni experiment, hádanku, edukační hru
- Dítě se zájmem o hudbu → navrhni rytmické cvičení, poslech, jednoduchou kompozici
- Část se zájmem o kreslení → navrhni art-therapy aktivitu na míru tématu
Karel doporučení přirozeně začlení do rozhovoru, ne jako seznam.`;
          }
        } catch (e) {
          console.warn("Smart Activity Recommender error (non-fatal):", e);
        }

      } catch (e) {
        console.warn("Task/insight injection error (non-fatal):", e);
      }
    }

    // ═══ LANGUAGE ADAPTATION for "cast" mode ═══
    // Detect language of last user message and enforce matching response language
    let detectedLang = "";
    if (didSubMode === "cast" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
      if (lastUserText.length > 0) {
        const hasCyrillic = /[\u0400-\u04FF]/.test(lastUserText);
        const hasNordic = /[æøåÆØÅ]/.test(lastUserText);
        const hasArabic = /[\u0600-\u06FF]/.test(lastUserText);
        const hasChinese = /[\u4e00-\u9fff]/.test(lastUserText);
        
        // More aggressive detection with more keywords
        const looksEnglish = /\b(the|is|are|was|were|have|has|had|my|your|this|that|what|how|why|do|don't|doesn't|I'm|I am|you|hello|hi|please|thank|want|need|feel|think|know|like|can|will|would|should|could|come|go|see|look|tell|say|said|because|but|and|or|not|no|yes|okay|ok|hey|sorry|help|name|where|when|who)\b/i.test(lastUserText);
        const looksGerman = /\b(ich|bin|ist|das|die|der|und|nicht|ein|eine|haben|sein|mir|mich|wie|was|warum|hallo|bitte|danke|gut|schlecht|ja|nein|kann|will|muss|soll|hier|dort|heute|morgen|gehen|kommen|sagen|machen)\b/i.test(lastUserText);
        const looksNorwegian = /\b(jeg|er|det|og|ikke|har|vil|kan|med|fra|hei|takk|hva|hvorfor|fordi|meg|deg|han|hun|den|denne|skal|må|bli|være|gå|komme|si|gjøre|snakke|forstå)\b/i.test(lastUserText);
        const looksSpanish = /\b(yo|es|el|la|los|las|un|una|que|por|para|con|hola|gracias|sí|no|tengo|quiero|puedo|estoy|como|donde|cuando|pero|también|muy|bien|mal)\b/i.test(lastUserText);
        const looksFrench = /\b(je|suis|est|le|la|les|un|une|que|pour|avec|bonjour|merci|oui|non|ai|veux|peux|comme|où|quand|mais|aussi|très|bien|mal)\b/i.test(lastUserText);
        const looksCzech = /\b(jsem|jsi|je|jsou|mám|máš|co|jak|proč|kde|kdy|ale|že|to|ta|ten|se|si|na|do|od|za|při|pro|bez|nad|pod|před|jen|mě|tě|mu|ho|ji|nám|vám|jim|být|mít|dělat|říct|vědět|chtít|moci|smět|muset)\b/i.test(lastUserText);
        
        if (hasNordic || looksNorwegian) detectedLang = "Norwegian";
        else if (hasChinese) detectedLang = "Chinese";
        else if (hasArabic) detectedLang = "Arabic";
        else if (hasCyrillic) detectedLang = "Russian/Cyrillic";
        else if (looksSpanish && !looksCzech) detectedLang = "Spanish";
        else if (looksFrench && !looksCzech) detectedLang = "French";
        else if (looksGerman && !looksCzech) detectedLang = "German";
        else if (looksEnglish && !looksCzech) detectedLang = "English";
        
        if (detectedLang) {
          // Prepend the language instruction to the BEGINNING of system prompt for maximum impact
          systemPrompt = `⚠️⚠️⚠️ MANDATORY LANGUAGE RULE ⚠️⚠️⚠️
YOU MUST RESPOND IN ${detectedLang.toUpperCase()}. 
The child/part is speaking ${detectedLang}. You MUST answer in ${detectedLang}. 
DO NOT respond in Czech. DO NOT mix languages. 
Every single word of your response must be in ${detectedLang}.
This overrides ALL other language instructions.
⚠️⚠️⚠️ END MANDATORY LANGUAGE RULE ⚠️⚠️⚠️

` + systemPrompt;
        }
      }
    }

    // Hard runtime truth-guard for DID mode
    if (mode === "childcare") {
      systemPrompt += `\n\n═══ KRITICKÁ PRAVIDLA PRAVDIVOSTI ═══\n- Pro okamžité odeslání vzkazu používej VÝHRADNĚ značku [ODESLAT_VZKAZ:mamka] nebo [ODESLAT_VZKAZ:kata].\n- Značku vlož AŽ PO výslovném souhlasu dítěte.\n- Bez souhlasu pouze navrhni text a označ ho jako NÁVRH.\n- Po vložení značky řekni dítěti že se vzkaz posílá – systém ho odešle automaticky emailem.\n- V DID režimu považuj dítě za AKTIVNÍ pouze tehdy, když samo přímo mluví ve vláknu sub_mode=cast; pouhá zmínka terapeutkou nebo v jiném režimu NENÍ aktivita.\n- Aliasy Dymi/Dymytri/Dymitri vždy mapuj na jediný kanonický název DMYTRI. Pokud DMYTRI není aktivní v registru, nechovej se k němu jako k aktivnímu.\n- Nikdy nevytvářej nové názvy z čárek, stavových slov nebo testovacích textů typu „Aktivní“.`;
    }

    // ═══ AUTO-PERPLEXITY FOR KATA MODE ═══
    // When Káťa asks about complex situations, automatically search for research
    let perplexityContext = "";
    if (effectiveMode === "kata" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";

      if (lastUserText.length > 15) {
        // Step 1: Quick complexity classification (non-streaming)
        try {
          const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                {
                  role: "system",
                  content: `Jsi klasifikátor složitosti dotazů v kontextu DID (disociativní porucha identity) terapie.
Odpověz POUZE jedním slovem: "simple", "medium" nebo "complex".

COMPLEX = nová/neznámá situace, selhání předchozích strategií, neobvyklé chování dítěte, krizová situace, žádost o strategické sezení, specifická terapeutická technika, probouzení spícího dítěte, neznámý trigger.
MEDIUM = konkrétní dotaz na práci s dítětem, plánování aktivity, žádost o postup.
SIMPLE = obecný dotaz, pozdrav, potvrzení, krátká otázka.`,
                },
                { role: "user", content: lastUserText },
              ],
            }),
          });

          if (classifyResponse.ok) {
            const classifyData = await classifyResponse.json();
            const complexity = (classifyData.choices?.[0]?.message?.content || "").trim().toLowerCase();
            console.log("Kata complexity classification:", complexity, "for:", lastUserText.slice(0, 80));

            // Step 2: If complex or medium, call Perplexity
            if (complexity.includes("complex") || complexity.includes("medium")) {
              const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
              if (PERPLEXITY_API_KEY) {
                try {
                  // Extract part name from context or message
                  const partNameMatch = lastUserText.match(/(?:s|o|pro|na)\s+(\w+(?:em|kem|ou|kou|ím|em)?)/i);
                  const enrichedQuery = `DID terapie dětí: ${lastUserText.slice(0, 200)}. Terapeutické techniky, hry, strategie, desenzibilizace, grounding, attachment.`;

                  const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: "sonar",
                      messages: [
                        {
                          role: "system",
                          content: `Vyhledej odborné zdroje o DID (disociativní porucha identity) u dětí relevantní k dotazu. Zaměř se na:
- Konkrétní terapeutické techniky a metody (IFS, EMDR, sensomotorická terapie, hrová terapie)
- Praktické aktivity a hry pro práci s dětmi v DID péči
- Stabilizační a grounding techniky přizpůsobené dětem
- Attachment-based intervence
Odpověz v češtině. Buď stručný a praktický. Max 500 slov.`,
                        },
                        { role: "user", content: enrichedQuery },
                      ],
                      search_recency_filter: "year",
                    }),
                  });

                  if (perplexityResponse.ok) {
                    const perplexityData = await perplexityResponse.json();
                    const searchResults = perplexityData.choices?.[0]?.message?.content || "";
                    const citations = perplexityData.citations || [];
                    if (searchResults) {
                      perplexityContext = `\n\n═══ AUTOMATICKÁ REŠERŠE (Perplexity – relevantní výzkumy a metody) ═══\n${searchResults}`;
                      if (citations.length > 0) {
                        perplexityContext += `\n\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}`;
                      }
                      perplexityContext += `\n\n═══ INSTRUKCE: Výše uvedené výsledky rešerše VČLEŇ do své odpovědi Káťě. Cituj pouze zdroje z rešerše. Navrhni konkrétní techniky/hry na základě nalezených metod. ═══`;
                      console.log("Perplexity auto-research added for kata mode, length:", perplexityContext.length);
                    }
                  } else {
                    console.warn("Perplexity call failed:", perplexityResponse.status);
                  }
                } catch (e) {
                  console.warn("Perplexity auto-research error:", e);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Complexity classification error:", e);
        }
      }
    }

    // Append Perplexity context to system prompt if available
    if (perplexityContext) {
      systemPrompt += perplexityContext;
    }

    // ═══ SWITCHING DETECTION (F2) ═══
    if (didSubMode === "cast" && didPartName && messages.length >= 2) {
      try {
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
        const userMsgCount = messages.filter((m: any) => m.role === "user").length;

        // Performance optimization: skip first 2 messages, short messages, and only detect every 3rd unless suspicious
        let shouldDetect = false;
        if (userMsgCount <= 2) {
          shouldDetect = false;
        } else if (lastUserText.length < 10) {
          shouldDetect = false;
        } else if (/kdo|kde jsem|nejsem|to jsem|já jsem|pomoc|kdo jsi/i.test(lastUserText)) {
          shouldDetect = true; // Always detect on suspicious phrases
        } else if (userMsgCount % 3 === 0) {
          shouldDetect = true; // Every 3rd message
        }

        if (shouldDetect && lastUserText.length >= 10) {
          const { detectSwitching } = await import("../_shared/switchingDetector.ts");
          const { createClient: createSbSwitch } = await import("https://esm.sh/@supabase/supabase-js@2");
          const sbSwitch = createSbSwitch(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

          // Load known parts from registry
          let knownParts: any[] = [];
          try {
            const { data: registry } = await sbSwitch.from("did_part_registry")
              .select("part_name, display_name, age_estimate, language, known_triggers, known_strengths, cluster, role_in_system")
              .eq("status", "active");
            knownParts = (registry || []).map((p: any) => ({
              name: p.display_name || p.part_name,
              age: p.age_estimate || "neznámý",
              language_style: p.language || "cs",
              typical_topics: [],
              emotional_baseline: "neznámý",
              vocabulary_markers: (p.known_triggers || []).concat(p.known_strengths || []),
            }));
          } catch { knownParts = []; }

          const switchResult = await detectSwitching(
            didPartName,
            messages.slice(-8).map((m: any) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "(multimodal)" })),
            lastUserText,
            knownParts,
            LOVABLE_API_KEY!,
          );

          if (!switchResult.isSamePart && switchResult.confidence !== "low") {
            const switchedTo = switchResult.detectedPart || "neznámé dítě";
            console.log(`[karel-chat] SWITCH DETECTED: ${didPartName} → ${switchedTo} (${switchResult.confidence})`);

            // Log to DB
            await sbSwitch.from("switching_events").insert({
              thread_id: messages[0]?.threadId || "unknown",
              original_part: didPartName,
              detected_part: switchedTo,
              confidence: switchResult.confidence,
              signals: switchResult.signals,
              message_index: messages.length - 1,
              user_message_excerpt: lastUserText.slice(0, 200),
            }).then(() => {}).catch((e: any) => console.warn("[switching] DB insert error:", e));

            // Inject switching alert into system prompt
            systemPrompt += `\n\n═══ ⚠️ UPOZORNĚNÍ: DETEKOVÁN SWITCHING ═══
Původní dítě: ${didPartName}
Nově detekované dítě: ${switchedTo}
Jistota: ${switchResult.confidence}
Signály: ${switchResult.signals.join(", ")}
POKYN: ${switchResult.recommendation}

DŮLEŽITÉ CHOVÁNÍ PŘI SWITCHINGU:
1. NEŘÍKEJ "detekoval jsem switching" — to by bylo neterapeutické
2. Jemně ověř kdo mluví: "Ahoj... kdo je tu teď se mnou?" nebo "Cítím že se něco změnilo... jak se cítíš?"
3. Přizpůsob tón a slovník NOVÉMU dítěti
4. Pokud je nové dítě malé — zjednoduš jazyk, buď laskavý a bezpečný
5. Pokud je nové dítě ochranné/agresivní — buď klidný, respektuj hranice
6. NIKDY nenuť přepnutí zpět na původní dítě
7. Zapiš si co se stalo pro pozdější analýzu
═══════════════════════════════════════════════════`;
          }
        }
      } catch (switchErr) {
        console.warn("[karel-chat] Switching detection error (non-fatal):", switchErr);
      }
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((m: any) => {
            // Pass through multimodal content arrays as-is (OpenAI vision format)
            if (Array.isArray(m.content)) {
              return { role: m.role, content: m.content };
            }
            return m;
          }),
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ASYNC TASK EXTRACTION (non-blocking) ═══
    // Collect streamed response and extract tasks after sending
    const [streamForClient, streamForExtract] = response.body!.tee();

    // Fire-and-forget task extraction
    (async () => {
      try {
        const reader = streamForExtract.getReader();
        const decoder = new TextDecoder();
        let fullResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE data lines
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content || "";
                fullResponse += delta;
              } catch {}
            }
          }
        }

        // ═══ AUDIT GUARD (once over final text) ═══
        const audit = auditKarelOutput(fullResponse, ctx, `chat_${Date.now()}`);
        if (!audit.clean) {
          console.warn("[language-guard] violations in chat response:", audit.violations);
        }

        if (fullResponse.length > 20 && (mode === "childcare" || effectiveMode === "kata")) {
          const extractedTasks = extractTasksFromResponse(fullResponse, didSubMode || "general");
          if (extractedTasks.length > 0) {
            const { createClient: createSbForTasks } = await import("https://esm.sh/@supabase/supabase-js@2");
            const sbTasks = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
            
            // Get user_id
            let taskUserId: string | null = null;
            const taskAuth = req.headers.get("Authorization");
            if (taskAuth?.startsWith("Bearer ")) {
              const userSbT = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: taskAuth } },
              });
              const { data: { user } } = await userSbT.auth.getUser();
              taskUserId = user?.id || null;
            }

            if (taskUserId) {
              // ═══ FEASIBILITY GUARD PIPELINE ═══
              // 1. Load part registry for activity assessment
              const { data: registryData } = await sbTasks.from("did_part_registry")
                .select("part_name, status, last_seen_at");
              const registryMap = new Map<string, any>();
              for (const r of (registryData || [])) {
                registryMap.set(r.part_name, r);
              }

              // 2. Load recent activity for BOTH therapist mentions AND direct child activity (last 48h)
              const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
              // Query ALL relevant sub_modes — therapist + cast — so direct activity evidence is real
              const { data: recentThreads } = await sbTasks.from("did_threads")
                .select("id, sub_mode, part_name, last_activity_at, messages")
                .in("sub_mode", ["mamka", "kata", "cast"])
                .gte("last_activity_at", twoDaysAgo)
                .limit(40);

               // ═══ Phase 4C: Therapist evidence via shared helper ═══
              const rows = (recentThreads || []) as DidThreadLite[];
              const { castRows, therapistRows } = splitRecentThreads(rows);
              const circumstanceSnippets = extractTherapistActivitySnippets(therapistRows);
              const circumstances = detectCircumstances(circumstanceSnippets);
              if (circumstanceSnippets.length > 0) {
                console.log(`[task-guard] Circumstance profiler: ${circumstanceSnippets.length} snippets, ${circumstances.length} circumstances detected`);
              }

              // 3. For each task, run feasibility guard
              const feasibleRows: Array<Record<string, any>> = [];
              for (const t of extractedTasks) {
                const targetPart = t.related_part;
                let entityAssessment = null;

                if (targetPart) {
                  const regEntry = registryMap.get(targetPart);
                  const lastDirectThread = castRows.find(
                    (th) => th.part_name === targetPart
                  );
                  const recentDirectCount = castRows.filter(
                    (th) => th.part_name === targetPart
                  ).length;

                  // Phase 4C: mention evidence via shared helper (message-level timestamp)
                  const mentionEvidence = findLastTherapistMentionEvidence(
                    therapistRows,
                    targetPart,
                    [], // alias source not yet available
                  );

                  const evidence: ActivityEvidenceInput = {
                    entityName: targetPart,
                    entityKind: "did_child",
                    lastDirectThreadDate: lastDirectThread?.last_activity_at || regEntry?.last_seen_at || null,
                    lastTherapistMentionDate: mentionEvidence.mentionedAt,
                    recentDirectThreadCount: recentDirectCount,
                  };
                  entityAssessment = assessActivityStatus(evidence);
                }

                const proposal: TaskProposal = {
                  taskText: t.description,
                  assignedTo: t.assigned_to,
                  targetEntity: targetPart || undefined,
                };
                const result = checkTaskFeasibility(proposal, entityAssessment, circumstances);

                // Apply verdict
                if (result.verdict === "allowed") {
                  feasibleRows.push({ ...t, user_id: taskUserId });
                } else if (result.alternativeTask) {
                  // Use the safe alternative
                  feasibleRows.push({
                    ...t,
                    description: result.alternativeTask.slice(0, 500),
                    user_id: taskUserId,
                  });
                  console.log(`[task-guard] ${result.verdict}: "${t.description.slice(0,60)}" → alternative`);
                } else {
                  // Fully blocked, no alternative — skip
                  console.log(`[task-guard] BLOCKED (${result.verdict}): "${t.description.slice(0,60)}" — ${result.reasons.join("; ")}`);
                }
              }

              if (feasibleRows.length > 0) {
                const { error: insErr } = await sbTasks.from("did_tasks").insert(feasibleRows);
                if (insErr) console.warn("[task-extract] Insert error:", insErr.message);
                else console.log(`[task-extract] Saved ${feasibleRows.length}/${extractedTasks.length} tasks (${extractedTasks.length - feasibleRows.length} blocked/downgraded)`);
              } else if (extractedTasks.length > 0) {
                console.log(`[task-guard] All ${extractedTasks.length} tasks blocked by feasibility guard`);
              }
            }
          }
        }

        // ═══ POST-CHAT MEMORY EXTRACTION (fire-and-forget) ═══
        // For hana_personal, mamka, kata: extract structured memory outputs
        // and enqueue them as governed writes to PAMET_KAREL destinations
        // Detect memory-eligible modes using the same convention as the rest of the file
        // didSubMode "general" within mode "childcare" = Hana/osobní (see line ~351)
        const isHanaPersonal = mode === "childcare" && didSubMode === "general";
        const isMemoryMode = isHanaPersonal || didSubMode === "mamka" || didSubMode === "kata";

        if (isMemoryMode && fullResponse.length > 30) {
          const { createClient: createSbForMem } = await import("https://esm.sh/@supabase/supabase-js@2");
          const sbMem = createSbForMem(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

          try {
            const lastUserMsgMem = (messages as any[]).filter((m: any) => m.role === "user").pop();
            const userTextMem = typeof lastUserMsgMem?.content === "string" ? lastUserMsgMem.content : "";

            if (userTextMem.length > 15) {
              const therapistKey: "HANKA" | "KATA" = didSubMode === "kata" ? "KATA" : "HANKA";
              const modeLabel = isHanaPersonal ? "Hana/osobní" : didSubMode === "mamka" ? "DID/Terapeut mamka" : "DID/Terapeut kata";
              const chatSourceId = `chat_${didThreadLabel || didSubMode || "unknown"}_${lastUserMsgMem?.created_at || Date.now()}`;

              // ═══ Phase 5: Structured extraction prompt ═══
              const extractionPrompt = buildExtractionPrompt(
                userTextMem,
                fullResponse,
                modeLabel,
                isHanaPersonal,
              );

              // AI call with AbortController timeout (15s)
              const memController = new AbortController();
              const memTimeout = setTimeout(() => memController.abort(), 15000);

              const memExtractRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${LOVABLE_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: "Jsi analytický modul. Odpovídej POUZE validním JSON." },
                    { role: "user", content: extractionPrompt },
                  ],
                  temperature: 0.1,
                }),
                signal: memController.signal,
              });

              clearTimeout(memTimeout);

              if (memExtractRes.ok) {
                const memData = await memExtractRes.json();
                const rawMem = (memData.choices?.[0]?.message?.content || "").trim();
                const cleanMem = rawMem.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

                let memResult: { outputs: ExtractedWriteOutput[] };
                try {
                  memResult = JSON.parse(cleanMem);
                } catch {
                  console.warn("[post-chat-writeback] JSON parse failed, skipping. Raw:", cleanMem.slice(0, 200));
                  memResult = { outputs: [] };
                }

                if (memResult.outputs && Array.isArray(memResult.outputs) && memResult.outputs.length > 0) {
                  // ═══ Phase 5: Load part registry for active/dormant routing ═══
                  const { data: partRegData } = await sbMem.from("did_part_registry")
                    .select("part_name, status, last_seen_at");
                  const partRegMap = new Map<string, PartRegistryLookup>();
                  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                  for (const r of (partRegData || [])) {
                    partRegMap.set(r.part_name, {
                      status: r.status,
                      hasRecentDirectActivity: r.last_seen_at
                        ? new Date(r.last_seen_at).getTime() > sevenDaysAgo
                        : false,
                    });
                  }

                  // ═══ Phase 5: Route, validate, guard, dedupe ═══
                  const writebackCtx: WritebackContext = {
                    therapistKey,
                    sourceMode: modeLabel,
                    sourceThreadId: didThreadLabel || null,
                    isHanaPersonal,
                    partRegistryLookup: (name: string) => partRegMap.get(name) || null,
                  };

                  const { intents, rejected } = buildGovernedWriteIntents(
                    memResult.outputs,
                    writebackCtx,
                  );

                  if (rejected.length > 0) {
                    console.log(`[post-chat-writeback] ${rejected.length} outputs rejected: ${rejected.map(r => r.reason).join(", ")}`);
                  }

                  // ═══ Phase 5: Enqueue via governed write pipeline ═══
                  let insertedCount = 0;
                  for (const intent of intents) {
                    const governedContent = encodeGovernedWrite(
                      intent.content,
                      {
                        source_type: "chat_memory_extraction",
                        source_id: `${chatSourceId}_${intent.evidenceKind}`,
                        content_type: intent.target.bucket.startsWith("plan_")
                          ? intent.target.bucket
                          : intent.target.bucket === "active_part_card" || intent.target.bucket === "dormant_part_card"
                            ? "card_section_update"
                            : intent.target.bucket,
                        subject_type: intent.target.bucket.includes("part_card") ? "part" : "therapist",
                        subject_id: intent.target.documentKey.split("/").pop() || therapistKey.toLowerCase(),
                      },
                    );

                    const { error: writeErr } = await sbMem.from("did_pending_drive_writes").insert({
                      target_document: intent.target.documentKey,
                      content: governedContent,
                      priority: intent.evidenceKind === "FACT" ? "high" : "normal",
                      status: "pending",
                      write_type: "append",
                    });

                    if (writeErr) {
                      console.warn(`[post-chat-writeback] Write error for ${intent.target.documentKey}:`, writeErr.message);
                    } else {
                      insertedCount++;
                    }
                  }

                  if (insertedCount > 0) {
                    console.log(`[post-chat-writeback] ${insertedCount} governed writes enqueued for ${modeLabel} (${intents.length} intents, ${rejected.length} rejected)`);
                  }
                } else {
                  console.log(`[post-chat-writeback] No relevant outputs for ${modeLabel}`);
                }
              } else {
                console.warn(`[post-chat-writeback] AI extraction failed: ${memExtractRes.status}`);
              }
            }
          } catch (memExtractErr) {
            console.error("[post-chat-writeback] Extraction error (non-fatal):", memExtractErr);
          }
        }

        // ═══ SAFETY CHECK (fire-and-forget via separate edge function) ═══
        if (didSubMode === "cast" && didPartName) {
          const lastUserMsg = (messages as any[]).filter((m: any) => m.role === "user").pop();
          const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
          if (userText.length > 5) {
            fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/safety-check`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ userText, partName: didPartName }),
            }).catch(e => console.warn("[safety] check failed:", e));
          }
        }

        // ═══ ASYNC CRISIS CONVERSATION ANALYSIS (fire-and-forget) ═══
        // If the part has an active crisis, analyze each exchange for risk signals
        if (didSubMode === "cast" && didPartName && fullResponse.length > 10) {
          try {
            const { createClient: createSbCrisisPost } = await import("https://esm.sh/@supabase/supabase-js@2");
            const sbCrisisPost = createSbCrisisPost(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

            const { data: activeCrisisPost } = await sbCrisisPost
              .from("crisis_alerts")
              .select("id, days_in_crisis, severity, summary")
              .eq("part_name", didPartName)
              .in("status", ["ACTIVE", "ACKNOWLEDGED"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (activeCrisisPost) {
              const lastUserMsgCrisis = (messages as any[]).filter((m: any) => m.role === "user").pop();
              const userTextCrisis = typeof lastUserMsgCrisis?.content === "string" ? lastUserMsgCrisis.content : "";

              const analysisPrompt = `Analyzuj tuto zprávu od dítěte "${didPartName}" v kontextu aktivní krize. Identifikuj:

ZPRÁVA ČÁSTI: "${userTextCrisis.slice(0, 500)}"
ODPOVĚĎ KARLA: "${fullResponse.slice(0, 500)}"

Odpověz v JSON:
{
  "risk_signals": ["signal1"],
  "protective_factors": ["factor1"],
  "emotional_indicators": {"valence": 1-10, "arousal": 1-10, "stability": 1-10},
  "cooperation_level": "cooperative|resistant|avoidant|hostile|mixed",
  "immediate_danger": false,
  "test_results": [],
  "session_notes": "stručné poznámky"
}`;

              const analysisResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${LOVABLE_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: analysisPrompt },
                    { role: "user", content: "Analyzuj." },
                  ],
                  temperature: 0.1,
                  response_format: { type: "json_object" },
                }),
              });

              if (analysisResp.ok) {
                const analysisData = await analysisResp.json();
                const rawContent = analysisData.choices?.[0]?.message?.content || "{}";
                const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```/g, "").trim();
                const analysis = JSON.parse(cleaned);

                // Get last assessment id
                const { data: lastAssessmentForSession } = await sbCrisisPost
                  .from("crisis_daily_assessments")
                  .select("id")
                  .eq("crisis_alert_id", activeCrisisPost.id)
                  .order("day_number", { ascending: false })
                  .limit(1)
                  .maybeSingle();

                await sbCrisisPost.from("crisis_intervention_sessions").insert({
                  crisis_alert_id: activeCrisisPost.id,
                  assessment_id: lastAssessmentForSession?.id || null,
                  session_type: "safety_check_in",
                  part_name: didPartName,
                  session_summary: analysis.session_notes,
                  key_findings: [
                    ...(analysis.risk_signals || []).map((s: string) => ({ type: "risk", detail: s })),
                    ...(analysis.protective_factors || []).map((f: string) => ({ type: "protective", detail: f })),
                  ],
                  risk_indicators_found: analysis.risk_signals || [],
                  protective_factors_found: analysis.protective_factors || [],
                  session_outcome: analysis.immediate_danger ? "alarming"
                    : (analysis.emotional_indicators?.valence || 5) < 3 ? "concerning"
                    : (analysis.emotional_indicators?.valence || 5) >= 6 ? "positive"
                    : "neutral",
                  follow_up_needed: analysis.immediate_danger || (analysis.risk_signals || []).length > 0,
                  follow_up_notes: analysis.immediate_danger ? "OKAMŽITÁ ESKALACE POTŘEBNÁ" : null,
                });

                if (analysis.immediate_danger) {
                  await sbCrisisPost.from("safety_alerts").insert({
                    part_name: didPartName,
                    alert_type: "immediate_danger_during_crisis",
                    severity: "critical",
                    status: "new",
                    description: `Během krizového rozhovoru detekováno okamžité nebezpečí. Signály: ${(analysis.risk_signals || []).join(", ")}`,
                    source: "crisis_conversation",
                  });
                }

                console.log(`[karel-chat] Crisis conversation analysis saved for ${didPartName}: danger=${analysis.immediate_danger}`);
              }
            }
          } catch (crisisPostErr) {
            console.error("[karel-chat] Crisis post-processing error (non-fatal):", crisisPostErr);
          }
        }

        // ═══ ASYNC CRISIS DETECTOR (non-blocking) ═══
        // Runs for every "cast" message — detects crisis signals in conversation
        if (didSubMode === "cast" && fullResponse.length > 10) {
          try {
            // Build last 6-10 messages for analysis
            const recentMessages = (messages as any[]).slice(-10).map((m: any) => {
              const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
              return `${m.role === "user" ? (didPartName || "Dítě") : "Karel"}: ${content}`;
            });
            // Add Karel's latest response
            recentMessages.push(`Karel: ${fullResponse.slice(0, 2000)}`);
            const conversationExcerpt = recentMessages.join("\n\n");

            const crisisDetectResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${LOVABLE_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  {
                    role: "system",
                    content: `Jsi krizový detektor. Analyzuješ konverzaci mezi terapeutem (Karel) a dítětem.

Tvůj JEDINÝ úkol: rozhodnout, zda klient vykazuje známky krize.

Krizové signály (stačí JEDEN):
- Pláč, slzy, emoční kolaps
- "Jsem v nebezpečí" (vnitřním nebo vnějším)
- Zmínka o útoku (verbálním nebo fyzickém) od kohokoli
- Vyhrožování, nátlak, vydírání (od kohokoli)
- Bezmoc ("nemám jak se bránit", "nemůžu nic dělat")
- Opuštěnost ("nikdo mi nepomůže", "nikdo nemá čas")
- Sebepoškození nebo suicidální myšlenky (jakákoli zmínka)
- Manipulace nebo zneužití (včetně finančního)
- Extrémní strach nebo úzkost
- Zmínka o konkrétní osobě která ubližuje

Odpověz POUZE platným JSON objektem, nic jiného:

Pokud NENÍ krize:
{"crisis": false}

Pokud JE krize:
{
  "crisis": true,
  "severity": "HIGH" nebo "CRITICAL",
  "signals": ["seznam", "detekovaných", "signálů"],
  "summary": "2-3 věty co se děje",
  "assessment": "Karlovo vyhodnocení rizika a situace",
  "intervention_plan": "Co by měli terapeuti okamžitě udělat"
}

CRITICAL = přímé ohrožení (sebepoškození, suicidální myšlenky, fyzické násilí, akutní nebezpečí)
HIGH = závažný distres bez přímého ohrožení života`,
                  },
                  { role: "user", content: conversationExcerpt },
                ],
              }),
            });

            if (crisisDetectResponse.ok) {
              const crisisData = await crisisDetectResponse.json();
              const crisisText = (crisisData.choices?.[0]?.message?.content || "").trim();
              // Strip markdown fences if present
              const cleanJson = crisisText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
              
              let crisisResult: any;
              try {
                crisisResult = JSON.parse(cleanJson);
              } catch {
                console.warn("[crisis-detector] Failed to parse response:", crisisText.slice(0, 200));
                crisisResult = { crisis: false };
              }

              if (crisisResult.crisis === true) {
                console.log(`[crisis-detector] 🚨 CRISIS DETECTED for ${didPartName || "unknown"}: severity=${crisisResult.severity}`);
                
                const { createClient: createSbCrisis } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sbCrisis = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

                const partName = didPartName || "Neznámé dítě";

                // Check for existing ACTIVE alert for this conversation
                // Use part_name as fallback grouping if no conversation_id
                const { data: existingAlerts } = await sbCrisis.from("crisis_alerts")
                  .select("id")
                  .eq("status", "ACTIVE")
                  .eq("part_name", partName)
                  .limit(1);

                if (existingAlerts && existingAlerts.length > 0) {
                  // UPDATE existing alert
                  const { error: updErr } = await sbCrisis.from("crisis_alerts")
                    .update({
                      summary: crisisResult.summary || "Aktualizovaná krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                      severity: crisisResult.severity || "HIGH",
                    })
                    .eq("id", existingAlerts[0].id);
                  if (updErr) console.warn("[crisis-detector] Update error:", updErr.message);
                  else console.log(`[crisis-detector] Updated existing alert ${existingAlerts[0].id}`);
                } else {
                  // INSERT new alert
                  const { data: newAlert, error: insErr } = await sbCrisis.from("crisis_alerts")
                    .insert({
                      part_name: partName,
                      severity: crisisResult.severity || "HIGH",
                      summary: crisisResult.summary || "Detekována krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                    })
                    .select("id")
                    .single();

                  if (insErr) {
                    console.error("[crisis-detector] Insert alert error:", insErr.message);
                  } else if (newAlert) {
                    console.log(`[crisis-detector] Created alert ${newAlert.id}, creating tasks + thread...`);
                    
                    // Look up matching crisis_event for unified FK
                    const { data: matchedCrisisEvent } = await sbCrisis.from("crisis_events")
                      .select("id")
                      .eq("part_name", partName)
                      .neq("phase", "CLOSED")
                      .order("created_at", { ascending: false })
                      .limit(1)
                      .maybeSingle();
                    const crisisEventIdForTask = matchedCrisisEvent?.id || null;

                    // INSERT two crisis tasks
                    const { error: taskErr } = await sbCrisis.from("crisis_tasks").insert([
                      {
                        crisis_alert_id: newAlert.id,
                        crisis_event_id: crisisEventIdForTask,
                        title: `KRIZOVÁ INTERVENCE – ${partName}`,
                        description: `Okamžitě kontaktovat ${partName}. ${crisisResult.summary || ""}`,
                        assigned_to: "hanicka",
                        priority: "CRITICAL",
                      },
                      {
                        crisis_alert_id: newAlert.id,
                        crisis_event_id: crisisEventIdForTask,
                        title: `KRIZOVÁ INTERVENCE – podpora – ${partName}`,
                        description: `Podpořit Haničku v krizové intervenci. ${crisisResult.summary || ""}`,
                        assigned_to: "kata",
                        priority: "CRITICAL",
                      },
                    ]);
                    if (taskErr) console.error("[crisis-detector] Insert tasks error:", taskErr.message);
                    else console.log(`[crisis-detector] Created 2 crisis tasks for alert ${newAlert.id}`);

                    // ═══ CREATE CRISIS THREAD (krizová porada) ═══
                    try {
                      const now = new Date();
                      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
                      const timeStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
                      const signalsList = (crisisResult.signals || []).map((s: string) => `  • ${s}`).join("\n");

                      const karelFirstMessage = `⚠️ KRIZOVÁ INTERVENCE – AKTIVOVÁNO

Část: ${partName}
Čas detekce: ${dateStr} ${timeStr}
Úroveň rizika: ${crisisResult.severity || "HIGH"}

CO SE STALO:
${crisisResult.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

KLÍČOVÉ ÚRYVKY Z ROZHOVORU:
${conversationExcerpt.slice(0, 3000)}

MOJE VYHODNOCENÍ:
${crisisResult.assessment || "Vyhodnocení není k dispozici."}

NAVRŽENÝ PLÁN OKAMŽITÉ INTERVENCE:
${crisisResult.intervention_plan || "Plán není k dispozici."}

---

Haničko, Káťo – potřebuji vás okamžitě.
Připojte se do tohoto vlákna. Situace vyžaduje koordinovaný zásah.
Dokud se nepřipojíte, pokračuji ve stabilizaci ${partName} v probíhajícím rozhovoru.
Čekám na vaše instrukce.`;

                      // Get user_id for the thread
                      let crisisUserId: string | null = null;
                      const crisisAuth = req.headers.get("Authorization");
                      if (crisisAuth?.startsWith("Bearer ")) {
                        const userSbCr = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                          global: { headers: { Authorization: crisisAuth } },
                        });
                        const { data: { user: crUser } } = await userSbCr.auth.getUser();
                        crisisUserId = crUser?.id || null;
                      }

                      if (crisisUserId) {
                        const threadLabel = `🔴 KRIZOVÁ INTERVENCE – ${partName} – ${dateStr}`;
                        const { data: newThread, error: threadErr } = await sbCrisis.from("did_threads")
                          .insert({
                            user_id: crisisUserId,
                            part_name: partName,
                            sub_mode: "crisis",
                            thread_label: threadLabel,
                            thread_emoji: "🔴",
                            messages: [
                              { role: "assistant", content: karelFirstMessage, timestamp: now.toISOString() }
                            ],
                            last_activity_at: now.toISOString(),
                            is_processed: false,
                            theme_preset: "default",
                          })
                          .select("id")
                          .single();

                        if (threadErr) {
                          console.error("[crisis-detector] Create thread error:", threadErr.message);
                        } else if (newThread) {
                          // Link thread to alert
                          await sbCrisis.from("crisis_alerts")
                            .update({ crisis_thread_id: newThread.id })
                            .eq("id", newAlert.id);
                          console.log(`[crisis-detector] Created crisis thread ${newThread.id} for alert ${newAlert.id}`);
                        }
                      } else {
                        console.warn("[crisis-detector] No user_id for crisis thread creation");
                      }
                    } catch (threadErr) {
                      console.error("[crisis-detector] Thread creation error (non-fatal):", threadErr);
                    }
                  }
                }
              } else {
                console.log(`[crisis-detector] No crisis detected for ${didPartName || "unknown"}`);
              }
            } else {
              console.warn("[crisis-detector] AI call failed:", crisisDetectResponse.status);
            }
          } catch (crisisErr) {
            console.error("[crisis-detector] Error (non-fatal):", crisisErr);
          }
        }
      } catch (e) {
        console.warn("[task-extract] Async extraction error (non-fatal):", e);
      }
    })();

    return new Response(streamForClient, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});


