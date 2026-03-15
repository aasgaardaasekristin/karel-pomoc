import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// OAuth2 token helper
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findFolders(token: string, name: string, parentId?: string): Promise<Array<{ id: string }>> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "20", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const folders = await findFolders(token, name, parentId);
  return folders[0]?.id || null;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const rootVariants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];
  for (const rootName of rootVariants) {
    const candidates = await findFolders(token, rootName);
    for (const candidate of candidates) {
      const centrumId = await findFolder(token, "00_CENTRUM", candidate.id);
      const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", candidate.id);
      if (centrumId || aktivniId) return candidate.id;
    }
    if (candidates[0]?.id) return candidates[0].id;
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return await exportRes.text();
  }
  return await res.text();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // ── 1. Read 00_CENTRUM docs from Google Drive ──
    let centrumDocs = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await resolveKartotekaRoot(token);
      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          const files = await listFilesInFolder(token, centrumId);
          const importantFiles = files.filter(f =>
            /dashboard|instrukce|plan|mapa|geografie|index/i.test(f.name)
          ).slice(0, 8);
          for (const f of importantFiles) {
            try {
              const content = await readFileContent(token, f.id);
              centrumDocs += `\n[${f.name}]\n${content.slice(0, 3000)}\n`;
            } catch { /* skip unreadable */ }
          }
        }
      }
    } catch (e) {
      console.warn("Drive read failed:", e);
    }

    // ── 2. DB: registry + tasks + více zdrojů aktivit (parallel) ──
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { data: registry },
      { data: pendingTasks },
      { data: last24hThreads },
      { data: recentThreads },
      { data: cycles },
      { data: didConversations24h },
      { data: hanaConversations24h },
      { data: researchThreads24h },
    ] = await Promise.all([
      sb
        .from("did_part_registry")
        .select("part_name, display_name, status, role_in_system, cluster, age_estimate, last_seen_at, last_emotional_state, last_emotional_intensity, health_score, known_triggers, known_strengths, total_threads, total_episodes")
        .order("last_seen_at", { ascending: false }),
      sb
        .from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, category, note")
        .in("status", ["pending", "active", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(60),
      sb
        .from("did_threads")
        .select("part_name, sub_mode, last_activity_at, messages, is_processed")
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(60),
      sb
        .from("did_threads")
        .select("part_name, sub_mode, last_activity_at, messages, is_processed")
        .gte("last_activity_at", sevenDaysAgo)
        .order("last_activity_at", { ascending: false })
        .limit(80),
      sb
        .from("did_update_cycles")
        .select("completed_at, cycle_type")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(3),
      sb
        .from("did_conversations")
        .select("updated_at, sub_mode, label, preview, messages")
        .gte("updated_at", twentyFourHoursAgo)
        .order("updated_at", { ascending: false })
        .limit(60),
      sb
        .from("karel_hana_conversations")
        .select("last_activity_at, current_domain, messages")
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(20),
      sb
        .from("research_threads")
        .select("last_activity_at, topic, messages")
        .eq("is_deleted", false)
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(20),
    ]);

    const normalizeKey = (value: string) =>
      (value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();

    const extractMessageTexts = (messages: unknown): string[] => {
      if (!Array.isArray(messages)) return [];
      return messages
        .map((m: any) => {
          const content = m?.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join(" ");
          }
          return "";
        })
        .filter((v: string) => typeof v === "string" && v.trim().length > 0);
    };

    const partAliasMap = (registry || []).map((r: any) => {
      const key = normalizeKey(r.part_name || r.display_name || "");
      const aliases = [...new Set([r.part_name, r.display_name].filter(Boolean).map((v: string) => normalizeKey(v)))];
      return {
        key,
        display: r.display_name || r.part_name || "část",
        aliases,
      };
    });

    const detectMentionedPartKeys = (text: string) => {
      const normalizedText = normalizeKey(text);
      if (!normalizedText) return [] as string[];
      const hits: string[] = [];
      for (const p of partAliasMap) {
        if (p.aliases.some((alias) => alias && normalizedText.includes(alias))) {
          hits.push(p.key);
        }
      }
      return [...new Set(hits)];
    };

    const directThreadActivity = new Set(
      (last24hThreads || [])
        .map((t: any) => normalizeKey(t.part_name || ""))
        .filter(Boolean)
    );

    const crossModeActivity = new Set<string>();
    const crossModeMentions: string[] = [];

    const pushMentionsFromSource = (sourceLabel: string, rows: any[] | null | undefined, messagesSelector: (row: any) => unknown) => {
      for (const row of rows || []) {
        const texts = extractMessageTexts(messagesSelector(row)).slice(-8);
        for (const text of texts) {
          const mentioned = detectMentionedPartKeys(text);
          if (mentioned.length === 0) continue;
          for (const key of mentioned) crossModeActivity.add(key);
          const partsLabel = mentioned
            .map((key) => partAliasMap.find((p) => p.key === key)?.display || key)
            .join(", ");
          crossModeMentions.push(`[${sourceLabel}] ${partsLabel}: ${text.slice(0, 260)}`);
        }
      }
    };

    pushMentionsFromSource("DID-HISTORIE", didConversations24h, (row) => row.messages);
    pushMentionsFromSource("HANA", hanaConversations24h, (row) => row.messages);
    pushMentionsFromSource("RESEARCH", researchThreads24h, (row) => row.messages);

    // ── 2a. Formát snapshotu částí bez technického balastu ──
    const isDefaultRegistryEmotion = (state: string | null, intensity: number | null) => {
      const normalizedState = (state || "").trim().toUpperCase();
      return (!normalizedState || normalizedState === "STABILNI") && (intensity == null || intensity === 3);
    };

    let partsSnapshotBlock = "";
    if (registry && registry.length > 0) {
      for (const r of registry) {
        const partName = r.display_name || r.part_name;
        const key = normalizeKey(r.part_name || r.display_name || "");
        const has24hActivity = directThreadActivity.has(key) || crossModeActivity.has(key);
        const emotionIsDefault = isDefaultRegistryEmotion(r.last_emotional_state, r.last_emotional_intensity);

        let line = `- ${partName}: status ${r.status || "neuveden"}`;
        if (!emotionIsDefault && r.last_emotional_state) {
          line += `, poslední zaznamenaná emoce ${r.last_emotional_state}`;
          if (typeof r.last_emotional_intensity === "number") {
            line += ` (${r.last_emotional_intensity}/10)`;
          }
        }
        if (r.role_in_system) line += `, role ${r.role_in_system}`;
        if (r.cluster) line += `, klastr ${r.cluster}`;
        line += has24hActivity
          ? ", v posledních 24 hodinách je zaznamenaná aktivita v aplikaci."
          : ", za posledních 24 hodin nemám novou interakci v aplikaci.";

        partsSnapshotBlock += `${line}\n`;
      }
    }

    // ── 2b. Úkoly: deduplikace + zkrácení ──
    const priorityWeight = (priority: string | null) => {
      const p = (priority || "normal").toLowerCase();
      if (p === "urgent") return 4;
      if (p === "high") return 3;
      if (p === "medium") return 2;
      if (p === "normal") return 1;
      return 0;
    };

    const sortedTasks = [...(pendingTasks || [])].sort((a: any, b: any) => {
      const byPriority = priorityWeight(b.priority) - priorityWeight(a.priority);
      if (byPriority !== 0) return byPriority;
      return String(a.due_date || "").localeCompare(String(b.due_date || ""));
    });

    const seenTaskKeys = new Set<string>();
    const uniqueTasks: any[] = [];
    for (const t of sortedTasks) {
      const taskText = typeof t.task === "string" ? t.task.trim() : "";
      if (!taskText) continue;
      const key = normalizeKey(`${taskText}|${t.assigned_to || "both"}`);
      if (seenTaskKeys.has(key)) continue;
      seenTaskKeys.add(key);
      uniqueTasks.push(t);
      if (uniqueTasks.length >= 10) break;
    }

    let tasksBlock = "";
    for (const t of uniqueTasks) {
      const due = t.due_date ? `, termín ${t.due_date}` : "";
      const note = t.note ? ` — ${String(t.note).slice(0, 90)}` : "";
      tasksBlock += `\n- ${String(t.task).slice(0, 180)} (pro ${t.assigned_to || "both"}${due})${note}`;
    }

    // ── 2c. Kontext vláken + cross-mode zmínek ──
    const formatThreadEntry = (t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const speaker = t.sub_mode === "cast" ? "část" : "terapeut";
      const snippets = msgs
        .filter((m: any) => m?.role === "user" && typeof m?.content === "string")
        .slice(-5)
        .map((m: any) => `- ${String(m.content).slice(0, 240)}`)
        .join("\n");
      return `\n${t.part_name} (${speaker}, ${t.last_activity_at})\n${snippets || "- bez user zpráv"}`;
    };

    let threadSummary24h = "";
    let therapistSummary24h = "";
    let threadSummaryWeek = "";
    let therapistSummaryWeek = "";

    if (last24hThreads) {
      for (const t of last24hThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummary24h += `${entry}\n`;
        } else {
          threadSummary24h += `${entry}\n`;
        }
      }
    }

    if (recentThreads) {
      for (const t of recentThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummaryWeek += `${entry}\n`;
        } else {
          threadSummaryWeek += `${entry}\n`;
        }
      }
    }

    const crossModeSummary24h = crossModeMentions.slice(0, 24).map((m) => `- ${m}`).join("\n");

    // ── 2d. Read cards of active parts from Drive ──
    let activePartCards = "";
    const activePartNames = recentThreads
      ? [...new Set(recentThreads.filter((t: any) => t.sub_mode === "cast").map((t: any) => t.part_name))]
      : [];

    if (activePartNames.length > 0) {
      try {
        const token = await getAccessToken();
        const kartotekaId = await resolveKartotekaRoot(token);
        if (kartotekaId) {
          const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", kartotekaId);
          if (aktivniId) {
            const partFiles = await listFilesInFolder(token, aktivniId);
            for (const partName of activePartNames.slice(0, 8)) {
              const normalizedName = normalizeKey(partName);
              const matchedFile = partFiles.find((f) => normalizeKey(f.name).includes(normalizedName));
              if (!matchedFile) continue;
              try {
                const content = await readFileContent(token, matchedFile.id);
                activePartCards += `\n[KARTA: ${matchedFile.name}]\n${content.slice(0, 4000)}\n`;
              } catch {
                // skip unreadable files
              }
            }
          }
        }
      } catch (e) {
        console.warn("Active part cards read failed:", e);
      }
    }

    // ── 2e. Cycles metadata ──
    let cycleInfo = "";
    if (cycles) {
      for (const c of cycles) {
        cycleInfo += `\n- ${c.cycle_type} cyklus dokončen ${c.completed_at}`;
      }
    }

    // ── 3. Optional Perplexity tips (jen pokud opravdu existují) ──
    let perplexityTips = "";
    if (PERPLEXITY_API_KEY && activePartNames.length > 0) {
      try {
        const searchQuery = `terapeutické přístupy pro práci s dětskými částmi DID: ${activePartNames.slice(0, 5).join(", ")}`;
        const pxRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar-pro",
            messages: [
              {
                role: "system",
                content: "Vrať 2-3 stručné, praktické terapeutické tipy v češtině. Bez omáčky, bez disclaimerů.",
              },
              { role: "user", content: searchQuery },
            ],
            search_recency_filter: "year",
          }),
        });
        if (pxRes.ok) {
          const pxData = await pxRes.json();
          perplexityTips = (pxData.choices?.[0]?.message?.content || "").trim();
        }
      } catch (e) {
        console.warn("Perplexity search failed:", e);
      }
    }

    // ── 4. Build greeting ──
    const now = new Date();
    const dayNames = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    const dayName = dayNames[now.getDay()];
    const hour = now.getHours();
    const minute = now.getMinutes().toString().padStart(2, "0");
    const formattedDate = `${dayName} ${now.getDate()}. ${now.toLocaleDateString("cs-CZ", { month: "long", year: "numeric" })}, ${hour}:${minute}`;
    const chosenGreeting = `Ahoj, Hani a Káťo! ${formattedDate}.`;

    // ── 5. Přehled: přirozený styl bez technických tagů ──
    const synthesisPrompt = `Jsi Karel – supervizní partner a tandem-terapeut. Vytvoř přehled VÝHRADNĚ z dat níže.

TVRDÁ PRAVIDLA:
1) Nikdy nevymýšlej fakta, čísla ani závěry, které nejsou podložené vstupem.
2) Nepoužívej technické značky [REG], [VLÁKNO], [KARTA], [ÚKOL], [DRIVE] ani markdown nadpisy.
3) Nepiš sekci ani větu "Stav systému podle registru".
4) Nepoužívej formulace "STABILNI (3/10)", "zdraví karty" ani procenta zdraví.
5) Pokud je u části uvedeno, že za posledních 24 hodin je aktivita, NESMÍŠ psát, že pro ni nemáš data.
6) Žádné dramatizace typu "kritický bod" nebo "dekompenzace", pokud to není doslova řečeno ve zprávách.
7) Pokud nemáš terapeutické tipy, tuto oblast úplně vynech a nic o chybějících zdrojích nepiš.

STYL VÝSTUPU:
- Přirozená čeština, lidský tón, stručně a věcně.
- Krátké odstavce.
- Žádné technické závorky, žádné interní značky, žádné markdown seznamy s hvězdičkami.

POVINNÁ STRUKTURA:
- 1 úvodní pozdrav (použij přesně tento text): "${chosenGreeting}"
- 1 odstavec: co se reálně odehrálo za posledních 24 hodin (max 3 krátké citace v uvozovkách).
- 1 odstavec: co to prakticky znamená pro dnešní péči.
- 1 krátký blok "Dnes doporučuji:" a pod tím 4-6 konkrétních akčních bodů (komu, co, proč), bez duplicit a bez dlouhého seznamu.

VSTUPNÍ DATA:

=== SNAPSHOT ČÁSTÍ (registr + aktivita z celé aplikace 24h) ===
${partsSnapshotBlock || "(části nejsou v registru)"}

=== VLAKNA ČÁSTÍ 24H ===
${threadSummary24h || "(bez vláken částí za 24h)"}

=== VLAKNA TERAPEUTEK 24H ===
${therapistSummary24h || "(bez vláken terapeutek za 24h)"}

=== ZMÍNKY V OSTATNÍCH REŽIMECH 24H ===
${crossModeSummary24h || "(bez zachycených zmínek)"}

=== KONTEXT TÝDNE (části) ===
${threadSummaryWeek || "(bez týdenního kontextu)"}

=== KONTEXT TÝDNE (terapeutky) ===
${therapistSummaryWeek || "(bez týdenního kontextu)"}

=== KARTY AKTIVNÍCH ČÁSTÍ (Drive) ===
${activePartCards || "(karty nedostupné)"}

=== AKTIVNÍ ÚKOLY (deduplikované) ===
${tasksBlock || "(bez aktivních úkolů)"}

=== POSLEDNÍ AKTUALIZACE KARTOTÉKY ===
${cycleInfo || "(bez záznamu)"}

${perplexityTips ? `=== KRÁTKÉ TERAPEUTICKÉ TIPY ===\n${perplexityTips}\n` : ""}

Pamatuj: Výstup musí být čitelný, lidský a bez technických artefaktů.`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "Jsi Karel, supervizní terapeut. Odpovídej česky, přirozeně, věcně. Nikdy nevymýšlej data mimo vstupy a nikdy nepoužívej technické tagy ani markdown formát."
          },
          { role: "user", content: synthesisPrompt },
        ],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit – zkus to za chvilku." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Nedostatek kreditů." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errText);
      throw new Error("AI gateway error");
    }

    return new Response(aiResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("System overview error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
