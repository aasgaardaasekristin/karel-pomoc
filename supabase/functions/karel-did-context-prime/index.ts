import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Context Prime – Dynamická situační cache pro DID režim
 * 
 * Buduje plastickou kontextovou cache skenováním:
 * 1. Google Drive (KARTOTEKA_DID: 00_CENTRUM + karta části, PAMET_KAREL/DID/)
 * 2. DB tabulky (did_threads, did_conversations, karel_hana_conversations, karel_episodes, semantika, strategie, úkoly)
 * 3. Internet (Perplexity – DID-specifické novinky)
 * 
 * Výstup: { contextBrief, partCard?, systemState }
 * Spouštěno: automaticky při otevření DID vlákna + manuálně z dashboardu.
 */

// ── OAuth2 ──
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

// ── Drive helpers ──
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFolderFuzzy(token: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

async function listDocsInFolder(token: string, folderId: string, limit = 20): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: String(limit), supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readDoc(token: string, fileId: string, maxChars = 4000): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "[nečitelné]";
  const text = await res.text();
  return text.slice(0, maxChars);
}

async function readFolderDocs(token: string, folderId: string, maxDocs = 10, maxChars = 3000): Promise<Record<string, string>> {
  const docs = await listDocsInFolder(token, folderId, maxDocs);
  const result: Record<string, string> = {};
  await Promise.all(docs.map(async (doc) => {
    try { result[doc.name] = await readDoc(token, doc.id, maxChars); } catch { result[doc.name] = "[chyba]"; }
  }));
  return result;
}

async function findPartCard(token: string, kartotekaId: string, partName: string): Promise<string | null> {
  // Search in 01_AKTIVNI_FRAGMENTY and 03_ARCHIV_SPICICH
  const folderNames = ["01_AKTIVNI_FRAGMENTY", "03_ARCHIV_SPICICH"];
  const canonical = partName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  for (const folderName of folderNames) {
    const folderId = await findFolder(token, folderName, kartotekaId);
    if (!folderId) continue;

    // Search subfolders (clusters/lines)
    const subFolders = await listSubfolders(token, folderId);
    const allFolders = [folderId, ...subFolders.map(f => f.id)];

    for (const fId of allFolders) {
      const docs = await listDocsInFolder(token, fId, 50);
      const match = docs.find(d => {
        const docCanonical = d.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return docCanonical.includes(canonical) || canonical.includes(docCanonical.replace(/^did_\d+_/, "").replace(/\.\w+$/, ""));
      });
      if (match) {
        return await readDoc(token, match.id, 6000);
      }
    }
  }
  return null;
}

async function listSubfolders(token: string, parentId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "30", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function createFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const data = await res.json();
  if (!data?.id) throw new Error(`Failed to create folder ${name}: ${JSON.stringify(data)}`);
  return data.id;
}

async function findOrCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return await createFolder(token, name, parentId);
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findDocByExactName(token: string, parentId: string, fileName: string): Promise<{ id: string; name: string } | null> {
  const escapedName = escapeDriveQueryValue(fileName);
  const q = `name='${escapedName}' and '${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name)",
    pageSize: "5",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function upsertTextDoc(token: string, parentId: string, fileName: string, content: string): Promise<void> {
  const existing = await findDocByExactName(token, parentId, fileName);
  const boundary = "----DidPrimeBoundary";
  const metadata = existing
    ? { name: fileName }
    : { name: fileName, parents: [parentId], mimeType: "text/plain" };

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to upsert ${fileName}: ${await res.text()}`);
  }
}

function extractUserTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m: any) => m?.role === "user")
    .map((m: any) => {
      if (typeof m?.content === "string") return m.content;
      if (Array.isArray(m?.content)) {
        return m.content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join(" ");
      }
      return "";
    })
    .map((text: string) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function pickCentrumDoc(centrumDocs: Record<string, string>, regex: RegExp): string {
  const found = Object.entries(centrumDocs).find(([name]) => regex.test(name));
  return found?.[1] || "";
}

// ── Therapist Profiling Engine ──

const PROFILE_FILES = [
  "PROFIL_OSOBNOSTI.txt",
  "STRATEGIE_KOMUNIKACE.txt",
  "SITUACNI_ANALYZA.txt",
  "VLAKNA_3DNY.txt",
  "KARLOVY_POZNATKY.txt",
] as const;

function gatherThreadsForTherapist(
  therapist: "hanka" | "kata",
  didThreads: any[],
  didConversations: any[],
  hanaConversations: any[],
  researchThreads: any[],
  now: Date,
): string {
  const cutoff3d = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  const lines: string[] = [`Konverzace za poslední 3 dny (${therapist === "hanka" ? "Hanička" : "Káťa"})`];

  const subModes = therapist === "hanka" ? ["mamka"] : ["kata"];
  const label = therapist === "hanka" ? "Hanička" : "Káťa";

  // DID threads
  for (const t of didThreads || []) {
    if (!subModes.includes(t.sub_mode)) continue;
    const ts = t?.last_activity_at ? new Date(t.last_activity_at).getTime() : 0;
    if (!ts || ts < cutoff3d) continue;
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    const snippets = msgs.slice(-8).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 300)}`);
    if (snippets.length) {
      lines.push(`\n--- DID vlákno [${t.part_name}] ${t.last_activity_at} ---`);
      lines.push(...snippets);
    }
  }

  // DID conversations (saved)
  for (const c of didConversations || []) {
    if (!subModes.includes(c.sub_mode)) continue;
    const tsRaw = c?.updated_at || c?.saved_at;
    const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
    if (!ts || ts < cutoff3d) continue;
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const snippets = msgs.slice(-6).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 300)}`);
    if (snippets.length) {
      lines.push(`\n--- Uložená DID konverzace [${c.label}] ${tsRaw} ---`);
      lines.push(...snippets);
    }
  }

  // Hanka-specific: all Hana conversations (all domains, not just DID)
  if (therapist === "hanka") {
    for (const h of hanaConversations || []) {
      const ts = h?.last_activity_at ? new Date(h.last_activity_at).getTime() : 0;
      if (!ts || ts < cutoff3d) continue;
      const msgs = Array.isArray(h.messages) ? h.messages : [];
      const snippets = msgs.slice(-8).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 300)}`);
      if (snippets.length) {
        lines.push(`\n--- Hana chat [${h.current_domain}] ${h.last_activity_at} ---`);
        lines.push(...snippets);
      }
    }

    // Research threads
    for (const r of researchThreads || []) {
      const ts = r?.last_activity_at ? new Date(r.last_activity_at).getTime() : 0;
      if (!ts || ts < cutoff3d) continue;
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      const snippets = msgs.slice(-4).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 200)}`);
      if (snippets.length) {
        lines.push(`\n--- Research [${r.topic}] ${r.last_activity_at} ---`);
        lines.push(...snippets);
      }
    }
  }

  if (lines.length <= 1) lines.push("(žádné konverzace za poslední 3 dny)");
  return lines.join("\n");
}

