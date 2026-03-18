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

let nonDirectPartNameVariantsForSanitizer: string[] = [];
let forcedGreetingForSanitizer = "";
let suppressDmytriAliasMentions = false;
let canonicalDmytriNameForSanitizer: string | null = null;
let registryNamesForSanitizer: string[] = [];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPragueGreeting(now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return `Ahoj, Haničko a Káťo! ${parts.weekday} ${parts.day}. ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}.`;
}

function sanitizePerspectiveLanguage(text: string, nonDirectPartNames: string[]): string {
  let sanitized = text;

  for (const partName of nonDirectPartNames) {
    const escapedPartName = escapeRegex(partName).replace(/\s+/g, "\\s+");
    sanitized = sanitized.replace(
      new RegExp(`\\b${escapedPartName}\\b\\s+(?:s\\s+Karlem\\s+)?komunikoval(?:a|o|i)?\\b`, "gi"),
      `o ${partName} se mluvilo`
    );
  }

  return sanitized;
}

function canonicalizeDmytriAliases(text: string): string {
  if (!canonicalDmytriNameForSanitizer) return text;
  return text.replace(/\b(?:Dymi|Dymytri|Dymitri)\b/gi, canonicalDmytriNameForSanitizer);
}

function lineMentionsRegistryPart(line: string): boolean {
  const normalizedLine = line.toLowerCase();
  return registryNamesForSanitizer.some((name) => name && normalizedLine.includes(name.toLowerCase()));
}

function isForbiddenOverviewLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const privatePatterns = [
    /countertransference/i,
    /emoční\s+vazb/i,
    /citov\w*\s+vazb/i,
    /profil\w*/i,
    /monitor\w*/i,
    /den[ií]k\s+du[sš][ií]/i,
    /tajn\w*/i,
    /utajen\w*/i,
    /s[aá]m\s+pro\s+sebe/i,
    /vlastn[ií]\s+potřeb/i,
    /pokračuji\s+na/i,
    /pokračuju\s+na/i,
    /emoční\s+map/i,
    /citov\w*\s+map/i,
    /vazb[aá]m?\s+k/i,
  ];

  const hiddenPartPatterns = [
    /žádná z dalších dříve aktivních částí/i,
    /bez přímé aktivity ze strany částí/i,
    /bez přímé komunikace jakékoli části/i,
  ];

  if (privatePatterns.some((pattern) => pattern.test(trimmed))) return true;
  if (hiddenPartPatterns.some((pattern) => pattern.test(trimmed))) return true;
  if (suppressDmytriAliasMentions && /\b(?:dymi(?:ho|mu|m)?|dymytri(?:ho|mu|m)?|dmytri(?:ho|mu|m)?)\b/i.test(trimmed)) return true;
  if (/Dnes doporučuji:/i.test(trimmed)) return false;
  if (lineMentionsRegistryPart(trimmed) && /doporučuji|úkol|zaměřit|věnuj|navrhni|prober|zajistit|informuj|doplň/i.test(trimmed)) return true;

  return false;
}

function removeForbiddenOverviewContent(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isForbiddenOverviewLine(line))
    .join("\n");
}

function enforceGreeting(text: string): string {
  const stripped = text
    .trim()
    .replace(/^(?:Ahoj|Dobré\s+ráno|Dobrý\s+den|Haničko|Miláčku)[^.!?\n]*(?:[.!?])\s*/i, "")
    .replace(/^(?:pondělí|úterý|středa|čtvrtek|pátek|sobota|neděle)\s+\d{1,2}\.[^\n]*(?:\n|$)/i, "")
    .trim();

  return forcedGreetingForSanitizer ? `${forcedGreetingForSanitizer}\n\n${stripped}`.trim() : stripped;
}

