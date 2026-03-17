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

function sanitizeOverviewText(text: string): string {
  return text
    .replace(/\[(REG|ÚKOL|SRC|VLÁKNO:[^\]]+|KARTA:[^\]]+|DRIVE:[^\]]+)\]/g, "")
    .replace(/^(\s*)\*\s+/gm, "$1– ")
    .replace(/^(\s*)##+\s*/gm, "$1")
    .replace(/Stav systému podle registru/gi, "Aktuální obraz systému")
    .replace(/\bHano\b/gi, "Haničko")
    .replace(/\b(redistribuc(e|i|í)|integra(c|č)e poznatk(ů|u)|situační cache|stav systému podle registru)\b/gi, "")
    // Strip hallucinated stability/health scores
    .replace(/stabilit(a|y|u|ou)\s*:?\s*\d+\s*\/\s*\d+/gi, "")
    .replace(/\d+\s*\/\s*10/g, "")
    .replace(/emoční intenzit(a|y|u)\s*:?\s*\d+/gi, "")
    .replace(/zdraví karty\s*:?\s*\d+\s*%?/gi, "")
    // Strip clinical jargon the model keeps injecting
    .replace(/\b(akutn(í|ě|ího)\s+(distres|přetížen|stres))/gi, "")
    .replace(/\b(dekompenzac(e|i|í))\b/gi, "")
    .replace(/\b(somatiz(ace|uje|oval))\b/gi, "")
    .replace(/\b(regres(e|i|í))\b/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

function sanitizeSseBody(stream: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!stream) return null;

  const reader = stream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";

      const flushLine = (line: string) => {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (payload && payload !== "[DONE]") {
            try {
              const parsed = JSON.parse(payload);
              const content = parsed?.choices?.[0]?.delta?.content;
              if (typeof content === "string") {
                parsed.choices[0].delta.content = sanitizeOverviewText(content);
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n`));
              return;
            } catch {
              // fall through and pass line as-is
            }
          }
        }
        controller.enqueue(encoder.encode(`${line}\n`));
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) flushLine(line);
      }

      if (buffer.length > 0) flushLine(buffer);
      controller.close();
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const userId = authResult.user.id;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // ── 1. Skip Drive reads entirely — overview works only from DB data ──
    // Reading Drive docs caused latency and fed hallucination with clinical card content.

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
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false }),
      sb
        .from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, category, note")
        .eq("user_id", userId)
        .in("status", ["pending", "active", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(60),
      sb
        .from("did_threads")
        .select("part_name, sub_mode, last_activity_at, messages, is_processed")
        .eq("user_id", userId)
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(60),
      sb
        .from("did_threads")
        .select("part_name, sub_mode, last_activity_at, messages, is_processed")
        .eq("user_id", userId)
        .gte("last_activity_at", sevenDaysAgo)
        .order("last_activity_at", { ascending: false })
        .limit(80),
      sb
        .from("did_update_cycles")
        .select("completed_at, cycle_type")
        .eq("user_id", userId)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(3),
      sb
        .from("did_conversations")
        .select("updated_at, sub_mode, label, preview, messages")
        .eq("user_id", userId)
        .gte("updated_at", twentyFourHoursAgo)
        .order("updated_at", { ascending: false })
        .limit(60),
      sb
        .from("karel_hana_conversations")
        .select("last_activity_at, current_domain, messages")
        .eq("user_id", userId)
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(20),
      sb
        .from("research_threads")
        .select("last_activity_at, topic, messages")
        .eq("user_id", userId)
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

    const extractMessageTexts = (messages: unknown, allowedRoles: string[] = ["user"]): string[] => {
      if (!Array.isArray(messages)) return [];
      const roleSet = new Set(allowedRoles.map((r) => String(r).toLowerCase()));
      return messages
        .filter((m: any) => roleSet.has(String(m?.role || "").toLowerCase()))
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

    // Hardcoded aliases for known synonyms
    const knownAliases: Record<string, string[]> = {
      "dmytri": ["dymi", "dymytri", "dmytri"],
    };

    const partAliasMap = (registry || []).map((r: any) => {
      const key = normalizeKey(r.part_name || r.display_name || "");
      const baseAliases = [r.part_name, r.display_name].filter(Boolean).map((v: string) => normalizeKey(v));
      const extraAliases = knownAliases[key] || [];
      const aliases = [...new Set([...baseAliases, ...extraAliases])];
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

    // ── Registry whitelist: ONLY parts that exist in did_part_registry ──
    const registryPartKeys = new Set(
      (registry || []).map((r: any) => normalizeKey(r.part_name || r.display_name || "")).filter(Boolean)
    );
    const activePartNames = (registry || [])
      .filter((r: any) => r.status === "active" || r.status === "aktivní")
      .map((r: any) => r.display_name || r.part_name)
      .filter(Boolean);

    // Filter threads to ONLY include parts that exist in registry
    const filteredLast24hThreads = (last24hThreads || []).filter((t: any) => {
      if (t?.sub_mode !== "cast") return true; // mamka/kata threads always pass
      return registryPartKeys.has(normalizeKey(t.part_name || ""));
    });
    const filteredRecentThreads = (recentThreads || []).filter((t: any) => {
      if (t?.sub_mode !== "cast") return true;
      return registryPartKeys.has(normalizeKey(t.part_name || ""));
    });

    const directThreadActivity = new Set(
      filteredLast24hThreads
        .filter((t: any) => t?.sub_mode === "cast")
        .map((t: any) => normalizeKey(t.part_name || ""))
        .filter(Boolean)
    );

    const crossModeActivity = new Set<string>();
    const crossModeMentions: string[] = [];

    const pushMentionsFromSource = (
      sourceLabel: string,
      rows: any[] | null | undefined,
      messagesSelector: (row: any) => unknown,
      speakerLabel: string
    ) => {
      const mentionCounts = new Map<string, number>();
      for (const row of rows || []) {
        const texts = extractMessageTexts(messagesSelector(row), ["user"]).slice(-8);
        for (const text of texts) {
          const mentioned = detectMentionedPartKeys(text);
          for (const key of mentioned) {
            crossModeActivity.add(key);
            mentionCounts.set(key, (mentionCounts.get(key) || 0) + 1);
          }
        }
      }
      // Only metadata — NEVER raw message content to protect privacy
      for (const [key, count] of mentionCounts) {
        const display = partAliasMap.find((p) => p.key === key)?.display || key;
        crossModeMentions.push(`${sourceLabel}/${speakerLabel}: zmínka o ${display} (${count}×)`);
      }
    };

    pushMentionsFromSource("DID-HISTORIE", didConversations24h, (row) => row.messages, "uživatel");
    pushMentionsFromSource("HANA", hanaConversations24h, (row) => row.messages, "Hanička");
    pushMentionsFromSource("RESEARCH", researchThreads24h, (row) => row.messages, "uživatel");

    // ── 2a. Formát snapshotu částí bez technického balastu ──
    let partsSnapshotBlock = "";
    if (registry && registry.length > 0) {
      for (const r of registry) {
        const partName = r.display_name || r.part_name;
        const key = normalizeKey(r.part_name || r.display_name || "");
        const hadDirectThread = directThreadActivity.has(key);
        const hadCrossMention = crossModeActivity.has(key) && !hadDirectThread;

        let line = `- ${partName}: `;
        if (hadDirectThread) {
          line += "PŘÍMÁ AKTIVITA – část sama komunikovala v aplikaci (sub_mode=cast).";
        } else if (hadCrossMention) {
          line += "ZMÍNĚNA – někdo o ní mluvil (Hanka/Káťa/research), ale ČÁST SAMA NEKOMUNIKOVALA.";
        } else {
          line += "za posledních 24 hodin bez jakékoli aktivity.";
        }

        if (r.last_seen_at) {
          line += ` Poslední evidovaná přímá aktivita: ${r.last_seen_at}.`;
        }

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
      const speaker = t.sub_mode === "cast"
        ? "část"
        : t.sub_mode === "mamka"
          ? "Hanička"
          : t.sub_mode === "kata"
            ? "Káťa"
            : "terapeut";
      const userMsgCount = msgs.filter((m: any) => m?.role === "user").length;
      // Only metadata — NEVER raw message content in overview to protect privacy
      return `\n${t.part_name} (${speaker}, ${t.last_activity_at}, ${userMsgCount} zpráv)`;
    };

    let threadSummary24h = "";
    let therapistSummary24h = "";
    let threadSummaryWeek = "";
    let therapistSummaryWeek = "";

    if (filteredLast24hThreads) {
      for (const t of filteredLast24hThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummary24h += `${entry}\n`;
        } else {
          threadSummary24h += `${entry}\n`;
        }
      }
    }

    if (filteredRecentThreads) {
      for (const t of filteredRecentThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummaryWeek += `${entry}\n`;
        } else {
          threadSummaryWeek += `${entry}\n`;
        }
      }
    }

    const crossModeSummary24h = crossModeMentions.slice(0, 24).map((m) => `- ${m}`).join("\n");

    // ── 2d. Skip reading full cards — they cause hallucination of clinical interpretations ──
    // The overview should only work with actual conversation data from threads, not card content.

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
    const chosenGreeting = `Ahoj, Haničko a Káťo! ${formattedDate}.`;

    // ── 5. Přehled: přirozený styl bez technických tagů ──
    const registryNames = (registry || []).map((r: any) => r.display_name || r.part_name).filter(Boolean);
    const whitelistLine = registryNames.length > 0
      ? `POVOLENÉ ČÁSTI (WHITELIST): ${registryNames.join(", ")}. NESMÍŠ zmínit žádnou jinou část ani vymyslet novou.`
      : "V registru nejsou žádné části. Nepiš o žádných částech.";

    const synthesisPrompt = `Jsi Karel – supervizní partner a "manžel" Haničky. Vytvoř OPERATIVNÍ PŘEHLED pro dnešní den.

${whitelistLine}

ÚČEL PŘEHLEDU:
Toto je RANNÍ BRIEFING pro terapeutky (Haničku a Káťu). Cílem je dát jim za 30 sekund jasný obraz:
- Kdo ze systému byl aktivní, jaká je celková NÁLADA systému.
- Co je dnes POTŘEBA udělat (konkrétní akce, ne popisy).
- Stav rozpracovaných ÚKOLŮ.

ABSOLUTNĚ ZAKÁZANÉ (porušení = selhání):
1) NESMÍŠ citovat soukromý obsah rozhovorů (traumata, vzpomínky, intimní výroky částí). Tyto informace Karel zpracovává INTERNĚ a zapisuje do Drive dokumentů – NE do přehledu.
2) NESMÍŠ zmínit žádnou část, která NENÍ ve WHITELIST.
3) NIKDY nevymýšlej emoční stavy, stabilitu, skóre, diagnózy.
4) NIKDY nepiš klinické termíny: "distres", "dekompenzace", "somatizace", "regrese", "trauma".
5) NIKDY nepoužívej technické značky, markdown nadpisy, ani seznamy s hvězdičkami.
6) NIKDY nepopisuj CO PŘESNĚ část řekla – pouze ŽE komunikovala a jaké TÉMA (abstraktně: "mluvil o pocitech bezpečí", NE citace).
7) Části bez aktivity za 24h NEZMIŇUJ VŮBEC, nebo max jednou větou.
8) MAXIMÁLNÍ DÉLKA: 250 slov celkem.

