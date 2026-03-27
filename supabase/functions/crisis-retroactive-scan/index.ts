import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Load all cast threads
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

      // Crisis detection via AI
      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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

      if (!resp.ok) {
        console.warn(`[retro-scan] AI call failed for thread ${thread.id}: ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const text = (data.choices?.[0]?.message?.content || "").trim();
      const cleanJson = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      let result: any;
      try {
        result = JSON.parse(cleanJson);
      } catch {
        console.warn(`[retro-scan] Parse failed for thread ${thread.id}`);
        continue;
      }

      if (result.crisis !== true) {
        console.log(`[retro-scan] Thread ${thread.id} (${thread.part_name}): no crisis`);
        results.push({ thread_id: thread.id, part_name: thread.part_name, crisis: false });
        continue;
      }

      console.log(`[retro-scan] 🚨 CRISIS in thread ${thread.id} (${thread.part_name}): ${result.severity}`);

      // Check if alert already exists for this part
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

      // Extract direct quotes from the client (user messages)
      const userMessages = msgs
        .filter((m: any) => m.role === "user")
        .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      const lastUserQuotes = userMessages.slice(-5);
      const quotesBlock = lastUserQuotes.length > 0
        ? lastUserQuotes.map((q: string) => `> ${q.slice(0, 300)}`).join("\n\n")
        : "> (žádné přímé citace k dispozici)";

      // Build the enhanced meeting message
      const now = new Date();
      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
      const signalsList = (result.signals || []).map((s: string) => `  • ${s}`).join("\n");
      const totalMsgs = msgs.length;

      const meetingKarelMessage = buildMeetingMessage(thread.part_name, result, signalsList, quotesBlock, totalMsgs, dateStr);

      // Insert crisis alert
      const { data: newAlert, error: alertErr } = await sb.from("crisis_alerts")
        .insert({
          part_name: thread.part_name,
          severity: result.severity || "HIGH",
          summary: result.summary || "Detekována krize (retroaktivní sken)",
          trigger_signals: result.signals || [],
          conversation_excerpts: excerpt.slice(0, 5000),
          karel_assessment: result.assessment || "",
          intervention_plan: result.intervention_plan || "",
          conversation_id: thread.id,
        })
        .select("id")
        .single();

      if (alertErr) {
        console.error(`[retro-scan] Alert insert error:`, alertErr.message);
        continue;
      }

      // Insert crisis tasks
      await sb.from("crisis_tasks").insert([
        {
          crisis_alert_id: newAlert!.id,
          title: `TELEFONÁT S ${thread.part_name.toUpperCase()} – krizová intervence`,
          description: `Zavolej IHNED. Postup: 1) Validace 2) Poslouchej 3) Bezpečí 4) Nabídni sezení. ${result.summary || ""}`,
          assigned_to: "kata",
          priority: "CRITICAL",
        },
        {
          crisis_alert_id: newAlert!.id,
          title: `PŘÍPRAVA KRIZOVÉHO SEZENÍ – ${thread.part_name}`,
          description: `Podklady do 17:00: historie, předchozí epizody, co fungovalo. ${result.summary || ""}`,
          assigned_to: "hanicka",
          priority: "CRITICAL",
        },
      ]);

      // Insert into did_therapist_tasks (visible on task board)
      await sb.from("did_therapist_tasks").insert([
        {
          user_id: thread.user_id,
          task: `⚠️ TELEFONÁT S ${thread.part_name.toUpperCase()} – krizová intervence`,
          detail_instruction: `KÁŤO – udělej TEĎKA tyto kroky:\n1. ZAVOLEJ ${thread.part_name} (pokud nezvedne → audio zpráva → text)\n2. První věta DOSLOVA: '${thread.part_name}, tady Káťa. Vím co se děje. Jsem tu pro tebe.'\n3. POSLOUCHEJ 2-3 minuty. Nepřerušuj. Říkej jen: 'Rozumím', 'Poslouchám tě'.\n4. Zeptej se: 'Jsi teď v bezpečí? Kde teď jsi?'\n5. Řekni: 'To co se děje není fér. Máš právo říct ne. A my ti s tím pomůžeme.'\n6. Nabídni: 'Dnes večer uděláme sezení – já, Karel a Hanička. Společně to vyřešíme. Souhlasíš?'\n7. PO HOVORU IHNED napiš do krizové porady:\n   - Zvedl/a telefon? (ano/ne)\n   - Jak reagoval/a? (klidný/rozrušený/plakal)\n   - Je v bezpečí? (ano/ne/nevím)\n   - Souhlasil/a se sezením? (ano/ne)`,
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
          task: `⚠️ PŘÍPRAVA KRIZOVÉHO SEZENÍ – ${thread.part_name}`,
          detail_instruction: `HANIČKO – připrav do 17:00 tyto podklady a napiš je do krizové porady:\n1. OTEVŘI ${thread.part_name} kartu a odpověz:\n   - Kdy proběhlo poslední sezení?\n   - Jaký byl stav na posledním sezení?\n   - Byly podobné krizové epizody? Jaké?\n2. PŘIPRAV strukturu večerního sezení:\n   - Úvodní check-in (5 min): Jak se cítí TEĎ\n   - Mapování situace (10 min): Co přesně se děje\n   - Hledání zdrojů (10 min): Kdo může pomoct\n   - Plán ochrany (10 min): Konkrétní kroky\n   - Závěr (5 min): Co udělá DNES večer\n3. NAPIŠ do krizové porady odpovědi a návrh struktury.`,
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
          task: `⚠️ VEČERNÍ KRIZOVÉ SEZENÍ S ${thread.part_name.toUpperCase()}`,
          detail_instruction: `KÁŤO – dnes večer proveď krizové sezení s ${thread.part_name}.\nStruktura sezení viz Haniččiny podklady v krizové poradě.\nBěhem sezení se zaměř na:\n- Aktuální bezpečí\n- Konkrétní plán (co udělá, kam půjde)\n- Kdo může pomoct (konkrétní osoby)\nPO SEZENÍ napiš do porady:\n- Jak sezení proběhlo\n- Aktuální stav\n- Na čem jste se dohodli\n- Co je další krok`,
          assigned_to: "kata",
          priority: "urgent",
          status: "pending",
          status_hanka: "not_started",
          status_kata: "not_started",
          task_tier: "operative",
          category: "today",
        },
      ]);

      // Create crisis meeting in did_meetings
      const { data: crisisMeeting } = await sb.from("did_meetings").insert({
        user_id: thread.user_id,
        topic: `🔴 KRIZOVÁ PORADA – ${thread.part_name} – ${dateStr}`,
        agenda: `Krizová intervence: ${result.summary || "Detekována krize"}`,
        status: "open",
        messages: [{ therapist: "karel", content: meetingKarelMessage, timestamp: now.toISOString() }],
        triggered_by: "karel",
      }).select("id").single();

      // Create crisis thread in did_threads (for chat reference)
      const { data: crisisThread } = await sb.from("did_threads").insert({
        user_id: thread.user_id,
        part_name: thread.part_name,
        sub_mode: "crisis",
        thread_label: `🔴 KRIZOVÁ INTERVENCE – ${thread.part_name} – ${dateStr}`,
        thread_emoji: "🔴",
        messages: [{ role: "assistant", content: meetingKarelMessage, timestamp: now.toISOString() }],
        last_activity_at: now.toISOString(),
        is_processed: false,
        theme_preset: "default",
      }).select("id").single();

      // Link meeting and thread to alert
      const updatePayload: any = {};
      if (crisisThread) updatePayload.crisis_thread_id = crisisThread.id;
      if (crisisMeeting) updatePayload.conversation_id = crisisMeeting.id;
      if (Object.keys(updatePayload).length > 0) {
        await sb.from("crisis_alerts")
          .update(updatePayload)
          .eq("id", newAlert!.id);
      }

      results.push({
        thread_id: thread.id,
        part_name: thread.part_name,
        crisis: true,
        severity: result.severity,
        alert_id: newAlert!.id,
        meeting_id: crisisMeeting?.id,
        summary: result.summary,
      });
    }

    const crisisCount = results.filter(r => r.crisis).length;
    console.log(`[retro-scan] Done. Scanned: ${threads.length}, Crises found: ${crisisCount}`);

    return new Response(JSON.stringify({
      scanned: threads.length,
      crises: crisisCount,
      results,
    }), {
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

function buildMeetingMessage(partName: string, result: any, signalsList: string, quotesBlock: string, totalMsgs: number, dateStr: string): string {
  return `⚠️ KRIZOVÁ PORADA – ${partName} – ${dateStr}

