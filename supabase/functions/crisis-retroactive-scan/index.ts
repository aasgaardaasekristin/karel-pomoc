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
          title: `KRIZOVÁ INTERVENCE – ${thread.part_name}`,
          description: `Okamžitě kontaktovat ${thread.part_name}. ${result.summary || ""}`,
          assigned_to: "hanicka",
          priority: "CRITICAL",
        },
        {
          crisis_alert_id: newAlert!.id,
          title: `KRIZOVÁ INTERVENCE – podpora – ${thread.part_name}`,
          description: `Podpořit Haničku v krizové intervenci. ${result.summary || ""}`,
          assigned_to: "kata",
          priority: "CRITICAL",
        },
      ]);

      // Create crisis thread in did_threads
      const now = new Date();
      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
      const signalsList = (result.signals || []).map((s: string) => `  • ${s}`).join("\n");

      const karelMessage = `⚠️ KRIZOVÁ INTERVENCE – AKTIVOVÁNO (Retroaktivní detekce)

Část: ${thread.part_name}
Čas detekce: ${dateStr}
Úroveň rizika: ${result.severity || "HIGH"}

CO SE STALO:
${result.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

MOJE VYHODNOCENÍ:
${result.assessment || "Vyhodnocení není k dispozici."}

NAVRŽENÝ PLÁN OKAMŽITÉ INTERVENCE:
${result.intervention_plan || "Plán není k dispozici."}

---

Haničko, Káťo – tato krize byla detekována retroaktivním skenem.
Prosím zkontrolujte vlákno s ${thread.part_name} a přijměte opatření.`;

      const { data: crisisThread } = await sb.from("did_threads").insert({
        user_id: thread.user_id,
        part_name: thread.part_name,
        sub_mode: "crisis",
        thread_label: `🔴 KRIZOVÁ INTERVENCE – ${thread.part_name} – ${dateStr}`,
        thread_emoji: "🔴",
        messages: [{ role: "assistant", content: karelMessage, timestamp: now.toISOString() }],
        last_activity_at: now.toISOString(),
        is_processed: false,
        theme_preset: "default",
      }).select("id").single();

      if (crisisThread) {
        await sb.from("crisis_alerts")
          .update({ crisis_thread_id: crisisThread.id })
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
