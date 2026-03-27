import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not set");

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: threads, error: thErr } = await sb
      .from("did_threads")
      .select("id, part_name, messages, last_activity_at, user_id")
      .eq("sub_mode", "cast");

    if (thErr) throw thErr;
    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ scanned: 0, crises: 0, message: "No cast threads found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[retro-scan] Scanning ${threads.length} cast threads...`);
    const results: any[] = [];

    for (const thread of threads) {
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      if (msgs.length < 2) continue;

      const last15 = msgs.slice(-15);
      const excerpt = last15.map((m: any) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role === "user" ? (thread.part_name || "Část") : "Karel"}: ${content}`;
      }).join("\n\n");

      // ── STEP 1: Crisis detection ──
      const detectResp = await fetch(AI_GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            {
              role: "system",
              content: `Jsi krizový detektor. Analyzuješ konverzaci mezi terapeutem (Karel) a klientem (část osobnosti).

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
            { role: "user", content: excerpt },
          ],
        }),
      });

      if (!detectResp.ok) {
        console.warn(`[retro-scan] Detection failed for thread ${thread.id}: ${detectResp.status}`);
        continue;
      }

      const detectData = await detectResp.json();
      const detectText = (detectData.choices?.[0]?.message?.content || "").trim();
      const cleanJson = detectText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      let crisisResult: any;
      try {
        crisisResult = JSON.parse(cleanJson);
      } catch {
        console.warn(`[retro-scan] Parse failed for thread ${thread.id}`);
        continue;
      }

      if (crisisResult.crisis !== true) {
        console.log(`[retro-scan] Thread ${thread.id} (${thread.part_name}): no crisis`);
        results.push({ thread_id: thread.id, part_name: thread.part_name, crisis: false });
        continue;
      }

      console.log(`[retro-scan] 🚨 CRISIS in thread ${thread.id} (${thread.part_name}): ${crisisResult.severity}`);

      // Check for existing active alert
      const { data: existing } = await sb.from("crisis_alerts")
        .select("id")
        .eq("part_name", thread.part_name)
        .eq("status", "ACTIVE")
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`[retro-scan] Alert already exists for ${thread.part_name}, skipping`);
        results.push({ thread_id: thread.id, part_name: thread.part_name, crisis: true, action: "already_exists" });
        continue;
      }

      // Extract client quotes
      const userMessages = msgs
        .filter((m: any) => m.role === "user")
        .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      const lastUserQuotes = userMessages.slice(-5);
      const quotesBlock = lastUserQuotes.length > 0
        ? lastUserQuotes.map((q: string) => `> ${q.slice(0, 300)}`).join("\n\n")
        : "> (žádné přímé citace k dispozici)";

      // ── STEP 2: Karel AI generates COMPLETE session plans ──
      console.log(`[retro-scan] Generating intervention plans for ${thread.part_name}...`);

      const planResp = await fetch(AI_GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Jsi Karel, vedoucí terapeutického týmu pro klienta s DID. Právě jsi detekoval krizi u části jménem ${thread.part_name}.

Tvoje role: TY sám analyzuješ, TY sám sestavuješ plány, TY sám formuluješ otázky. Terapeutky (Káťa a Hanička) PROVÁDĚJÍ tvé plány – NEPROHLEDÁVAJÍ kartotéku, NESESTAVUJÍ plány, NEVYMÝŠLEJÍ co dělat.

Detekované signály: ${(crisisResult.signals || []).join(", ")}
Shrnutí krize: ${crisisResult.summary || "Krizová situace detekována"}

Na základě rozhovoru s klientem vytvoř:

1. KOMPLETNÍ plán telefonátu pro Káťu (15-20 minut). Piš PŘESNÉ VĚTY které má Káťa říct klientovi. Krok po kroku. Včetně úvodní věty, validace, otázek na bezpečí, nabídky pomoci.

2. KOMPLETNÍ plán večerního fyzického sezení pro Haničku (60 minut). Piš MINUTA PO MINUTĚ. Piš PŘESNÉ VĚTY které má Hanička říct. Včetně pozorování, otázek, aktivit.

3. Formuluj 5 KONKRÉTNÍCH situačních otázek pro Haničku (co má po sezení odpovědět do porady).

4. Formuluj 3 KONKRÉTNÍ otázky pro Káťu (co má po telefonátu odpovědět do porady).

5. Tvůj vlastní plán (co uděláš ty, Karel, v textovém vlákně s klientem).

6. Hlavní cíl krizové intervence jednou větou.

Odpověz POUZE platným JSON:
{
  "kata_call_plan": "KOMPLETNÍ plán telefonátu krok po kroku s přesnými větami",
  "hanka_session_plan": "KOMPLETNÍ plán sezení minuta po minutě s přesnými větami",
  "hanka_questions": ["otázka1", "otázka2", "otázka3", "otázka4", "otázka5"],
  "kata_questions": ["otázka1", "otázka2", "otázka3"],
  "karel_plan": "co udělá Karel sám",
  "session_goal": "hlavní cíl jednou větou"
}`,
            },
            { role: "user", content: excerpt },
          ],
        }),
      });

      let analysis: any = null;
      if (planResp.ok) {
        const planData = await planResp.json();
        const planText = (planData.choices?.[0]?.message?.content || "").trim();
        const cleanPlan = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        try {
          analysis = JSON.parse(cleanPlan);
        } catch {
          console.warn(`[retro-scan] Plan parse failed for ${thread.part_name}, using fallback`);
        }
      }

      // Fallback if AI plan generation failed
      if (!analysis) {
        analysis = {
          kata_call_plan: `KÁŤO – zavolej ${thread.part_name} IHNED.\n1. Řekni: '${thread.part_name}, tady Káťa. Vím co se děje. Jsem tu pro tebe.'\n2. Poslouchej 2-3 minuty. Nepřerušuj.\n3. Zeptej se: 'Jsi teď v bezpečí?'\n4. Nabídni: 'Dnes večer uděláme sezení.'`,
          hanka_session_plan: `HANIČKO – večer proveď 60min sezení s ${thread.part_name}.\n0-5 min: Přijď, sedni si vedle. Řekni: 'Nemusíš nic dělat, jsem tu.'\n5-15 min: 'Jak se cítíš? Co tě trápí nejvíc?'\n15-30 min: Nech mluvit. Zapiš klíčová slova.\n30-50 min: 'Pojďme vymyslet co s tím.' Hledej alternativy.\n50-60 min: 'Jsem tu pro tebe. Zítra se ozve Káťa a Karel.'`,
          hanka_questions: [
            "Byl v těle klient nebo někdo jiný?",
            "Jak reagoval na zmínku o situaci?",
            "Jaké alternativy vymyslel?",
            "Jak se cítil na konci sezení (1-10)?",
            "Řekl něco nečekaného?",
          ],
          kata_questions: [
            "Zvedl telefon?",
            "Jak reagoval? (klidný/rozrušený/plakal)",
            "Je v bezpečí?",
          ],
          karel_plan: "Budu sledovat vlákno, odpovídat klientovi, koordinovat tým.",
          session_goal: "Ověřit bezpečí a vytvořit plán ochrany.",
        };
      }

      const now = new Date();
      const dateStr = `${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}`;
      const signalsList = (crisisResult.signals || []).map((s: string) => `  • ${s}`).join("\n");
      const totalMsgs = msgs.length;

      // ── STEP 3: Build meeting message with FULL plans ──
      const meetingMessage = buildMeetingMessage(
        thread.part_name, crisisResult, analysis,
        signalsList, quotesBlock, totalMsgs, dateStr
      );

      // ── STEP 4: Insert crisis alert ──
      const { data: newAlert, error: alertErr } = await sb.from("crisis_alerts")
        .insert({
          part_name: thread.part_name,
          severity: crisisResult.severity || "HIGH",
          summary: crisisResult.summary || "Detekována krize (retroaktivní sken)",
          trigger_signals: crisisResult.signals || [],
          conversation_excerpts: excerpt.slice(0, 5000),
          karel_assessment: crisisResult.assessment || "",
          intervention_plan: crisisResult.intervention_plan || "",
          conversation_id: thread.id,
        })
        .select("id")
        .single();

      if (alertErr) {
        console.error(`[retro-scan] Alert insert error:`, alertErr.message);
        continue;
      }

      // ── STEP 5: Insert crisis_tasks (internal tracking) ──
      await sb.from("crisis_tasks").insert([
        {
          crisis_alert_id: newAlert!.id,
          title: `TELEFONÁT S ${thread.part_name.toUpperCase()} – krizová intervence`,
          description: analysis.kata_call_plan.slice(0, 500),
          assigned_to: "kata",
          priority: "CRITICAL",
        },
        {
          crisis_alert_id: newAlert!.id,
          title: `VEČERNÍ SEZENÍ S ${thread.part_name.toUpperCase()} – krizová intervence`,
          description: analysis.hanka_session_plan.slice(0, 500),
          assigned_to: "hanicka",
          priority: "CRITICAL",
        },
      ]);

      // ── STEP 6: Insert did_therapist_tasks with AI-generated COMPLETE plans ──
      const kataQuestionsBlock = analysis.kata_questions
        .map((q: string, i: number) => `${i + 1}. ${q}`)
        .join("\n");
      const hankaQuestionsBlock = analysis.hanka_questions
        .map((q: string, i: number) => `${i + 1}. ${q}`)
        .join("\n");

      await sb.from("did_therapist_tasks").insert([
        {
          user_id: thread.user_id,
          task: `⚠️ TELEFONÁT S ${thread.part_name.toUpperCase()} – krizová intervence`,
          detail_instruction: `${analysis.kata_call_plan}\n\nPO HOVORU IHNED napiš do krizové porady odpovědi na tyto otázky:\n${kataQuestionsBlock}`,
          assigned_to: "kata",
          priority: "urgent",
          status: "pending",
          status_hanka: "not_started",
          status_kata: "not_started",
          task_tier: "operative",
          category: "today",
        },
        {
          user_id: thread.user_id,
          task: `⚠️ VEČERNÍ SEZENÍ S ${thread.part_name.toUpperCase()} – krizová intervence`,
          detail_instruction: `${analysis.hanka_session_plan}\n\nPO SEZENÍ napiš do krizové porady odpovědi na tyto otázky:\n${hankaQuestionsBlock}`,
          assigned_to: "hanka",
          priority: "urgent",
          status: "pending",
          status_hanka: "not_started",
          status_kata: "not_started",
          task_tier: "operative",
          category: "today",
        },
        {
          user_id: thread.user_id,
          task: `⚠️ Aktualizace dat pro krizovou intervenci – ${thread.part_name}`,
          detail_instruction: `Káťo, prosím klikni postupně na:\n1. 'Aktualizace kartotéky'\n2. 'Aktualizovat centrum'\n3. 'Osvěž paměť'\nTím se Karlovi dostanou aktuální data pro plánování krizového sezení.`,
          assigned_to: "kata",
          priority: "urgent",
          status: "pending",
          status_hanka: "not_started",
          status_kata: "not_started",
          task_tier: "operative",
          category: "today",
        },
      ]);

      // ── STEP 7: Create crisis meeting in did_meetings ──
      const { data: crisisMeeting } = await sb.from("did_meetings").insert({
        user_id: thread.user_id,
        topic: `🔴 KRIZOVÁ PORADA – ${thread.part_name} – ${dateStr}`,
        agenda: `Krizová intervence: ${crisisResult.summary || "Detekována krize"}`,
        status: "open",
        messages: [{ therapist: "karel", content: meetingMessage, timestamp: now.toISOString() }],
        triggered_by: "karel",
      }).select("id").single();

      // ── STEP 8: Create crisis thread in did_threads ──
      const { data: crisisThread } = await sb.from("did_threads").insert({
        user_id: thread.user_id,
        part_name: thread.part_name,
        sub_mode: "crisis",
        thread_label: `🔴 KRIZOVÁ INTERVENCE – ${thread.part_name} – ${dateStr}`,
        thread_emoji: "🔴",
        messages: [{ role: "assistant", content: meetingMessage, timestamp: now.toISOString() }],
        last_activity_at: now.toISOString(),
        is_processed: false,
        theme_preset: "default",
      }).select("id").single();

      // Link meeting and thread to alert
      const updatePayload: any = {};
      if (crisisThread) updatePayload.crisis_thread_id = crisisThread.id;
      if (crisisMeeting) updatePayload.conversation_id = crisisMeeting.id;
      if (Object.keys(updatePayload).length > 0) {
        await sb.from("crisis_alerts").update(updatePayload).eq("id", newAlert!.id);
      }

      // ── STEP 9: Create session plan on dashboard ──
      try {
        await sb.from("did_daily_session_plans").insert({
          user_id: thread.user_id,
          plan_date: now.toISOString().split("T")[0],
          selected_part: thread.part_name,
          urgency_score: 100,
          urgency_breakdown: { crisis: 100 },
          plan_markdown: `# 🔴 KRIZOVÉ SEZENÍ – ${thread.part_name}\n\n**Cíl:** ${analysis.session_goal}\n\n## Plán telefonátu (Káťa)\n${analysis.kata_call_plan}\n\n## Plán večerního sezení (Hanička)\n${analysis.hanka_session_plan}\n\n## Karlův plán\n${analysis.karel_plan}`,
          plan_html: "",
          therapist: "kata",
          status: "generated",
          generated_by: "crisis-retroactive-scan",
          session_lead: "kata",
          session_format: "crisis_intervention",
          overdue_days: 0,
          part_tier: "crisis",
        });
      } catch (e) {
        console.warn(`[retro-scan] Session plan insert warning:`, e);
      }

      results.push({
        thread_id: thread.id,
        part_name: thread.part_name,
        crisis: true,
        severity: crisisResult.severity,
        alert_id: newAlert!.id,
        meeting_id: crisisMeeting?.id,
        summary: crisisResult.summary,
      });
    }

    const crisisCount = results.filter(r => r.crisis).length;
    console.log(`[retro-scan] Done. Scanned: ${threads.length}, Crises found: ${crisisCount}`);

    return new Response(JSON.stringify({ scanned: threads.length, crises: crisisCount, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[retro-scan] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function buildMeetingMessage(
  partName: string, crisis: any, analysis: any,
  signalsList: string, quotesBlock: string, totalMsgs: number, dateStr: string
): string {
  const kataQuestions = (analysis.kata_questions || [])
    .map((q: string, i: number) => `   ${i + 1}. ${q}`)
    .join("\n");
  const hankaQuestions = (analysis.hanka_questions || [])
    .map((q: string, i: number) => `   ${i + 1}. ${q}`)
    .join("\n");

  return `⚠️ KRIZOVÁ PORADA – ${partName} – ${dateStr}

Svolávám mimořádnou krizovou poradu. Situace je ${crisis.severity || "CRITICAL"}.

CO SE STALO:
${crisis.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

MOJE VYHODNOCENÍ:
${crisis.assessment || "Vyhodnocení není k dispozici."}

---

PŘÍMÉ CITACE Z ROZHOVORU S ${partName.toUpperCase()}:

${quotesBlock}

Na základě těchto výroků hodnotím situaci jako ${crisis.severity || "CRITICAL"}.

---

DOSAVADNÍ PRŮBĚH KOMUNIKACE S ${partName.toUpperCase()}:
${partName} kontaktoval/a Karla. Proběhlo ${totalMsgs} zpráv.
${crisis.summary || ""}

---

CÍL KRIZOVÉ INTERVENCE:
${analysis.session_goal || "Ověřit bezpečí a vytvořit plán ochrany."}

===================================================================

KÁŤO – TVŮJ ÚKOL: TELEFONÁT S ${partName.toUpperCase()}:

${analysis.kata_call_plan || "(plán nebyl vygenerován)"}

PO HOVORU IHNED napiš sem do porady odpovědi:
${kataQuestions}

===================================================================

HANIČKO – TVŮJ ÚKOL: VEČERNÍ SEZENÍ S ${partName.toUpperCase()}:

${analysis.hanka_session_plan || "(plán nebyl vygenerován)"}

PO SEZENÍ napiš sem do porady odpovědi:
${hankaQuestions}

===================================================================

KAREL (JÁ) – MŮJ PLÁN:
${analysis.karel_plan || "Koordinuji, sleduji vlákno, vyhodnocuji."}

---

SHRNUTÍ ÚKOLŮ:

KÁŤA:
☐ Zavolat ${partName} IHNED (postup viz výše)
☐ Napsat do porady výsledek hovoru
☐ Večer asistovat při sezení

HANIČKA:
☐ Večer provést sezení PODLE PLÁNU výše
☐ Napsat do porady odpovědi na otázky

KAREL (já):
☐ Sleduji vlákno s ${partName}, reaguji na jeho zprávy
☐ Po vašich odpovědích upřesním další postup

DEADLINE: Káťa volá TEĎKA. Sezení DNES VEČER.

Odpovězte mi sem do porady. Každá za sebe. TEĎKA.`;
}
