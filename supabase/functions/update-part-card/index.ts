import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, listFiles, findFolder, resolveKartotekaRoot,
  readFileContent, overwriteDoc, appendToDoc, createBackup,
  findCardFileInFolder, moveFile, findFileByName,
  FOLDER_MIME, GDOC_MIME,
} from "../_shared/driveHelpers.ts";

/**
 * update-part-card: Autonomous 3-phase card update
 * Phase 1: AI Analysis (Gemini reads card + threads → structured JSON)
 * Phase 2: Web Search (Perplexity for new therapy methods)
 * Phase 3: AI Write (Gemini produces updated card)
 */

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function callGemini(systemPrompt: string, userPrompt: string, timeout = 120000): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query: string): Promise<string> {
  const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  if (!PERPLEXITY_API_KEY) {
    // Fallback: use Gemini for search-like queries
    return await callGemini(
      "Jsi výzkumný asistent. Najdi a shrň relevantní terapeutické techniky.",
      `Hledej informace o: ${query}\nShrň v 3-5 větách česky.`,
      15000,
    );
  }

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
      }),
    });
    if (!res.ok) return `Search failed: ${res.status}`;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    return `Search error: ${e}`;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__";
  let userId = "00000000-0000-0000-0000-000000000000";
  if (authHeader !== `Bearer ${srvKey}`) {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
    userId = (auth as any).user?.id || userId;
  }

  const startTime = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const { partName, folderId, threadContents, forceFullUpdate } = await req.json();
    if (!partName || !folderId) {
      return new Response(JSON.stringify({ error: "partName and folderId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const threads = threadContents || [];
    if (threads.length === 0 && !forceFullUpdate) {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "no threads" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[update-card] Starting for ${partName}, ${threads.length} threads`);
    const token = await getAccessToken();

    // 1. Find and read card
    const cardFile = await findCardFileInFolder(token, folderId);
    if (!cardFile) {
      return new Response(JSON.stringify({ error: `No card in folder ${partName}` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cardContent = await readFileContent(token, cardFile.id, cardFile.mimeType);
    console.log(`[update-card] Card read: ${cardFile.name}, ${cardContent.length} chars`);

    // 2. Format thread contents
    const threadsText = threads.map((t: any) => {
      const msgs = (t.messages || []).map((m: any) =>
        `[${m.role}${m.timestamp ? ` ${m.timestamp}` : ""}]: ${m.content}`
      ).join("\n");
      return `--- Vlákno ${t.threadId} ---\n${msgs}`;
    }).join("\n\n");

    // Filter already processed threads
    if (!forceFullUpdate && threads.length > 0) {
      const threadIds = threads.map((t: any) => t.threadId);
      const { data: processed } = await sb.from("card_update_processed_threads")
        .select("thread_id")
        .eq("part_name", partName)
        .in("thread_id", threadIds);
      const processedSet = new Set((processed || []).map(p => p.thread_id));
      const newThreads = threads.filter((t: any) => !processedSet.has(t.threadId));
      if (newThreads.length === 0) {
        console.log(`[update-card] All threads already processed for ${partName}`);
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "all_processed" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ═══ LOAD SESSION MEMORY for richer analysis ═══
    let memoryText = "";
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: recentMemory } = await sb.from("session_memory")
        .select("*")
        .eq("part_name", partName)
        .gte("session_date", weekAgo)
        .order("session_date", { ascending: false });

      if (recentMemory?.length) {
        memoryText = recentMemory.map((m: any) =>
          `[${new Date(m.session_date).toLocaleDateString("cs")}] ` +
          `Emoce: ${m.emotional_state || "?"}\n` +
          `Body: ${(m.key_points || []).join("; ")}\n` +
          `Nedořešené: ${(m.unresolved || []).join("; ")}\n` +
          `Rizika: ${(m.risk_signals || []).join("; ")}`
        ).join("\n\n");
        console.log(`[update-card] Session memory loaded: ${recentMemory.length} entries for ${partName}`);
      }
    } catch (memErr) {
      console.warn("[update-card] Session memory load error (non-fatal):", memErr);
    }

    // ═══ LOAD THERAPIST NOTES for richer analysis ═══
    let therapistNotesText = "";
    try {
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const { data: tNotes } = await sb.from("therapist_notes")
        .select("author, note_type, note_text, priority, session_date")
        .or(`part_name.eq.${partName},part_name.is.null`)
        .gte("session_date", twoWeeksAgo)
        .order("created_at", { ascending: false })
        .limit(20);

      if (tNotes?.length) {
        therapistNotesText = tNotes.map((n: any) =>
          `[${n.note_type.toUpperCase()}] (${n.author}, ${n.session_date}): ${n.note_text}`
        ).join("\n");
        console.log(`[update-card] Therapist notes loaded: ${tNotes.length} for ${partName}`);
      }
    } catch (tnErr) {
      console.warn("[update-card] Therapist notes load error (non-fatal):", tnErr);
    }
    console.log(`[update-card] Phase 1: Analysis for ${partName}`);
    const analysisPrompt = `Jsi Karel — klinický psycholog specializovaný na DID, správce kartotéky. Dostáváš:
1. Aktuální kartu části "${partName}" z kartotéky
2. Nová nezpracovaná vlákna (rozhovory s touto částí)
${memoryText ? "3. Strukturovanou paměť ze sezení za poslední týden" : ""}

TVŮ ÚKOL — FÁZE ANALÝZY:
Přečti vlákna a roztřiď informace podle sekcí A–M.
Pro KAŽDOU sekci uveď:
- Jaké NOVÉ informace vlákno přináší
- Jaké ROZPORY existují mezi vláknem a kartou
- Co je třeba PŘIDAT, NAHRADIT nebo ANOTOVAT
- Pokud sekce nevyžaduje změnu, napiš "BEZ ZMĚNY"

SPECIÁLNÍ INSTRUKCE:
SEKCE A (Kdo jsem):
a) Aktuální stav: vyměň datum + rozpoložení z vlákna
b) Povědomí o systému: nové skutečnosti o roli/konfliktu?
c) Vztahy + Co uklidňuje: nové info? ROZPOR s existujícím? Rozpor = NEMAŽ staré, přidej datovanou poznámku s dedukcí příčiny
d) Ochranné mechanismy: nový? Rozpor u existujícího?

SEKCE B (Charakter):
a) Aktuální stav: odstraň 3 nejstarší body, přidej 3 nové
b) Psychologické charakteristiky: zhodnoť % shody s vláknem, nahraď nejslabší tvrzení
c) PSYCHOLOGICKÁ PROFILACE (POVINNÁ!):
   Pokud chybí → vytvoř kompletní profil: typ osobnosti, potřeby, motivace, zájmy, silné/slabé stránky, obranné já, talent, vhodná profese, co potřebuje od okolí, čeho se vyvarovat, jak podporovat vývoj, jak zmírnit trauma, jak jednat/mluvit, vhodné terapeutické přístupy, aktivity pro stabilizaci, emoční typ, emoční IQ, odhadované IQ, osobnostní typ, archetypy
   Pokud existuje → zhodnoť % shody s vláknem, oprav/doplň k 100%