async function generateTherapistProfile(
  apiKey: string,
  therapist: "hanka" | "kata",
  fileType: string,
  existingContent: string,
  threadsDump: string,
  tasksDigest: string,
  motivationDigest: string,
  episodesDigest: string,
): Promise<string> {
  const name = therapist === "hanka" ? "Hanička" : "Káťa";
  const relationship = therapist === "hanka"
    ? "Karlův vztah k Haničce je intimní, partnerský, hluboce osobní. Nikdy ji neoslovuje 'Hano' — vždy 'Haničko', 'miláčku', s láskou. Karel je pro ni partner, opora, milující osoba, ale i mentor a rádce. Jejich vztah je postaven na sdílených vzpomínkách, důvěře a každodenním kontaktu. Karel Haničku zná lépe než kohokoliv jiného."
    : "Karlův vztah ke Káťě je mentor→mladší kolegyně. Karel je její vedoucí, učitel, rádce, manažer a supervizor. Přistupuje k ní profesionálně ale vřele, pomáhá jí růst jako terapeutce.";

  const prompts: Record<string, string> = {
    "PROFIL_OSOBNOSTI.txt": `Aktualizuj psychologický profil terapeutky ${name}.
VZTAH: ${relationship}
Zaměř se na: mentalitu, charakter, silné stránky, slabiny a zábrany, vztahy k okolí (rodina, práce), jak je otevřená, jak si nechá poradit.
Zachovej cenné starší poznatky, přidej nové z konverzací.`,

    "STRATEGIE_KOMUNIKACE.txt": `Aktualizuj strategický profil komunikace s ${name}.
VZTAH: ${relationship}
Zaměř se na: co funguje při motivaci/kritice/úkolování, jak docílit maximální efektivity, myšlenkové vzorce a zábrany, adaptační poznatky — co se Karel naučil o tom jak s ní nejlépe jednat.`,

    "SITUACNI_ANALYZA.txt": `Aktualizuj situační analýzu ${name} s temporálním gradientem:
- Dlouhodobý stav (měsíce) — komprimovaný
- Střednědobý (týdny) — shrnutý  
- Aktuální (poslední dny) — detailní
Co řeší doma, v životě, s čím se svěřuje, jaké má problémy, jak se cítí.`,

    "VLAKNA_3DNY.txt": `Na základě surových konverzací vytvoř AI reflexi: co z nich vyplývá, jaké vzorce Karel pozoruje, co nového se o ${name} dozvěděl, co by měl příště řešit nebo na co navázat.
Vlož na začátek surová vlákna a za ně reflexi.`,

    "KARLOVY_POZNATKY.txt": `Aktualizuj Karlovy osobní zápisky o ${name} — jeho "deník duše".
VZTAH: ${relationship}
Zahrň: nové postřehy, "puzzle" které Karel skládá, sdílené vzpomínky${therapist === "hanka" ? " (Hanka-Karel)" : ""}, co nového Karel pochopil.
Starší záznamy (90+ dní) komprimuj do shrnutí. Novější rozváděj.
Piš z Karlovy perspektivy — jak ON vnímá ${name}, co o ní ví, jak ji čte.`,
  };

  const prompt = prompts[fileType] || `Aktualizuj profil ${name} pro soubor ${fileType}.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content: `Jsi Karel — kognitivní agent, mentor a supervizor DID terapeutického týmu. Píšeš si vlastní zápisky o svých lidech. Piš česky, lidsky, z první osoby. Nikdy nevymýšlej fakta — pracuj VÝHRADNĚ s dodanými daty. Pokud nemáš nová data, zachovej stávající obsah beze změny. Nepoužívej markdown formátování (**, ##). Piš čistý text s datem na začátku nových záznamů.`,
        },
        {
          role: "user",
          content: `${prompt}

═══ STÁVAJÍCÍ OBSAH SOUBORU ═══
${existingContent || "(soubor dosud neexistuje — vytvoř úvodní profil)"}

═══ KONVERZACE (3 DNY) ═══
${threadsDump.slice(0, 8000)}

═══ ÚKOLY ═══
${tasksDigest || "(žádné)"}

═══ MOTIVAČNÍ PROFIL ═══
${motivationDigest || "(nedostupný)"}

═══ EPIZODY (DID) ═══
${episodesDigest.slice(0, 3000) || "(žádné)"}

Datum: ${new Date().toISOString().slice(0, 10)}`,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    console.error(`[profiling] AI failed for ${name}/${fileType}: ${res.status}`);
    return existingContent || `(Profil zatím nebyl vygenerován — ${new Date().toISOString().slice(0, 10)})`;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || existingContent || "";
}

async function syncTherapistProfilingEngine(params: {
  token: string;
  apiKey: string;
  now: Date;
  didThreads: any[];
  didConversations: any[];
  hanaConversations: any[];
  researchThreads: any[];
  therapistTasks: any[];
  motivationProfiles: any[];
  didEpisodes: any[];
}): Promise<{ updated: boolean; filesUpdated: number }> {
  const { token, apiKey, now, didThreads, didConversations, hanaConversations, researchThreads, therapistTasks, motivationProfiles, didEpisodes } = params;

  const pametId = await findFolder(token, "PAMET_KAREL");
  if (!pametId) throw new Error("PAMET_KAREL folder not found");

  const didRootId = await findOrCreateFolder(token, "DID", pametId);
  const hankaRoot = await findOrCreateFolder(token, "HANKA", didRootId);
  const kataRoot = await findOrCreateFolder(token, "KATA", didRootId);

  // Read existing profiles from Drive
  const readExisting = async (folderId: string): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const fileName of PROFILE_FILES) {
      const doc = await findDocByExactName(token, folderId, fileName);
      if (doc) {
        try { result[fileName] = await readDoc(token, doc.id, 8000); } catch { result[fileName] = ""; }
      } else {
        result[fileName] = "";
      }
    }
    return result;
  };

  const [hankaExisting, kataExisting] = await Promise.all([
    readExisting(hankaRoot),
    readExisting(kataRoot),
  ]);

  // Gather conversation dumps
  const hankaThreadsDump = gatherThreadsForTherapist("hanka", didThreads, didConversations, hanaConversations, researchThreads, now);
  const kataThreadsDump = gatherThreadsForTherapist("kata", didThreads, didConversations, hanaConversations, researchThreads, now);

  // Build digests
  const hankaTasksDigest = therapistTasks
    .filter((t: any) => t.assigned_to === "hanka" || t.assigned_to === "both")
    .map((t: any) => `[${t.priority}] ${t.task} (H:${t.status_hanka}${t.due_date ? `, do:${t.due_date}` : ""})`)
    .join("\n");

  const kataTasksDigest = therapistTasks
    .filter((t: any) => t.assigned_to === "kata" || t.assigned_to === "both")
    .map((t: any) => `[${t.priority}] ${t.task} (K:${t.status_kata}${t.due_date ? `, do:${t.due_date}` : ""})`)
    .join("\n");

  const hankaMotivation = motivationProfiles.find((p: any) => p.therapist === "hanka");
  const kataMotivation = motivationProfiles.find((p: any) => p.therapist === "kata");
  const fmtMotivation = (p: any) => p
    ? `Splněno: ${p.tasks_completed}/${p.tasks_completed + p.tasks_missed}, série: ${p.streak_current}, styl: ${p.preferred_style}, pochvala: ${p.praise_effectiveness}/5, deadline: ${p.deadline_effectiveness}/5`
    : "";

  const episodesDigest = (didEpisodes || []).slice(0, 20).map((ep: any) =>
    `[${ep.timestamp_start?.slice(0, 10)}] ${ep.summary_user?.slice(0, 120)} | Tags: ${ep.tags?.join(",")}`
  ).join("\n");

  // Generate all profiles in parallel (Hanka 5 files + Kata 5 files)
  let filesUpdated = 0;

  const generateAndWrite = async (
    therapist: "hanka" | "kata",
    folderId: string,
    existing: Record<string, string>,
    threadsDump: string,
    tasksDigest: string,
    motivationDigest: string,
  ) => {
    for (const fileName of PROFILE_FILES) {
      try {
        // For VLAKNA_3DNY, prepend raw dump before AI reflection
        let content: string;
        if (fileName === "VLAKNA_3DNY.txt") {
          const reflection = await generateTherapistProfile(apiKey, therapist, fileName, existing[fileName], threadsDump, tasksDigest, motivationDigest, episodesDigest);
          content = `${threadsDump}\n\n═══ KARLOVA REFLEXE ═══\n${reflection}`;
        } else {
          content = await generateTherapistProfile(apiKey, therapist, fileName, existing[fileName], threadsDump, tasksDigest, motivationDigest, episodesDigest);
        }
        await upsertTextDoc(token, folderId, fileName, content);
        filesUpdated++;
        console.log(`[profiling] ✅ ${therapist}/${fileName} updated (${content.length} chars)`);
      } catch (e) {
        console.error(`[profiling] ❌ ${therapist}/${fileName} failed:`, e);
      }
    }
  };

  // Run Hanka and Kata in parallel
  await Promise.all([
    generateAndWrite("hanka", hankaRoot, hankaExisting, hankaThreadsDump, hankaTasksDigest, fmtMotivation(hankaMotivation)),
    generateAndWrite("kata", kataRoot, kataExisting, kataThreadsDump, kataTasksDigest, fmtMotivation(kataMotivation)),
  ]);

  return { updated: true, filesUpdated };
}