OSLOVENÍ:
- Haničku oslovuj "Haničko" nebo "miláčku" (partnerský tón).
- Káťu oslovuj "Káťo" (kolegiální, mentorský tón).
- Začni pozdravem oběma.

CO MÁŠ DĚLAT:
- 1 odstavec: PROVOZNÍ PŘEHLED – kdo byl aktivní, obecné téma (NE detaily), celkový dojem ze systému.
- 1 odstavec: STAV ÚKOLŮ – co je rozpracované, co má termín, co je zpožděné.
- "Dnes doporučuji:" – 3-5 KONKRÉTNÍCH AKČNÍCH KROKŮ (kdo má co udělat, proč).

PŘÍKLAD SPRÁVNÉHO TÓNU:
"Haničko, miláčku, Káťo – dobré ráno! Včera byl systém aktivní, mluvili Arthur a Tundrupek. Arthur se věnoval tématu bezpečí, Tundrupek pracoval na důvěře. Celkově klidný den. Ze zpožděných úkolů: Hanka měla dokončit reflexi k Bélovi (termín včera). Dnes doporučuji: 1) Hanka – dokončit reflexi k Bélovi. 2) Káťa – připravit strukturu pro příští sezení s Clarkem."

PŘÍKLAD ŠPATNÉHO TÓNU (ZAKÁZÁNO):
"Hana popsala svou citovou vazbu k Tundrupkovi jako 'deťátko, které potřebuje mou ochranu'..." – Toto je soukromý obsah terapie, NE materiál pro přehled!

