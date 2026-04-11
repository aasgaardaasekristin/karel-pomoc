import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-daily-therapist-intelligence
 * 
 * Lehká denní funkce: generuje AKČNÍ INTELIGENCI a KARLOVY DEDUKCE
 * pro Haničku a Káťu. Zapisuje POUZE do did_pending_drive_writes.
 * Žádné Drive/OAuth helpery — vše jde přes queue processor.
 */

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";

interface TherapistDef {
  key: string;
  name: string;
  role: string;
  subModes: string[];
  sitTarget: string;
  pozTarget: string;
}

const THERAPISTS: TherapistDef[] = [
  {
    key: "hanka",
    name: "Hanička",
    role: "partnerka a vedoucí terapeutka. Karel k ní mluví s láskou, intimitou a respektem.",
    subModes: ["mamka", "hana_personal"],
    sitTarget: "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA",
    pozTarget: "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY",
  },
  {
    key: "kata",
    name: "Káťa",
    role: "mentorovaná terapeutka. Karel je její vedoucí a mentor — profesionálně, vřele, s jasnou strukturou.",
    subModes: ["kata"],
    sitTarget: "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA",
    pozTarget: "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY",
  },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Stable owner: resolve from did_part_registry (DID system owner)
  const { data: registryOwner } = await sb.from("did_part_registry")
    .select("user_id").limit(1).single();
  const ownerId = registryOwner?.user_id || null;

  const today = new Date().toISOString().slice(0, 10);
  const akcniMarker = `=== AKČNÍ INTELIGENCE ${today} ===`;
  const dedukceMarker = `=== KARLOVY DEDUKCE ${today} ===`;
  const startTime = Date.now();
  const results: Record<string, { ok: boolean; skipped?: boolean; error?: string }> = {};

  try {
    // ── Shared data fetch (7 days) ──
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [threadsRes, convsRes, hanaRes, tasksRes, crisisRes] = await Promise.all([
      sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode")
        .gte("last_activity_at", cutoff).order("last_activity_at", { ascending: false }).limit(30),
      sb.from("did_conversations").select("id, label, sub_mode, messages, updated_at")
        .gte("updated_at", cutoff).order("updated_at", { ascending: false }).limit(20),
      sb.from("karel_hana_conversations").select("id, messages, current_domain, last_activity_at")
        .gte("last_activity_at", cutoff).order("last_activity_at", { ascending: false }).limit(15),
      sb.from("did_therapist_tasks").select("id, title, status, assigned_to, created_at")
        .in("status", ["pending", "in_progress"]).order("created_at", { ascending: false }).limit(30),
      sb.from("crisis_alerts").select("part_name, severity, summary, status")
        .in("status", ["open", "monitoring"]).limit(10),
    ]);

    const threads = threadsRes.data || [];
    const convs = convsRes.data || [];
    const hanaConvs = hanaRes.data || [];
    const tasks = tasksRes.data || [];
    const crises = crisisRes.data || [];

    for (const t of THERAPISTS) {
      try {
        // ── Dedup: check if today's writes already exist ──
        // Dedup: check each target against its OWN marker
        const [sitCheck, pozCheck] = await Promise.all([
          sb.from("did_pending_drive_writes")
            .select("id")
            .eq("target_document", t.sitTarget)
            .gte("created_at", `${today}T00:00:00Z`)
            .ilike("content", `%${akcniMarker}%`)
            .limit(1),
          sb.from("did_pending_drive_writes")
            .select("id")
            .eq("target_document", t.pozTarget)
            .gte("created_at", `${today}T00:00:00Z`)
            .ilike("content", `%${dedukceMarker}%`)
            .limit(1),
        ]);

        const existingSit = (sitCheck.data?.length ?? 0) > 0;
        const existingPoz = (pozCheck.data?.length ?? 0) > 0;
        if (existingSit && existingPoz) {
          console.log(`[therapist-intel] ${t.key}: already has today's writes, skipping`);
          results[t.key] = { ok: true, skipped: true };
          continue;
        }

        // ── Build thread digest ──
        const relevantThreads = threads.filter(th => t.subModes.includes(th.sub_mode)).slice(0, 10);
        const relevantConvs = convs.filter(c => t.subModes.includes(c.sub_mode)).slice(0, 8);
        const relevantHana = t.key === "hanka" ? hanaConvs.slice(0, 8) : [];

        const digest = [...relevantThreads, ...relevantConvs, ...relevantHana]
          .map((item: any) => {
            const msgs = Array.isArray(item.messages) ? item.messages : [];
            const last = msgs.slice(-6).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 200)}`);
            return `--- ${item.part_name || item.label || item.current_domain || "?"} ---\n${last.join("\n")}`;
          })
          .join("\n\n")
          .slice(0, 5000);

        const taskDigest = tasks
          .filter((tk: any) => (tk.assigned_to || "").toLowerCase().includes(t.key))
          .map((tk: any) => `- [${tk.status}] ${tk.title}`)
          .join("\n") || "(žádné)";

        const crisisDigest = crises
          .map((c: any) => `⚠️ ${c.part_name}: ${c.severity} — ${c.summary?.slice(0, 100)}`)
          .join("\n") || "(žádné)";

        // ── AI call ──
        const prompt = `Dnes: ${today}. Terapeutka: ${t.name} (${t.role}).

Vygeneruj DVĚ sekce. Odděl je značkou <<<SPLIT>>>.

SEKCE 1 — začni PŘESNĚ:
${akcniMarker}
A) CO OD KARLA DNES POTŘEBUJE: (1-3 body, konkrétní)
B) JAK MÁ KAREL DNES MLUVIT: (1-2 body — tón, tempo)
C) CO DNES NEDĚLAT: (1-2 body)
D) NA CO SI DÁT POZOR: (1 bod)