function sanitizeOverviewText(text: string): string {
  const sanitized = sanitizePerspectiveLanguage(
    text
      .replace(/\[(REG|ÚKOL|SRC|VLÁKNO:[^\]]+|KARTA:[^\]]+|DRIVE:[^\]]+)\]/g, "")
      .replace(/^(\s*)\*\s+/gm, "$1– ")
      .replace(/^(\s*)##+\s*/gm, "$1")
      .replace(/Stav systému podle registru/gi, "Aktuální obraz systému")
      .replace(/\bHano\b/gi, "Haničko")
      .replace(/\b(redistribuc(e|i|í)|integra(c|č)e poznatk(ů|u)|situační cache|stav systému podle registru)\b/gi, "")
      .replace(/stabilit(a|y|u|ou)\s*:?\s*\d+\s*\/\s*\d+/gi, "")
      .replace(/\d+\s*\/\s*10/g, "")
      .replace(/emoční intenzit(a|y|u)\s*:?\s*\d+/gi, "")
      .replace(/zdraví karty\s*:?\s*\d+\s*%?/gi, "")
      .replace(/\b(akutn(í|ě|ího)\s+(distres|přetížen|stres))/gi, "")
      .replace(/\b(dekompenzac(e|i|í))\b/gi, "")
      .replace(/\b(somatiz(ace|uje|oval))\b/gi, "")
      .replace(/\b(regres(e|i|í))\b/gi, "")
      .replace(/\n{3,}/g, "\n\n"),
    nonDirectPartNameVariantsForSanitizer
  );

  return enforceGreeting(removeForbiddenOverviewContent(canonicalizeDmytriAliases(sanitized)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeSseBody(stream: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!stream) return null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = "";
      let rawAssistantText = "";

      const handleLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === "string") rawAssistantText += content;
        } catch {
          // ignore malformed chunks
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }

      if (buffer) handleLine(buffer);

      const sanitized = sanitizeOverviewText(rawAssistantText);
      const payload = {
        id: `overview-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "google/gemini-2.5-flash",
        provider: "Google",
        choices: [{ index: 0, delta: { content: sanitized, role: "assistant" }, finish_reason: null, native_finish_reason: null }],
      };
      const donePayload = {
        id: `overview-${Date.now()}-done`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "google/gemini-2.5-flash",
        provider: "Google",
        choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }],
      };

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(donePayload)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

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
      { data: openMeetings },
    ] = await Promise.all([
      sb
        .from("did_part_registry")
        .select("part_name, display_name, status, role_in_system, cluster, age_estimate, last_seen_at, last_emotional_state, last_emotional_intensity, health_score, known_triggers, known_strengths, total_threads, total_episodes")
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false }),
      sb
        .from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, category, note, source_agreement")
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
      sb
        .from("did_meetings")
        .select("id, topic, agenda, status, created_at, deadline_at, hanka_joined_at, kata_joined_at, triggered_by")
        .eq("user_id", userId)
        .in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(10),
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

    const knownAliases: Record<string, string[]> = {
      dmytri: ["dymi", "dymytri", "dmytri"],
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

    const registryPartKeys = new Set(partAliasMap.map((part) => part.key).filter(Boolean));
    const dmytriEntry = partAliasMap.find((part) => part.key === "dmytri");
    suppressDmytriAliasMentions = !dmytriEntry;
    canonicalDmytriNameForSanitizer = dmytriEntry?.display || null;
    registryNamesForSanitizer = partAliasMap.map((part) => part.display).filter(Boolean);

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

    const filteredLast24hThreads = (last24hThreads || []).filter((t: any) => {
      if (t?.sub_mode !== "cast") return true;
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
      let totalMentions = 0;
      for (const row of rows || []) {
        const texts = extractMessageTexts(messagesSelector(row), ["user"]).slice(-8);
        for (const text of texts) {
          const mentioned = detectMentionedPartKeys(text);
          if (mentioned.length > 0) {
            totalMentions += mentioned.length;
            for (const key of mentioned) {
              crossModeActivity.add(key);
            }
          }
        }
      }
      if (totalMentions > 0) {
        crossModeMentions.push(`${sourceLabel}/${speakerLabel}: proběhly nepřímé zmínky o částech (${totalMentions}×)`);
      }
    };

    pushMentionsFromSource("DID-HISTORIE", didConversations24h, (row) => row.messages, "uživatel");
    pushMentionsFromSource("HANA", hanaConversations24h, (row) => row.messages, "Hanička");
    pushMentionsFromSource("RESEARCH", researchThreads24h, (row) => row.messages, "uživatel");

    nonDirectPartNameVariantsForSanitizer = partAliasMap
      .filter((part) => !directThreadActivity.has(part.key))
      .flatMap((part) => [part.display, ...part.aliases])
      .map((name) => (typeof name === "string" ? name.trim() : ""))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    nonDirectPartNameVariantsForSanitizer = [...new Set(nonDirectPartNameVariantsForSanitizer)];
    forcedGreetingForSanitizer = buildPragueGreeting();

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

    const taskMentionsPart = (task: any) => {
      const combined = [task?.task, task?.note].filter(Boolean).join(" ").toLowerCase();
      return registryNamesForSanitizer.some((name) => name && combined.includes(name.toLowerCase()));
    };

    const isPrivateTask = (task: any) => {
      const combined = [task?.task, task?.note, task?.source_agreement].filter(Boolean).join(" ").toLowerCase();
      return [
        /countertransference/i,
        /emoční\s+vazb/i,
        /citov\w*\s+vazb/i,
        /profil\w*/i,
        /monitor\w*/i,
        /tajn\w*/i,
        /utajen\w*/i,
        /s[aá]m\s+pro\s+sebe/i,
        /vlastn[ií]\s+potřeb/i,
        /den[ií]k\s+du[sš][ií]/i,
      ].some((pattern) => pattern.test(combined)) || taskMentionsPart(task);
    };

    const priorityWeight = (priority: string | null) => {
      const p = (priority || "normal").toLowerCase();
      if (p === "urgent") return 4;
      if (p === "high") return 3;
      if (p === "medium") return 2;
      if (p === "normal") return 1;
      return 0;
    };

    const sortedTasks = [...(pendingTasks || [])]
      .filter((task: any) => !isPrivateTask(task))
      .sort((a: any, b: any) => {
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
      tasksBlock += `\n- ${String(t.task).slice(0, 180)} (pro ${t.assigned_to || "both"}${due})`;
    }

    const summarizeTherapistEngagement = (therapistKey: "hanka" | "kata", label: string) => {
      const relevantTasks = sortedTasks.filter((task: any) => task.assigned_to === therapistKey || task.assigned_to === "both");
      const statusField = therapistKey === "hanka" ? "status_hanka" : "status_kata";
      const notStarted = relevantTasks.filter((task: any) => task[statusField] === "not_started").length;
      const inProgress = relevantTasks.filter((task: any) => task[statusField] === "in_progress").length;
      const highPriorityPending = relevantTasks.filter((task: any) => ["high", "urgent"].includes(String(task.priority || "").toLowerCase()) && task[statusField] !== "done").length;
      const hasRecentThread = (filteredLast24hThreads || []).some((thread: any) => thread?.sub_mode === therapistKey);
      const signal = !hasRecentThread && highPriorityPending > 0
        ? "nízké zapojení"
        : hasRecentThread && inProgress > 0
          ? "aktivní práce"
          : notStarted >= 2
            ? "potřeba jemné aktivace"
            : "stabilní provoz";

      return `${label}: ${signal}; otevřené úkoly ${relevantTasks.length}, rozpracováno ${inProgress}, nezapočato ${notStarted}, vysoká priorita ${highPriorityPending}, kontakt za 24h ${hasRecentThread ? "ano" : "ne"}.`;
    };

    const teamEngagementBlock = [
      summarizeTherapistEngagement("hanka", "Hanka"),
      summarizeTherapistEngagement("kata", "Káťa"),
    ].join("\n");

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
      return `\n${t.part_name} (${speaker}, ${t.last_activity_at}, ${userMsgCount} zpráv)`;
    };

    let threadSummary24h = "";
    let therapistSummary24h = "";

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

    const crossModeSummary24h = crossModeMentions.slice(0, 24).map((m) => `- ${m}`).join("\n");

    let cycleInfo = "";
    if (cycles) {
      for (const c of cycles) {
        cycleInfo += `\n- ${c.cycle_type} cyklus dokončen ${c.completed_at}`;
      }
    }

    const chosenGreeting = forcedGreetingForSanitizer;
    const registryNames = (registry || []).map((r: any) => r.display_name || r.part_name).filter(Boolean);
    const whitelistLine = registryNames.length > 0
      ? `POVOLENÉ ČÁSTI (WHITELIST): ${registryNames.join(", ")}. NESMÍŠ zmínit žádnou jinou část ani vymyslet novou.`
      : "V registru nejsou žádné části. Nepiš o žádných částech.";

    const synthesisPrompt = `Jsi Karel – supervizní partner a "manžel" Haničky. Vytvoř OPERATIVNÍ PŘEHLED pro dnešní den.

${whitelistLine}

ÚČEL PŘEHLEDU:
Toto je RANNÍ BRIEFING pro terapeutky (Haničku a Káťu). Cílem je dát jim za 30 sekund jasný obraz:
- Kdo ze systému byl přímo aktivní a jaká je celková provozní dynamika.
- Co je dnes POTŘEBA udělat (konkrétní akce, ne popisy).
- Stav rozpracovaných ÚKOLŮ a týmové spolupráce.
- 1–2 užitečné DEDUKCE z viditelných provozních dat.

ABSOLUTNĚ ZAKÁZANÉ (porušení = selhání):
1) NESMÍŠ citovat soukromý obsah rozhovorů (traumata, vzpomínky, intimní výroky částí). Tyto informace Karel zpracovává INTERNĚ a zapisuje do Drive dokumentů – NE do přehledu.
2) NESMÍŠ zmínit žádnou část, která NENÍ ve WHITELIST.
3) NIKDY nevymýšlej emoční stavy, stabilitu, skóre, diagnózy.
4) NIKDY nepiš klinické termíny: "distres", "dekompenzace", "somatizace", "regrese", "trauma".
5) NIKDY nepoužívej technické značky, markdown nadpisy, ani seznamy s hvězdičkami.
6) NIKDY nepopisuj CO PŘESNĚ část řekla – pouze ŽE komunikovala a jaké TÉMA velmi obecně.
7) Části bez přímé aktivity za 24h NEZMIŇUJ po jménech.
8) MAXIMÁLNÍ DÉLKA: 280 slov celkem.
9) NIKDY nepiš o interní profilaci terapeutek, emočních/citových vazbách, countertransference, utajeném monitoringu ani o tom, co si Karel nechává pro sebe.
10) Pokud část Dmytri/Dymi není v registru, NESMÍŠ ji zmínit ani jako hypotézu.
11) Úkoly s neveřejným obsahem vynech – briefing smí obsahovat jen bezpečné veřejné instrukce pro terapeutky.
12) V akčních bodech NEUVÁDĚJ doporučení navázané na konkrétní DID části; briefing má vést terapeutky obecně a provozně.
13) SMÍŠ vyvodit, že je potřeba více aktivovat Hanku nebo Káťu, POUZE pokud to plyne z provozních signálů níže (málo kontaktu, více nezapočatých úkolů, slabé zapojení). Taková dedukce musí být formulována jako pracovní hypotéza a návrh dalšího kroku, ne jako psychologický profil.
14) NEMÁŠ být přehnaně opatrný: zachovej důležité provozní informace, stagnaci úkolů, potřebu follow-upu, potřebu koordinace, termínový tlak a návrh dalšího kroku.