d) Obranné mechanismy + Reakce na kontakt: stejný postup

SEKCE C (Potřeby, strachy, konflikty):
- Jádrové potřeby: nahraď nejméně odpovídající bod
- Jádrové strachy: nový strach přidej, ústup strachu anotuj (nemaž)
- Triggery, konflikty, rizika: stejný postup

SEKCE D (Terapeutická doporučení):
- Zhodnoť zda stávající doporučení odpovídají aktuálnímu projevu
- Navrhni MINIMÁLNĚ 1 doporučení k nahrazení
- Navrhni KONKRÉTNÍ web search queries pro hledání nových technik (formát: SEARCH: "query text")

SEKCE E (Chronologický log): Nový řádek: datum | událost | výsledek
SEKCE F (Poznámky pro Karla): Zastaralé věty → označ k odstranění. Rozpory → označ s příčinou
SEKCE G (Deník): POUZE pokud si část VÝSLOVNĚ přála zapsat do deníku
SEKCE H (Dlouhodobé cíle): Cíl dosažen? → označ. Nový cíl? → navrhni
SEKCE I (Terapeutické metody): Proveď PSYCHOANALYTICKÝ ROZBOR vlákna. Pro každý identifikovaný prvek navrhni web search query (SEARCH: "query"). Navrhni strukturu nové metody: NÁZEV, CÍL, POSTUP, POMŮCKY, PROČ FUNGUJE, VHODNÝ TERAPEUT, HORIZONT
SEKCE J (Krátkodobé cíle): Porovnej 3 priority s vláknem. Aktualizuj intervence
SEKCE K (Výstupy): POUZE při signifikantním jevu
SEKCE L (Aktivita): Odstraň nejstarší, přidej nový záznam
SEKCE M (Karlova poznámka): Rozpor s existujícími → oprav. Max 3 poznámky (rolling window)