<<<SPLIT>>>

SEKCE 2 — začni PŘESNĚ:
${dedukceMarker}
- Vzorec: (1-2 věty)
- Pod povrchem: (1-2 věty — dedukce, ne popis)
- Pozor: (1 věta)

PRAVIDLA: Piš VÝHRADNĚ z dat. Žádné fráze. Stručně, analyticky.

═══ DATA ═══
Konverzace (7 dní):
${digest || "(žádné)"}

Úkoly:
${taskDigest}

Krize:
${crisisDigest}`;

        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              { role: "system", content: "Jsi Karel, kognitivní agent DID týmu. Piš česky, stručně. Nikdy nevymýšlej." },
              { role: "user", content: prompt },
            ],
            temperature: 0.2,
          }),
        });

        if (!aiRes.ok) {
          results[t.key] = { ok: false, error: `AI ${aiRes.status}` };
          await aiRes.text();
          continue;
        }

        const aiData = await aiRes.json();
        const output = aiData.choices?.[0]?.message?.content || "";
        if (!output) { results[t.key] = { ok: false, error: "Empty AI" }; continue; }

        // ── Parse output ──
        let akcniBlock: string;
        let dedukceBlock: string;

        if (output.includes("<<<SPLIT>>>")) {
          const [a, d] = output.split("<<<SPLIT>>>");
          akcniBlock = a.trim();
          dedukceBlock = (d || "").trim();
        } else {
          const idx = output.indexOf("=== KARLOVY DEDUKCE");
          if (idx > 0) {
            akcniBlock = output.slice(0, idx).trim();
            dedukceBlock = output.slice(idx).trim();
          } else {
            akcniBlock = output.trim();
            dedukceBlock = "";
          }
        }

        // Ensure markers
        if (!akcniBlock.includes("AKČNÍ INTELIGENCE")) akcniBlock = `${akcniMarker}\n${akcniBlock}`;
        if (dedukceBlock && !dedukceBlock.includes("KARLOVY DEDUKCE")) dedukceBlock = `${dedukceMarker}\n${dedukceBlock}`;

        // ── Insert pending writes (skip if already exists for that target) ──
        const writes: Array<{ target_document: string; content: string }> = [];
        if (!existingSit && akcniBlock) writes.push({ target_document: t.sitTarget, content: akcniBlock });
        if (!existingPoz && dedukceBlock) writes.push({ target_document: t.pozTarget, content: dedukceBlock });

        if (writes.length > 0) {
          await sb.from("did_pending_drive_writes").insert(
            writes.map(w => ({
              target_document: w.target_document,
              content: w.content,
              write_type: "append",
              priority: "normal",
              status: "pending",
              user_id: ownerId,
            }))
          );
          console.log(`[therapist-intel] ${t.key}: inserted ${writes.length} pending writes`);
        }

        results[t.key] = { ok: true };
      } catch (tErr) {
        const msg = tErr instanceof Error ? tErr.message : String(tErr);
        console.error(`[therapist-intel] ${t.key} error:`, msg);
        results[t.key] = { ok: false, error: msg };
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[therapist-intel] Done in ${elapsed}ms:`, JSON.stringify(results));

    await sb.from("system_health_log").insert({
      event_type: "daily_therapist_intelligence",
      severity: "info",
      source: "karel-daily-therapist-intelligence",
      details: { results, elapsed_ms: elapsed, date: today },
    });

    return new Response(JSON.stringify({ ok: true, results, elapsed_ms: elapsed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[therapist-intel] Fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
