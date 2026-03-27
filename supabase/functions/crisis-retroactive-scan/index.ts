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
          title: `KRIZOVÁ INTERVENCE – kontaktovat ${thread.part_name} IHNED`,
          description: `Telefonát/audio/chat. Ověřit bezpečí. ${result.summary || ""}`,
          assigned_to: "kata",
          priority: "CRITICAL",
        },
        {
          crisis_alert_id: newAlert!.id,
          title: `PŘÍPRAVA KRIZOVÉHO SEZENÍ – ${thread.part_name}`,
          description: `Podklady, historie, předchozí epizody. ${result.summary || ""}`,
          assigned_to: "hanicka",
          priority: "CRITICAL",
        },
      ]);

      // Insert into did_therapist_tasks (visible on task board)
      await sb.from("did_therapist_tasks").insert([
        {
          user_id: thread.user_id,
          task: `⚠️ KRIZOVÁ INTERVENCE – kontaktovat ${thread.part_name} IHNED`,
          detail_instruction: `Telefonát/audio/chat. Ověřit bezpečí. Začni validací: '${thread.part_name}, vím co se děje. Jsem tu.' Řeš BEZPEČÍ, ne příčinu. ${result.summary || ""}`,
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
          task: `⚠️ PŘÍPRAVA KRIZOVÉHO SEZENÍ – podklady o ${thread.part_name}`,
          detail_instruction: `Připravit: historii, předchozí krizové epizody, co fungovalo/nefungovalo. ${result.summary || ""}`,
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
          task: `⚠️ KOORDINACE KRIZOVÉ INTERVENCE – ${thread.part_name}`,
          detail_instruction: `Sledovat průběh intervence, ptát se terapeutek na stav, sestavit plán odpoledního sezení.`,
          assigned_to: "both",
          priority: "urgent",
          status: "pending",
          status_hanka: "not_started",
          status_kata: "not_started",
          task_tier: "operative",
          category: "today",
        },
      ]);

      // Create crisis meeting in did_meetings
      const now = new Date();
      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
      const signalsList = (result.signals || []).map((s: string) => `  • ${s}`).join("\n");

      const meetingKarelMessage = `⚠️ KRIZOVÁ PORADA – ${thread.part_name} – ${dateStr}

Svolávám mimořádnou krizovou poradu. Situace je ${result.severity || "CRITICAL"}.

CO SE STALO:
${result.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

MOJE VYHODNOCENÍ:
${result.assessment || "Vyhodnocení není k dispozici."}

---

MŮJ NÁVRH OKAMŽITÉHO POSTUPU:

1. PARALELNÍ KRIZOVÁ INTERVENCE (teď hned):
   Káťo – potřebuji, abys IHNED kontaktovala ${thread.part_name}.
   Doporučuji tyto kanály v tomto pořadí:
   a) Telefonát (nejefektivnější pro krizovou intervenci)
   b) Audio zpráva přes chat (pokud telefon nezvedá)
   c) Textová zpráva s jasným vzkazem že jsme tu pro něj/ni

   Při kontaktu s ${thread.part_name}:
   - Začni validací: '${thread.part_name}, vím co se děje. Jsem tu.'
   - Neřeš příčinu, řeš BEZPEČÍ: 'Jsi teď v bezpečí?'
   - Nabídni konkrétní pomoc, ne obecnou

2. KOORDINACE (Hanička):
   Haničko – potřebuji abys připravila podklady pro krizové sezení:
   - Historie ${thread.part_name}
   - Předchozí krizové epizody
   - Co fungovalo / nefungovalo v minulosti

3. ODPOLEDNÍ KRIZOVÉ SEZENÍ (plán):
   Sestavuji strukturu sezení. Zúčastníme se všichni tři + ${thread.part_name}.

---

Káťo, Haničko – potřebuji od vás OKAMŽITOU odpověď:
1. Kdo z vás může ${thread.part_name} kontaktovat TEĎ?
2. Máte na něj/ni kontakt?
3. Kdy jste s ním/ní naposledy komunikovaly?

Čekám na vaše odpovědi. Čas běží.`;

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