FORMÁT VÝSTUPU (JSON):
{
  "sections": {
    "A": { "changes": true/false, "analysis": "popis", "contradictions": [], "new_info": [] },
    "B": { ... }, ...
  },
  "search_queries": ["query1", "query2"],
  "diary_entry": "text nebo null",
  "status_change": "active|sleeping|null",
  "cross_writes": [
    { "target": "05A_Operativni_Plan", "action": "add_session", "content": "popis" }
  ]
}

KARTA:
${cardContent.slice(0, 80000)}

VLÁKNA:
${threadsText.slice(0, 40000)}
${memoryText ? `\nSTRUKTUROVANÁ PAMĚŤ ZE SEZENÍ (posledních 7 dní):\n${memoryText.slice(0, 10000)}` : ""}`;

    const analysisRaw = await callGemini(
      "Jsi Karel, klinický psycholog a odborník na DID. Analyzuj kartu a vlákna. Odpověz POUZE JSON.",
      analysisPrompt,
    );

    // Parse analysis JSON
    let analysis: any = {};
    try {
      const jsonMatch = analysisRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn(`[update-card] Analysis parse error:`, e);
      analysis = { sections: {}, search_queries: [], cross_writes: [] };
    }

    const searchQueries: string[] = analysis.search_queries || [];
    const crossWrites: any[] = analysis.cross_writes || [];
    const sectionsWithChanges = Object.entries(analysis.sections || {})
      .filter(([_, v]: [string, any]) => v?.changes)
      .map(([k]) => k);

    console.log(`[update-card] Analysis: ${sectionsWithChanges.length} sections changed, ${searchQueries.length} searches, ${crossWrites.length} cross-writes`);

    // ═══ PHASE 2: WEB SEARCH ═══
    const searchResults: Record<string, string> = {};
    const maxSearches = Math.min(searchQueries.length, 3);
    for (let i = 0; i < maxSearches; i++) {
      console.log(`[update-card] Phase 2: Search ${i + 1}/${maxSearches}: ${searchQueries[i]}`);
      try {
        searchResults[searchQueries[i]] = await webSearch(searchQueries[i]);
      } catch (e) {
        searchResults[searchQueries[i]] = `Error: ${e}`;
      }
    }

    const searchResultsText = Object.entries(searchResults)
      .map(([q, r]) => `Query: ${q}\nResult: ${r}`)
      .join("\n\n") || "(žádné web searchě nebyly provedeny)";

    // ═══ PHASE 3: WRITE ═══
    console.log(`[update-card] Phase 3: Writing updated card for ${partName}`);
    const writePrompt = `Jsi Karel — klinický psycholog. Dostáváš:
1. Aktuální kartu části
2. Výsledek analýzy z Fáze 1 (JSON)
3. Výsledky web searchů (pokud byly)

TVŮ ÚKOL:
Vrať KOMPLETNÍ AKTUALIZOVANOU KARTU jako plain text.