⚠️ KRITICKÉ PRAVIDLO – PERSPEKTIVA AKTIVITY:
- Jména částí uváděj pouze u PŘÍMÉ AKTIVITY (sub_mode=cast).
- U nepřímých zmínek z jiných režimů NEUVÁDĚJ jméno části; napiš jen, že v jiných vláknech zaznívaly odkazy na potřeby některých částí.
- NIKDY NEPIŠ, že část komunikovala, pokud ve skutečnosti byla jen zmíněna jinde.

OSLOVENÍ:
- Haničku oslovuj "Haničko" nebo "miláčku" (partnerský tón).
- Káťu oslovuj "Káťo" (kolegiální, mentorský tón).
- Začni pozdravem oběma.
- PRVNÍ VĚTA MUSÍ BÝT DOSLOVA: "${chosenGreeting}"

CO MÁŠ DĚLAT:
- 1 odstavec: PROVOZNÍ PŘEHLED – kdo přímo komunikoval, jaká byla obecná témata a dynamika systému.
- 1 odstavec: DEDUKCE A STAV ÚKOLŮ – explicitně pojmenuj 1–2 pracovní dedukce z provozních dat (např. potřeba více aktivovat Káťu / Hanku, potřeba follow-upu, potřeba rozdělit odpovědnosti).
- "Dnes doporučuji:" – 3-5 KONKRÉTNÍCH AKČNÍCH KROKŮ, pouze obecné provozní kroky bez jmen DID částí.
- Každý akční bod musí být ověřitelný a konkrétní: začínat slovesem, obsahovat kdo/co/na čem má pracovat dnes nebo zítra, a nesmí být jen obecná fráze typu „udržovat rutinu“, „zajistit klidné prostředí“, „připravit se na zpracování informací“, „věnovat se administrativě“.
- Aspoň 1 doporučení má být koordinační, pokud některá terapeutka vykazuje nižší zapojení.