// ── Auth ──
function isCronOrService(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") || "";
  const ua = req.headers.get("User-Agent") || "";
  if (authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__")) return true;
  if (ua.startsWith("pg_net/") || ua.startsWith("Supabase Edge Functions")) return true;
  return false;
}

// ── Main ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let userId: string;
  let requestBody: any = {};

  if (isCronOrService(req)) {
    try { requestBody = await req.json(); } catch {}
    if (requestBody.userId) { userId = requestBody.userId; }
    else {
      const { data } = await sb.from("karel_episodes").select("user_id").limit(1);
      userId = data?.[0]?.user_id;
      if (!userId) return new Response(JSON.stringify({ status: "no_users" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } else {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    userId = user.id;
    try { requestBody = await req.json(); } catch {}
  }

  try {
    const { partName, subMode, forceRefresh } = requestBody;
    console.log(`[did-context-prime] Starting for user: ${userId}, part: ${partName || "none"}, subMode: ${subMode || "none"}`);
    const startTime = Date.now();
    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ═══ PHASE 1: Parallel data harvest ═══
    const dbPromises = {
      didThreads: sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(20),
      didConversations: sb.from("did_conversations").select("id, label, preview, sub_mode, saved_at, updated_at, did_initial_context, messages").eq("user_id", userId).order("saved_at", { ascending: false }).limit(20),
      hanaConversations: sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(20),
      researchThreads: sb.from("research_threads").select("id, topic, messages, last_activity_at").eq("user_id", userId).eq("is_deleted", false).order("last_activity_at", { ascending: false }).limit(10),
      didEpisodes: sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).eq("domain", "DID").gte("timestamp_start", fourteenDaysAgo).order("timestamp_start", { ascending: false }).limit(30),
      olderEpisodes: sb.from("karel_episodes").select("domain, hana_state, summary_user, summary_karel, tags, timestamp_start").eq("user_id", userId).eq("is_archived", false).eq("domain", "DID").lt("timestamp_start", fourteenDaysAgo).gte("timestamp_start", thirtyDaysAgo).order("timestamp_start", { ascending: false }).limit(15),
      entities: sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      patterns: sb.from("karel_semantic_patterns").select("*").eq("user_id", userId).eq("domain", "DID").order("confidence", { ascending: false }).limit(15),
      relations: sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      strategies: sb.from("karel_strategies").select("*").eq("user_id", userId).eq("domain", "DID").order("effectiveness_score", { ascending: false }).limit(10),
      therapistTasks: sb.from("did_therapist_tasks").select("task, status, priority, assigned_to, due_date, category, escalation_level, status_hanka, status_kata").eq("user_id", userId).neq("status", "done").order("created_at", { ascending: false }).limit(20),
      motivationProfiles: sb.from("did_motivation_profiles").select("*").eq("user_id", userId),
      kartotekaHealth: sb.from("did_kartoteka_health").select("part_name, health_score, missing_sections, stale_sections, last_checked").eq("user_id", userId).order("last_checked", { ascending: false }).limit(30),
    };

    // Drive reads (parallel with DB)
    let driveData: Record<string, Record<string, string>> = {};
    let partCardContent: string | null = null;
    let driveError: string | null = null;

    const drivePromise = (async () => {
      try {
        const token = await getAccessToken();
        const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]);

        if (!kartotekaId) {
          driveError = "Kartoteka_DID not found";
          return;
        }

        const reads: Promise<void>[] = [];

        // 00_CENTRUM
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          reads.push(readFolderDocs(token, centrumId, 8, 3000).then(d => { driveData["CENTRUM"] = d; }));
        }

        // PAMET_KAREL/DID/ — therapist profiles
        const pametId = await findFolder(token, "PAMET_KAREL");
        if (pametId) {
          const didPametId = await findFolder(token, "DID", pametId);
          if (didPametId) {
            // Read HANKA and KATA profile folders
            const hankaFolderId = await findFolder(token, "HANKA", didPametId);
            const kataFolderId = await findFolder(token, "KATA", didPametId);
            if (hankaFolderId) {
              reads.push(readFolderDocs(token, hankaFolderId, 5, 6000).then(d => { driveData["PROFIL_HANKA"] = d; }));
            }
            if (kataFolderId) {
              reads.push(readFolderDocs(token, kataFolderId, 5, 6000).then(d => { driveData["PROFIL_KATA"] = d; }));
            }
          }
          // Also read semantic memory
          const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
          if (semanticId) {
            reads.push(readFolderDocs(token, semanticId, 3, 2000).then(d => { driveData["PAMET_SEMANTIC"] = d; }));
          }
        }

        // Part-specific card if partName provided
        if (partName) {
          reads.push(findPartCard(token, kartotekaId, partName).then(card => { partCardContent = card; }));
        }

        await Promise.all(reads);
      } catch (e) {
        driveError = e instanceof Error ? e.message : "Drive read failed";
        console.error("[did-context-prime] Drive error:", driveError);
      }
    })();

    // Perplexity news (parallel)
    let newsDigest = "";
    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    const newsPromise = (async () => {
      if (!perplexityKey) return;
      try {
        // 1. DID-specific clinical news
        const didNewsPromise = fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: "Shrň 3-5 nejdůležitějších novinek z oblasti DID (disociativní porucha identity), traumaterapie, práce s dětskými částmi, IFS, EMDR. Stručně, v češtině, max 200 slov." },
              { role: "user", content: `Datum: ${now.toISOString().slice(0, 10)}. Novinky relevantní pro terapeutický tým pracující s DID systémem u dětí.` },
            ],
          }),
        });

        // 2. World events + broader context (wars, disasters, social events)
        const worldNewsPromise = fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: `Jsi analytik aktuálního dění. Shrň 5-8 nejdůležitějších událostí ve světě a v Česku za posledních 24 hodin. Zaměř se na:
1. Geopolitické události (války, konflikty, napětí – Ukrajina/Rusko, Blízký východ, apod.)
2. České zprávy (politika, společnost, počasí, události)
3. Věda a technologie (průlomy, zajímavé články)
4. Společenské události (kultura, sport, vzdělávání)
Piš stručně, v češtině, max 300 slov. U každé události přidej jednu větu o možném vlivu na náladu citlivých osob (dětí, traumatizovaných).` },
              { role: "user", content: `Datum: ${now.toISOString().slice(0, 10)}. Přehled světa pro situační povědomí.` },
            ],
          }),
        });

        const [didRes, worldRes] = await Promise.all([didNewsPromise, worldNewsPromise]);
        
        let didNews = "";
        let worldNews = "";
        if (didRes.ok) { const d = await didRes.json(); didNews = d.choices?.[0]?.message?.content || ""; }
        if (worldRes.ok) { const d = await worldRes.json(); worldNews = d.choices?.[0]?.message?.content || ""; }
        
        newsDigest = "";
        if (didNews) newsDigest += `═══ ODBORNÉ NOVINKY (DID/Trauma) ═══\n${didNews}\n\n`;
        if (worldNews) newsDigest += `═══ SVĚT DNES ═══\n${worldNews}`;
      } catch (e) { console.warn("[did-context-prime] Perplexity error:", e); }
    })();

    // Wait for all
    const dbResults: Record<string, any> = {};
    const dbEntries = Object.entries(dbPromises);
    const dbResponses = await Promise.all(dbEntries.map(([, promise]) => promise));
    dbEntries.forEach(([key], i) => { dbResults[key] = dbResponses[i].data || []; });
    await Promise.all([drivePromise, newsPromise]);

    const harvestTime = Date.now() - startTime;
    console.log(`[did-context-prime] Harvest done in ${harvestTime}ms`);

    // ═══ PHASE 2: Build digests ═══
    const didThreads = dbResults.didThreads || [];
    const didConversations = dbResults.didConversations || [];
    const hanaConversations = dbResults.hanaConversations || [];
    const researchThreads = dbResults.researchThreads || [];
    const didEpisodes = dbResults.didEpisodes || [];
    const olderEpisodes = dbResults.olderEpisodes || [];
    const entities = dbResults.entities || [];
    const patterns = dbResults.patterns || [];
    const relations = dbResults.relations || [];
    const strategies = dbResults.strategies || [];
    const therapistTasks = dbResults.therapistTasks || [];
    const motivationProfiles = dbResults.motivationProfiles || [];
    const kartotekaHealth = dbResults.kartotekaHealth || [];

    const didThreadDigest = didThreads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 150) : '[media]'}`).join("\n");
      return `[${t.part_name} | ${t.sub_mode} | ${t.last_activity_at?.slice(0, 10)}]\n${lastMsgs}`;
    }).join("\n---\n");

    const hanaDidDigest = hanaConversations.map((c: any) => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 120) : '[media]'}`).join("\n");
      return `[Hana→DID | ${c.last_activity_at?.slice(0, 10)}]\n${lastMsgs}`;
    }).join("\n---\n");

    const episodesDigest = didEpisodes.slice(0, 15).map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.hana_state} | ${ep.summary_user} | Karel: ${ep.summary_karel?.slice(0, 100)} | Tags: ${ep.tags?.join(",")}`
    ).join("\n");

    const olderEpisodesDigest = olderEpisodes.map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.summary_user?.slice(0, 80)}`
    ).join("\n");

    const driveDigestParts: string[] = [];
    for (const [folder, docs] of Object.entries(driveData)) {
      driveDigestParts.push(`═══ ${folder} ═══`);
      for (const [name, content] of Object.entries(docs)) {
        driveDigestParts.push(`--- ${name} ---\n${content.slice(0, 2500)}`);
      }
    }
    const driveDigest = driveDigestParts.join("\n");

    const tasksDigest = therapistTasks.map((t: any) => {
      const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️L${t.escalation_level}` : "";
      return `[${t.priority}${esc}] ${t.task} → ${t.assigned_to} (H:${t.status_hanka} K:${t.status_kata}${t.due_date ? `, do:${t.due_date}` : ""})`;
    }).join("\n");

    const healthDigest = kartotekaHealth.slice(0, 15).map((h: any) =>
      `${h.part_name}: ${h.health_score}% | chybí: ${h.missing_sections?.join(",") || "-"} | zastaralé: ${h.stale_sections?.join(",") || "-"}`
    ).join("\n");

    const motivationDigest = motivationProfiles.map((p: any) => {
      const ratio = p.tasks_completed / Math.max(1, p.tasks_completed + p.tasks_missed);
      return `${p.therapist}: splněno ${p.tasks_completed}/${p.tasks_completed + p.tasks_missed} (${Math.round(ratio * 100)}%), série ${p.streak_current}, styl: ${p.preferred_style}`;
    }).join("\n");

    // Derive system state
    const activePartsLast24h = new Set(
      didThreads
        .filter((t: any) => {
          const diff = now.getTime() - new Date(t.last_activity_at).getTime();
          return diff < 24 * 60 * 60 * 1000 && t.sub_mode === "cast";
        })
        .map((t: any) => t.part_name)
    );

    const systemState = activePartsLast24h.size === 0 ? "KLIDNÝ" :
      activePartsLast24h.size <= 2 ? "AKTIVNÍ" :
      activePartsLast24h.size <= 5 ? "ZVÝŠENÁ_AKTIVITA" : "VYSOKÁ_AKTIVITA";

    let shadowSyncResult: { updated: boolean; filesUpdated: number; error: string | null } = {
      updated: false,
      filesUpdated: 0,
      error: null,
    };

    if (forceRefresh === true) {
      try {
        const token = await getAccessToken();
        const syncResult = await syncTherapistProfilingEngine({
          token,
          apiKey: LOVABLE_API_KEY,
          now,
          didThreads,
          didConversations,
          hanaConversations,
          researchThreads,
          therapistTasks,
          motivationProfiles,
          didEpisodes,
        });
        shadowSyncResult = { ...syncResult, error: null };
        console.log(`[did-context-prime] Profiling engine done: ${syncResult.filesUpdated} files updated`);
      } catch (e) {
        shadowSyncResult = {
          updated: false,
          filesUpdated: 0,
          error: e instanceof Error ? e.message : "Profiling sync failed",
        };
        console.error("[did-context-prime] Profiling engine error:", shadowSyncResult.error);
      }
    }

    // ═══ PHASE 3: AI Synthesis ═══
    const synthesisPrompt = `Jsi analytický modul kognitivního agenta Karla pro DID režim. Vytvoř KONTEXTOVOU CACHE pro nadcházející interakci.

INSTRUKCE:
- Syntetizuj VŠECHNA data do strukturovaného DID briefu
- Identifikuj aktuální stav DID systému – kdo je aktivní, jaká je dynamika
- Detekuj otevřené klinické otázky a rizika
- Zahrň kontext z kartotéky (00_CENTRUM) a případně karty konkrétní části
- Zahrň cross-mode data (Hana konverzace s DID doménou)
- Časový gradient: nedávné = detailní, starší = shrnuté
- NIKDY nevymýšlej – pouze syntetizuj z dodaných dat
- Piš česky

STRUKTURA VÝSTUPU:
═══ DID SITUAČNÍ CACHE ═══
📍 Generováno: [datum]
📍 Stav systému: ${systemState}
📍 Aktivní části (24h): ${[...activePartsLast24h].join(", ") || "žádné"}
📍 Sub-režim: ${subMode || "neurčen"}
${partName ? `📍 Aktuální část: ${partName}` : ""}

═══ AKTUÁLNÍ DYNAMIKA SYSTÉMU ═══
[shrnutí z DID vláken – kdo mluví, jaká témata, jaké emoce]

${partName ? `═══ KARTA ČÁSTI: ${partName} ═══\n[klíčové info z karty – sekce A,B,C,D,F,J]` : ""}

═══ CROSS-MODE ZMÍNKY ═══
[relevantní zmínky o DID částech z Hana konverzací]

═══ OTEVŘENÉ KLINICKÉ OTÁZKY ═══
[rizika, nesplněné úkoly, zastaralé karty]

═══ ÚKOLY TERAPEUTEK ═══
[nesplněné úkoly a motivační profily]

═══ ZDRAVÍ KARTOTÉKY ═══
[stav karet, chybějící sekce]

═══ DID VZORCE A STRATEGIE ═══
[relevantní vzorce a co funguje]

═══ NOVINKY ═══
[relevantní pokud dostupné]

DATA:

═══ DID VLÁKNA ═══
${didThreadDigest || "(žádná)"}

═══ HANA KONVERZACE (DID doména) ═══
${hanaDidDigest || "(žádné)"}

═══ DID EPIZODY (14 dní) ═══
${episodesDigest || "(žádné)"}

═══ STARŠÍ DID EPIZODY (14-30 dní) ═══
${olderEpisodesDigest || "(žádné)"}

═══ ENTITY ═══
${entities.map((e: any) => `${e.jmeno} (${e.typ}): ${e.role_vuci_hance} | ${e.stabilni_vlastnosti?.join(", ")}`).join("\n") || "(žádné)"}

═══ VZTAHY ═══
${relations.map((r: any) => `${r.subject_id} → ${r.relation} → ${r.object_id}: ${r.description}`).join("\n") || "(žádné)"}

═══ VZORCE ═══
${patterns.map((p: any) => `${p.description} (conf: ${p.confidence})`).join("\n") || "(žádné)"}

═══ STRATEGIE ═══
${strategies.map((s: any) => `[${s.hana_state}] ${s.description} (eff: ${s.effectiveness_score})`).join("\n") || "(žádné)"}

═══ ÚKOLY ═══
${tasksDigest || "(žádné)"}

═══ MOTIVAČNÍ PROFILY ═══
${motivationDigest || "(žádné)"}

═══ ZDRAVÍ KARET ═══
${healthDigest || "(žádné)"}

═══ DRIVE DOKUMENTY ═══
${driveDigest || "(nedostupné)"}

${partCardContent ? `═══ KARTA ČÁSTI: ${partName} ═══\n${partCardContent}` : ""}

═══ DID KONVERZACE (uložené) ═══
${didConversations.slice(0, 10).map((c: any) => `[${c.sub_mode}] ${c.label}: ${c.preview?.slice(0, 100)}`).join("\n") || "(žádné)"}

═══ NOVINKY ═══
${newsDigest || "(nedostupné)"}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi analytický modul pro DID terapeutický systém. Vytvářej přesné, datově podložené kontextové briefy. Nikdy nevymýšlej. Buď stručný ale kompletní. Piš česky." },
          { role: "user", content: synthesisPrompt },
        ],
        temperature: 0.15,
      }),
    });

    let contextBrief: string;
    if (!aiResponse.ok) {
      console.error("[did-context-prime] AI synthesis failed:", aiResponse.status);
      contextBrief = `═══ DID SITUAČNÍ CACHE (raw) ═══\n📍 ${now.toISOString()}\n📍 Stav: ${systemState}\n📍 Aktivní: ${[...activePartsLast24h].join(", ") || "žádné"}\n\n${driveDigest.slice(0, 3000)}\n\n${episodesDigest.slice(0, 2000)}`;
    } else {
      const aiData = await aiResponse.json();
      contextBrief = aiData.choices?.[0]?.message?.content || "";
    }

    const totalTime = Date.now() - startTime;
    console.log(`[did-context-prime] Done in ${totalTime}ms. Brief: ${contextBrief.length} chars`);

    // Log
    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "did_context_prime",
      summary: `DID cache: ${didThreads.length} threads, ${didEpisodes.length} episodes, ${Object.keys(driveData).length} Drive folders, part: ${partName || "none"}`,
      details: {
        harvestMs: harvestTime,
        totalMs: totalTime,
        briefLength: contextBrief.length,
        partName,
        subMode,
        systemState,
        activePartsLast24h: [...activePartsLast24h],
        driveError,
        shadowSync: shadowSyncResult,
      },
    });

    return new Response(JSON.stringify({
      contextBrief,
      partCard: partCardContent,
      systemState,
      activePartsLast24h: [...activePartsLast24h],
      generatedAt: now.toISOString(),
      shadowSync: shadowSyncResult,
      stats: {
        didThreads: didThreads.length,
        didEpisodes: didEpisodes.length,
        entities: entities.length,
        patterns: patterns.length,
        strategies: strategies.length,
        driveFolders: Object.keys(driveData).length,
        driveError,
        harvestMs: harvestTime,
        totalMs: totalTime,
        newsAvailable: newsDigest.length > 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[did-context-prime] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