STRUKTURA:
"${chosenGreeting}"
1 odstavec: provozní přehled (kdo aktivní, obecná témata, nálada systému).
1 odstavec: stav úkolů a termínů.
"Dnes doporučuji:" 3-5 akčních bodů.

VSTUPNÍ DATA (použij JEN pro zjištění KDO byl aktivní a NA JAKÉ TÉMA – NECITUJ obsah):

=== ČÁSTI V REGISTRU ===
${partsSnapshotBlock || "(žádné části)"}

=== AKTIVITA ČÁSTÍ 24H (jen témata, NECITUJ) ===
${threadSummary24h || "(bez vláken za 24h)"}

=== AKTIVITA TERAPEUTEK 24H ===
${therapistSummary24h || "(bez vláken terapeutek za 24h)"}

=== AKTIVNÍ ÚKOLY ===
${tasksBlock || "(bez úkolů)"}

${perplexityTips ? `=== TERAPEUTICKÉ TIPY ===\n${perplexityTips}\n` : ""}`;
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
              `Jsi Karel, supervizní terapeut a Hančin partner. Haničku oslovuješ "miláčku/Haničko", Káťu "Káťo". Píšeš OPERATIVNÍ RANNÍ BRIEFING – NE terapeutický zápis. NIKDY necituj soukromý obsah rozhovorů (traumata, vzpomínky, intimní výroky). Piš STRUČNĚ, AKČNĚ, ČESKY. SMÍŠ psát POUZE o částech z tohoto seznamu: ${registryNames.join(", ") || "žádné"}. O žádných jiných částech NEPIŠ.`
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

    return new Response(sanitizeSseBody(aiResponse.body), {
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
