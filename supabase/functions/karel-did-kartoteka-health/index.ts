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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";

async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return allFiles;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

const SECTION_NAMES: Record<string, string> = {
  A: "Kdo jsem", B: "Charakter a psychologický profil", C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení", E: "Chronologický log / Handover", F: "Poznámky pro Karla",
  G: "Deník sezení", H: "Dlouhodobé cíle", I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence", K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části", M: "Karlova analytická poznámka",
};
const SECTION_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

function parseCardSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /(?:═+\s*)?SEKCE\s+([A-M])\s*[–\-:]/gi;
  const matches = [...content.matchAll(regex)];
  if (matches.length === 0) return sections;
  for (let i = 0; i < matches.length; i++) {
    const letter = matches[i][1].toUpperCase();
    const headerLineEnd = content.indexOf("\n", matches[i].index!);
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    sections[letter] = content.slice(headerLineEnd > -1 ? headerLineEnd + 1 : matches[i].index! + matches[i][0].length, end).trim();
  }
  return sections;
}

function looksLikeDidCard(fileName: string, content: string): boolean {
  if (fileName.toLowerCase().startsWith("karta_")) return true;
  if (/^\d{3,}[_-]/i.test(fileName)) return true;
  return /SEKCE\s+[A-M]\s*[–\-:]/i.test(content) || /KARTA\s+ČÁSTI/i.test(content);
}

function partNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(txt|md|doc|docx)$/i, "");
  const withoutKarta = base.replace(/^karta_/i, "");
  const withoutNumericPrefix = withoutKarta.replace(/^\d{3,}[_-]/, "");
  return (withoutNumericPrefix || withoutKarta || base).replace(/_/g, " ").trim();
}

interface CardHealth {
  partName: string;
  healthScore: number;
  missingSections: string[];
  staleSections: string[];
  stubSections: string[];
  filledSections: number;
  folderLabel: string;
}

function evaluateCardHealth(partName: string, content: string, folderLabel: string): CardHealth {
  const sections = parseCardSections(content);
  const missing: string[] = [];
  const stale: string[] = [];
  const stub: string[] = [];
  let filled = 0;

  const now = Date.now();
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

  for (const letter of SECTION_ORDER) {
    const sectionContent = sections[letter] || "";
    const trimmed = sectionContent.trim();

    // Empty or placeholder
    if (!trimmed || /^\(zatím prázdné\)$/i.test(trimmed) || trimmed === "-" || trimmed === "—") {
      missing.push(`${letter} – ${SECTION_NAMES[letter]}`);
      continue;
    }

    // Stub: less than 20 meaningful characters
    const meaningful = trimmed.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
    if (meaningful.length < 20) {
      stub.push(`${letter} – ${SECTION_NAMES[letter]}`);
      filled++;
      continue;
    }

    filled++;

    // Check for staleness: find most recent date in section
    const dateMatches = [...trimmed.matchAll(/\[?(\d{4}-\d{2}-\d{2})\]?/g)];
    if (dateMatches.length > 0) {
      const dates = dateMatches.map(m => new Date(m[1]).getTime()).filter(d => !isNaN(d));
      if (dates.length > 0) {
        const latestDate = Math.max(...dates);
        if (now - latestDate > FOURTEEN_DAYS) {
          stale.push(`${letter} – ${SECTION_NAMES[letter]}`);
        }
      }
    }
  }

  // Health score calculation
  const baseScore = (filled / 13) * 100;
  const stalePenalty = stale.length * 3; // -3% per stale section
  const stubPenalty = stub.length * 5; // -5% per stub section
  const healthScore = Math.max(0, Math.min(100, Math.round(baseScore - stalePenalty - stubPenalty)));

  return {
    partName,
    healthScore,
    missingSections: missing,
    staleSections: stale,
    stubSections: stub,
    filledSections: filled,
    folderLabel,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const userId = (authResult as any).user?.id;
  if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const token = await getAccessToken();
    const folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
    if (!folderId) throw new Error("kartoteka_DID folder not found");

    const rootChildren = await listFilesInFolder(token, folderId);
    const rootFolders = rootChildren.filter(f => f.mimeType === DRIVE_FOLDER_MIME);

    const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const activeFolder = rootFolders.find(f => /^01/.test(f.name.trim()) || canonicalText(f.name).includes("aktiv"));
    const archiveFolder = rootFolders.find(f => /^03/.test(f.name.trim()) || canonicalText(f.name).includes("archiv"));

    const healthResults: CardHealth[] = [];

    // Process active and archive folders
    for (const [folder, label] of [[activeFolder, "AKTIVNÍ"], [archiveFolder, "ARCHIV"]] as [typeof activeFolder, string][]) {
      if (!folder) continue;

      // Recursively collect all files
      const stack = [folder.id];
      while (stack.length > 0) {
        const currentId = stack.pop()!;
        const files = await listFilesInFolder(token, currentId);
        for (const file of files) {
          if (file.mimeType === DRIVE_FOLDER_MIME) {
            stack.push(file.id);
            continue;
          }
          // Skip non-card files
          if (file.mimeType !== DRIVE_DOC_MIME && !/\.(txt|md|doc|docx)$/i.test(file.name)) continue;

          try {
            const content = await readFileContent(token, file.id);
            if (!looksLikeDidCard(file.name, content)) continue;

            const partName = partNameFromFileName(file.name);
            const health = evaluateCardHealth(partName, content, label);
            healthResults.push(health);
          } catch (e) {
            console.warn(`[health] Failed to read ${file.name}:`, e);
          }
        }
      }
    }

    console.log(`[health] Audited ${healthResults.length} cards`);

    // Save to DB via service role client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Upsert health records
    for (const h of healthResults) {
      const { error } = await sb.from("did_kartoteka_health").upsert({
        user_id: userId,
        part_name: h.partName,
        health_score: h.healthScore,
        missing_sections: h.missingSections,
        stale_sections: h.staleSections,
        stub_sections: h.stubSections,
        total_sections: 13,
        filled_sections: h.filledSections,
        folder_label: h.folderLabel,
        last_checked: new Date().toISOString(),
      }, { onConflict: "user_id,part_name" });

      if (error) console.warn(`[health] DB upsert failed for ${h.partName}:`, error.message);
    }

    // Auto-generate tasks for cards with health < 50%
    const criticalCards = healthResults.filter(h => h.healthScore < 50 && h.folderLabel === "AKTIVNÍ");
    let tasksCreated = 0;

    for (const card of criticalCards) {
      // Pick top 2 missing sections to create tasks for
      const sectionsToFill = card.missingSections.slice(0, 2);
      for (const section of sectionsToFill) {
        const taskText = `Doplnit ${section} u karty ${card.partName}`;

        // Check if task already exists (dedup by text hash)
        const { data: existing } = await sb.from("did_therapist_tasks")
          .select("id")
          .eq("user_id", userId)
          .ilike("task", `%${card.partName}%`)
          .ilike("task", `%${section.split(" – ")[0]}%`)
          .neq("status", "done")
          .limit(1);

        if (existing && existing.length > 0) continue;

        const { error } = await sb.from("did_therapist_tasks").insert({
          user_id: userId,
          task: taskText,
          assigned_to: "both",
          category: "kartoteka",
          priority: card.healthScore < 30 ? "high" : "normal",
          source_agreement: "Automatický audit kartotéky",
          note: `Health score: ${card.healthScore}%. Chybějící sekce: ${card.missingSections.join(", ")}`,
        });

        if (!error) tasksCreated++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      cardsAudited: healthResults.length,
      tasksCreated,
      results: healthResults.sort((a, b) => a.healthScore - b.healthScore),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[health] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