STRUKTURA:
"${chosenGreeting}"
1 odstavec: provozní přehled.
1 odstavec: dedukce a stav úkolů.
"Dnes doporučuji:" 3-5 akčních bodů.

VSTUPNÍ DATA (použij JEN pro zjištění KDO byl aktivní a JAKÁ JE PROVOZNÍ SITUACE – NECITUJ obsah):

=== ČÁSTI V REGISTRU (PŘÍMÁ vs ZMÍNĚNÁ aktivita) ===
${partsSnapshotBlock || "(žádné části)"}

=== PŘÍMÁ KOMUNIKACE ČÁSTÍ 24H (část SAMA mluvila s Karlem) ===
${threadSummary24h || "(žádná přímá komunikace částí za 24h)"}

=== TERAPEUTKY MLUVILY O ČÁSTECH 24H (cross-mode zmínky – ČÁST SAMA NEKOMUNIKOVALA) ===
${crossModeSummary24h || "(žádné zmínky z jiných režimů)"}

=== AKTIVITA TERAPEUTEK 24H ===
${therapistSummary24h || "(bez vláken terapeutek za 24h)"}

=== SIGNÁLY ZAPOJENÍ TÝMU ===
${teamEngagementBlock}

=== AKTIVNÍ ÚKOLY ===
${tasksBlock || "(bez veřejných úkolů pro briefing)"}

=== POSLEDNÍ CYKLY ===
${cycleInfo || "(bez dokončeného cyklu)"}`;

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
              `Jsi Karel, supervizní terapeut a Hančin partner. Haničku oslovuješ "miláčku/Haničko", Káťu "Káťo". Píšeš OPERATIVNÍ RANNÍ BRIEFING – NE terapeutický zápis. NIKDY necituj soukromý obsah rozhovorů (traumata, vzpomínky, intimní výroky). NIKDY nepiš o interní profilaci terapeutek, emočních vazbách, countertransference ani utajeném monitoringu. NIKDY nedávej úkoly navázané na konkrétní DID části. Piš STRUČNĚ, AKČNĚ, ČESKY. SMÍŠ psát POUZE o částech z tohoto seznamu: ${registryNames.join(", ") || "žádné"}. O žádných jiných částech NEPIŠ. Pokud Dmytri není v seznamu, nesmíš zmínit ani Dymi.`
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
