/**
 * karel-daily-thread-sorter
 *
 * Denní třídicí pass: načte vlákna za 24h z did_threads (mamka/kata)
 * a karel_hana_conversations (hana_personal), AI je roztřídí do bloků
 * a výsledky zapíše přímo do did_pending_drive_writes.
 * Po zpracování vlákno zamkne (is_locked + archive_status).
 *
 * Cílové Drive dokumenty (fáze 1):
 *   PAMET_KAREL/DID/HANKA/{SITUACNI_ANALYZA, KARLOVY_POZNATKY, KAREL}
 *   PAMET_KAREL/DID/KATA/{SITUACNI_ANALYZA, KARLOVY_POZNATKY, KAREL}
 *   PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO
 *   KARTA_{CAST}
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VALID_TARGETS = [
  "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/HANKA/KAREL",
  "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/KATA/KAREL",
  "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
];

const SORTING_SYSTEM_PROMPT = `Jsi Karel – supervizor a analytik DID terapeutického systému.

Dostaneš konverzační vlákno (zprávy mezi uživatelem a Karlem).
Tvůj úkol: vytěžit klíčové informace a roztřídit je do bloků podle cílového dokumentu.

Každý blok musí mít:
- "target": cílový dokument (viz seznam níže)
- "content": stručný, konkrétní text (co zapsat do dokumentu)
- "reasoning": proč to patří sem (1 věta)

CÍLOVÉ DOKUMENTY:

1. PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA
   → aktuální životní situace Hanky (práce, vztahy, bydlení, finance, zdraví)

2. PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY
   → Karlovy postřehy o Hance (motivace, spolehlivost, vzorce chování, emoční stav)

3. PAMET_KAREL/DID/HANKA/KAREL
   → co Hanka říká přímo o Karlovi, jak ho vnímá, co od něj chce

4. PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA
   → aktuální situace Káti (terapeutka)

5. PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY
   → Karlovy postřehy o Kátě (spolehlivost, přístup k terapii, silné/slabé stránky)

6. PAMET_KAREL/DID/KATA/KAREL
   → co Káťa říká o Karlovi

7. PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO
   → nové osoby, místa, instituce zmíněné v konverzaci (kdo je kdo v životě systému)

8. KARTA_{JMENO_CASTI}
   → klinické informace o konkrétní DID části (switching, emoce, symptomy, vztahy)
   → nahraď {JMENO_CASTI} skutečným jménem části VELKÝMI PÍSMENY (např. KARTA_GUSTIK)

PRAVIDLA:
- Vytěžuj POUZE konkrétní, nové, užitečné informace
- Ignoruj small talk, pozdravy, opakování
- Pokud vlákno neobsahuje nic užitečného, vrať prázdné pole
- Nikdy nevymýšlej informace, které v konverzaci nejsou
- Každý blok musí mít jasný, stručný content (max 200 slov)
- Content piš ve formátu vhodném pro append do textového souboru (datumy, odrážky)

Odpověz POUZE validním JSON:
{ "blocks": [ { "target": "...", "content": "...", "reasoning": "..." } ] }

Pokud není co vytěžit:
{ "blocks": [] }`;

// ─── Types ───────────────────────────────────────────────────────────

interface ThreadRecord {
  id: string;
  messages: { role: string; content: string }[];
  sourceTable: "did_threads" | "karel_hana_conversations";
  subMode: string;
  label: string;
}

interface SortedBlock {
  target: string;
  content: string;
  reasoning: string;
}

// ─── Main ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startMs = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const apiKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const log: string[] = [];
  const addLog = (msg: string) => {
    console.log(`[thread-sorter] ${msg}`);
    log.push(msg);
  };

  try {
    // ── 1. Fetch recent threads ──────────────────────────────────────

    // did_threads: mamka + kata sub_modes
    const { data: didThreads, error: e1 } = await supabase
      .from("did_threads")
      .select("id, messages, sub_mode, thread_label, entered_name, is_locked")
      .in("sub_mode", ["mamka", "kata"])
      .eq("is_locked", false)
      .gte("last_activity_at", since)
      .order("last_activity_at", { ascending: false })
      .limit(15);

    if (e1) addLog(`did_threads fetch error: ${e1.message}`);

    // karel_hana_conversations: personal threads
    const { data: hanaThreads, error: e2 } = await supabase
      .from("karel_hana_conversations")
      .select("id, messages, sub_mode, thread_label, is_locked")
      .eq("is_locked", false)
      .gte("last_activity_at", since)
      .order("last_activity_at", { ascending: false })
      .limit(15);

    if (e2) addLog(`hana_conversations fetch error: ${e2.message}`);

    // Normalize into unified list
    const threads: ThreadRecord[] = [];

    for (const t of didThreads ?? []) {
      const msgs = Array.isArray(t.messages) ? t.messages as { role: string; content: string }[] : [];
      if (msgs.filter((m) => m.role === "user").length < 2) continue;
      threads.push({
        id: t.id,
        messages: msgs,
        sourceTable: "did_threads",
        subMode: t.sub_mode ?? "unknown",
        label: t.thread_label || t.entered_name || "bez názvu",
      });
    }

    for (const t of hanaThreads ?? []) {
      const msgs = Array.isArray(t.messages) ? t.messages as { role: string; content: string }[] : [];
      if (msgs.filter((m) => m.role === "user").length < 2) continue;
      threads.push({
        id: t.id,
        messages: msgs,
        sourceTable: "karel_hana_conversations",
        subMode: t.sub_mode || "hana_personal",
        label: t.thread_label || "bez názvu",
      });
    }

    addLog(`Found ${threads.length} unlocked threads with >=2 user messages (since ${since})`);

    if (threads.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, threads: 0, writes: 0, log }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Process each thread ───────────────────────────────────────

    let totalWrites = 0;
    let totalLocked = 0;
    const dateLabel = now.toISOString().slice(0, 10);

    for (const thread of threads) {
      // Trim messages for context window (last 60 messages max)
      const trimmed = thread.messages.slice(-60);
      const transcript = trimmed
        .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 800)}`)
        .join("\n");

      if (transcript.length < 50) {
        addLog(`Skip thread ${thread.id} (too short)`);
        continue;
      }

      const userPrompt = `Zdrojové vlákno: "${thread.label}" (typ: ${thread.subMode})
Datum: ${dateLabel}

--- KONVERZACE ---
${transcript}
--- KONEC ---

Roztřiď obsah do bloků. Pokud vlákno neobsahuje nic nového nebo užitečného, vrať { "blocks": [] }.`;

      const result = await callAiForJson<{ blocks: SortedBlock[] }>({
        systemPrompt: SORTING_SYSTEM_PROMPT,
        userPrompt,
        model: "google/gemini-2.5-flash",
        apiKey,
        requiredKeys: ["blocks"],
        maxRetries: 1,
        fallback: { blocks: [] },
        callerName: "thread-sorter",
      });

      const blocks = result.data?.blocks ?? [];
      addLog(`Thread ${thread.id} ("${thread.label}"): ${blocks.length} blocks extracted`);

      if (blocks.length === 0) {
        // Still lock it — already processed, nothing to write
        await lockThread(supabase, thread, now);
        totalLocked++;
        continue;
      }

      // ── 3. Validate and write blocks ─────────────────────────────

      const validBlocks = blocks.filter((b) => {
        if (!b.target || !b.content || b.content.length < 10) return false;
        // Accept VALID_TARGETS or KARTA_* pattern
        if (VALID_TARGETS.includes(b.target)) return true;
        if (/^KARTA_[A-Z_]+$/.test(b.target)) return true;
        addLog(`  Rejected block with invalid target: ${b.target}`);
        return false;
      });

      if (validBlocks.length === 0) {
        await lockThread(supabase, thread, now);
        totalLocked++;
        continue;
      }

      // Insert into did_pending_drive_writes
      const rows = validBlocks.map((b) => ({
        target_document: b.target,
        content: `\n\n--- ${dateLabel} | zdroj: ${thread.subMode}/${thread.label} ---\n${b.content}`,
        write_type: "append",
        priority: "normal",
        status: "pending",
        user_id: "00000000-0000-0000-0000-000000000000",
      }));

      const { error: writeErr } = await supabase
        .from("did_pending_drive_writes")
        .insert(rows);

      if (writeErr) {
        addLog(`  Write error for thread ${thread.id}: ${writeErr.message}`);
        continue;
      }

      totalWrites += validBlocks.length;
      addLog(`  → ${validBlocks.length} pending writes created`);

      // Lock the thread
      await lockThread(supabase, thread, now);
      totalLocked++;
    }

    const elapsed = Date.now() - startMs;
    addLog(`Done in ${elapsed}ms: ${totalWrites} writes, ${totalLocked} threads locked`);

    return new Response(
      JSON.stringify({
        ok: true,
        threads: threads.length,
        writes: totalWrites,
        locked: totalLocked,
        elapsed_ms: elapsed,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`Fatal error: ${msg}`);
    return new Response(
      JSON.stringify({ ok: false, error: msg, log }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function lockThread(
  supabase: ReturnType<typeof createClient>,
  thread: ThreadRecord,
  now: Date,
) {
  const lockData = {
    is_locked: true,
    locked_at: now.toISOString(),
    archive_status: "locked",
  };

  const { error } = await supabase
    .from(thread.sourceTable)
    .update(lockData)
    .eq("id", thread.id);

  if (error) {
    console.warn(`[thread-sorter] Lock failed for ${thread.id}: ${error.message}`);
  }
}