PRAVIDLA:
- Zachovej strukturu sekcí A–M
- Aplikuj VŠECHNY změny z analýzy
- Pro sekci D a I: využij výsledky web searchů k obohacení doporučení a metod
- NOVÝ formát metody v sekci I: NÁZEV / CÍL / POSTUP / POMŮCKY / PROČ FUNGUJE / VHODNÝ TERAPEUT / HORIZONT
- Piš česky, klinickým ale srozumitelným stylem
- U dětských částí přizpůsob jazyk deníku (G) věku
- ŽÁDNÉ [KHASH:], [SRC:], testovací data
- ŽÁDNÉ duplicity
- Každá informace na JEDNOM místě

Na konec přidej:

---UPDATE LOG---
Sekce aktualizovány: [seznam]
Sekce beze změny: [seznam]
Rozpory nalezeny: [počet]
Nové metody přidány: [počet]
Web search použit: [počet]×
Profilace aktualizována: ano/ne
---END UPDATE LOG---

KARTA:
${cardContent.slice(0, 80000)}

ANALÝZA:
${analysisRaw.slice(0, 20000)}

WEB SEARCH VÝSLEDKY:
${searchResultsText.slice(0, 10000)}`;

    const writeResult = await callGemini(
      "Jsi Karel, klinický psycholog. Napiš kompletní aktualizovanou kartu. Piš česky.",
      writePrompt,
    );

    // Parse: separate card from UPDATE LOG
    let updatedCardText = writeResult;
    let updateLog = "";
    const logIdx = writeResult.indexOf("---UPDATE LOG---");
    if (logIdx > 0) {
      updatedCardText = writeResult.slice(0, logIdx).trim();
      updateLog = writeResult.slice(logIdx);
    }

    // Parse update log metrics
    let newMethodsAdded = 0;
    let contradictionsFound = 0;
    let profileUpdated = false;
    const methodsMatch = updateLog.match(/Nové metody přidány:\s*(\d+)/i);
    if (methodsMatch) newMethodsAdded = parseInt(methodsMatch[1]);
    const contradMatch = updateLog.match(/Rozpory nalezeny:\s*(\d+)/i);
    if (contradMatch) contradictionsFound = parseInt(contradMatch[1]);
    if (/Profilace aktualizována:\s*ano/i.test(updateLog)) profileUpdated = true;

    const sectionsUpdated = sectionsWithChanges;
    const sectionsSkipped = ["A","B","C","D","E","F","G","H","I","J","K","L","M"]
      .filter(s => !sectionsWithChanges.includes(s));

    // BACKUP + OVERWRITE
    console.log(`[update-card] Creating backup and overwriting ${cardFile.name}`);
    await createBackup(token, folderId, cardFile.name, cardContent);
    await overwriteDoc(token, cardFile.id, updatedCardText);
    console.log(`[update-card] ✅ Card overwritten: ${cardFile.name} (${updatedCardText.length} chars)`);

    // Process cross-writes
    const crossWriteLabels: string[] = [];
    for (const cw of crossWrites) {
      try {
        await sb.from("card_crosswrite_queue").insert({
          source_part: partName,
          target_file: cw.target,
          action: cw.action,
          content: cw.content,
          status: "pending",
        });
        crossWriteLabels.push(cw.target);

        // Immediate processing for known targets
        if (cw.target === "05A_Operativni_Plan" || cw.target?.includes("Operativni")) {
          const rootId = await resolveKartotekaRoot(token);
          if (rootId) {
            const rootFiles = await listFiles(token, rootId);
            const centrumFolder = rootFiles.find(f => f.mimeType === FOLDER_MIME && /00.*CENTRUM/i.test(f.name));
            if (centrumFolder) {
              const centrumFiles = await listFiles(token, centrumFolder.id);
              const planFolder = centrumFiles.find(f => f.mimeType === FOLDER_MIME && /05.*PLAN/i.test(f.name));
              if (planFolder) {
                const planFiles = await listFiles(token, planFolder.id);
                const opPlan = planFiles.find(f => /05.*[Oo]perativni/i.test(f.name));
                if (opPlan) {
                  const appendBlock = `\n\n[${new Date().toISOString().slice(0, 10)}] [${partName}] ${cw.content}`;
                  await appendToDoc(token, opPlan.id, appendBlock);
                  await sb.from("card_crosswrite_queue")
                    .update({ status: "done", processed_at: new Date().toISOString() })
                    .eq("source_part", partName)
                    .eq("target_file", cw.target)
                    .eq("status", "pending");
                  console.log(`[update-card] Cross-write to ${cw.target} done`);
                }
              }
            }
          }
        }
      } catch (cwErr) {
        console.warn(`[update-card] Cross-write error for ${cw.target}:`, cwErr);
      }
    }

    // Handle status change (active ↔ sleeping)
    if (analysis.status_change === "sleeping" || analysis.status_change === "active") {
      try {
        const rootId = await resolveKartotekaRoot(token);
        if (rootId) {
          const rootFiles = await listFiles(token, rootId);
          const aktivniFolder = rootFiles.find(f => f.mimeType === FOLDER_MIME && (/^01/.test(f.name) || f.name.includes("AKTIV")));
          const archivFolder = rootFiles.find(f => f.mimeType === FOLDER_MIME && (/^03/.test(f.name) || f.name.includes("ARCHIV")));
          if (aktivniFolder && archivFolder) {
            if (analysis.status_change === "sleeping") {
              await moveFile(token, folderId, archivFolder.id, aktivniFolder.id);
              console.log(`[update-card] Moved ${partName} to archive (sleeping)`);
            } else {
              await moveFile(token, folderId, aktivniFolder.id, archivFolder.id);
              console.log(`[update-card] Moved ${partName} to active`);
            }
          }
        }
      } catch (moveErr) {
        console.warn(`[update-card] Status change move error:`, moveErr);
      }
    }

    // Mark threads as processed
    for (const t of threads) {
      try {
        await sb.from("card_update_processed_threads").upsert({
          part_name: partName,
          thread_id: t.threadId,
          last_processed_at: new Date().toISOString(),
          last_processed_message_id: t.messages?.[t.messages.length - 1]?.timestamp || null,
        }, { onConflict: "part_name,thread_id" });
      } catch (e) {
        console.warn(`[update-card] Failed to mark thread ${t.threadId}:`, e);
      }
    }

    // Log to card_update_log
    const processingTime = Date.now() - startTime;
    await sb.from("card_update_log").insert({
      part_name: partName,
      sections_updated: sectionsUpdated,
      sections_skipped: sectionsSkipped,
      web_searches_performed: maxSearches,
      new_therapy_methods_added: newMethodsAdded,
      contradictions_found: contradictionsFound,
      profile_updated: profileUpdated,
      cross_writes: crossWriteLabels,
      processing_time_ms: processingTime,
    });

    // Check if this part has active crisis → auto-evaluate
    try {
      const { data: activeCrisis } = await sb.from("crisis_events").select("id").eq("part_name", partName).not("phase", "eq", "closed").limit(1);
      if (activeCrisis?.length) {
        const evalUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/evaluate-crisis`;
        await fetch(evalUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${srvKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ crisisId: activeCrisis[0].id, sessionSummary: updateLog?.slice(0, 1000) }),
        });
        console.log(`[update-card] Crisis eval triggered for ${partName}`);
      }
    } catch (crisisErr) {
      console.warn("[update-card] Crisis eval error:", crisisErr);
    }

    console.log(`[update-card] ✅ Done: ${partName} in ${processingTime}ms`);

    return new Response(JSON.stringify({
      success: true,
      partName,
      sectionsUpdated,
      sectionsSkipped,
      webSearches: maxSearches,
      newMethods: newMethodsAdded,
      contradictions: contradictionsFound,
      profileUpdated,
      crossWrites: crossWriteLabels,
      processingTimeMs: processingTime,
      cardSizeBefore: cardContent.length,
      cardSizeAfter: updatedCardText.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    const processingTime = Date.now() - startTime;
    console.error("[update-card] Error:", err);

    try {
      const body = await req.clone().json().catch(() => ({}));
      await sb.from("card_update_log").insert({
        part_name: (body as any).partName || "unknown",
        error: String(err),
        processing_time_ms: processingTime,
      });
    } catch {}

    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