Svolávám mimořádnou krizovou poradu. Situace je ${result.severity || "CRITICAL"}.

CO SE STALO:
${result.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

MOJE VYHODNOCENÍ:
${result.assessment || "Vyhodnocení není k dispozici."}

---

PŘÍMÉ CITACE Z ROZHOVORU S ${partName.toUpperCase()}:

${quotesBlock}

Na základě těchto výroků hodnotím situaci jako ${result.severity || "CRITICAL"}.

---

DOSAVADNÍ PRŮBĚH KOMUNIKACE S ${partName.toUpperCase()}:
${partName} kontaktoval/a Karla. Proběhlo ${totalMsgs} zpráv.
${result.summary || ""}

---

MŮJ NÁVRH OKAMŽITÉHO POSTUPU:

1. PARALELNÍ KRIZOVÁ INTERVENCE (teď hned):

   KÁŤO – PŘESNÝ POSTUP PŘI KONTAKTU S ${partName.toUpperCase()}:

   Krok 1: Zavolej mu/jí. První věta DOSLOVA:
     '${partName}, tady je Káťa. Mluvila jsem s Karlem,
      vím co se děje. Jsem tu pro tebe.'

   Krok 2: Poslouchej. Nech ho/ji mluvit. NEPŘERUŠUJ.

   Krok 3: Zeptej se na bezpečí:
     'Jsi teď v bezpečí? Kde teď jsi?'

   Krok 4: Validuj emoce, NEZLEHČUJ:
     'Rozumím. To co popisuješ není fér. Máš právo se bránit.'

   Krok 5: Nabídni konkrétní krok:
     'Dnes odpoledne se sejdeme – já, Karel a Hanička.
      Společně to vyřešíme. Souhlasíš?'

   Krok 6: Po hovoru mi IHNED napiš sem do porady:
     - Jak ${partName} reagoval/a
     - Zda je v bezpečí
     - Co řekl/a o situaci
     - Zda souhlasil/a se sezením

2. KOORDINACE (Hanička):
   Haničko – potřebuji abys připravila podklady pro krizové sezení:
   - Historie ${partName}
   - Předchozí krizové epizody
   - Co fungovalo / nefungovalo v minulosti

3. ODPOLEDNÍ KRIZOVÉ SEZENÍ (plán):
   Sestavuji strukturu sezení. Zúčastníme se všichni tři + ${partName}.

---

Káťo, Haničko – potřebuji od vás OKAMŽITOU odpověď:
1. Kdo z vás může ${partName} kontaktovat TEĎ?
2. Máte na něj/ni kontakt?
3. Kdy jste s ním/ní naposledy komunikovaly?

Čekám na vaše odpovědi. Čas běží.

---

SHRNUTÍ ÚKOLŮ:

KÁŤA:
☐ Zavolat ${partName} IHNED (postup viz výše)
☐ Napsat do porady výsledek hovoru
☐ Večer provést krizové sezení

HANIČKA:
☐ Připravit podklady do 17:00 (viz úkoly)
☐ Napsat do porady historii a návrh struktury sezení

KAREL (já):
☐ Koordinuji, sleduji, vyhodnocuji
☐ Po vašich odpovědích upřesním plán sezení

DEADLINE: Káťa volá TEĎKA. Hanička podklady do 17:00.
Sezení DNES VEČER.

Odpovězte mi sem do porady. Každá za sebe. TEĎKA.`;
}
