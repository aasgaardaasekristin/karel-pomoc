import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "npm:xlsx@0.18.5";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Part Detect – Unified identity resolver
 * 
 * Checks BOTH did_part_registry (DB) AND Drive Excel registry.
 * Uses Levenshtein distance for robust fuzzy matching.
 * 
 * Input: { name: string }
 * Output: { matched, partName, displayName, source, matchScore, registry?, profile?, driveEntry? }
 */

// ── Levenshtein distance ──
function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[la][lb];
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
}

function scoreName(input: string, candidate: string): number {
  if (!input || !candidate) return 0;
  if (input === candidate) return 100;
  if (input.includes(candidate) || candidate.includes(input)) return 80;

  // Levenshtein — allow edit distance ≤ 2 for names ≥ 4 chars
  const shorter = Math.min(input.length, candidate.length);
  if (shorter >= 3) {
    const dist = levenshtein(input, candidate);
    if (dist === 0) return 100;
    if (dist === 1) return 90;
    if (dist === 2 && shorter >= 4) return 75;
  }

  // Prefix overlap (≥ 3 chars)
  if (input.length >= 3 && candidate.length >= 3) {
    if (input.slice(0, 3) === candidate.slice(0, 3)) return 60;
  }

  return 0;
}

// ── Drive helpers ──
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLS_MIME_SET = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

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

async function findKartotekaRoot(token: string): Promise<string | null> {
  const variants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];
  for (const name of variants) {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.files?.[0]?.id) return data.files[0].id;
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

interface DriveRegistryEntry {
  id: string;
  name: string;
  normalizedName: string;
  status: string;
}

async function loadDriveRegistryEntries(token: string): Promise<DriveRegistryEntry[]> {
  const rootId = await findKartotekaRoot(token);
  if (!rootId) return [];

  const rootFiles = await listFilesInFolder(token, rootId);
  const centrumFolder = rootFiles.find(f => f.mimeType === "application/vnd.google-apps.folder" && (/^00/.test(f.name) || normalize(f.name).includes("centrum")));
  if (!centrumFolder) return [];

  const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
  const registryFile = centrumFiles
    .filter(f => f.mimeType === DRIVE_SHEET_MIME || XLS_MIME_SET.has(f.mimeType || "") || /\.xlsx?$/i.test(f.name))
    .sort((a, b) => {
      const aN = normalize(a.name), bN = normalize(b.name);
      const aS = aN.includes("index") ? 10 : 0;
      const bS = bN.includes("index") ? 10 : 0;
      return bS - aS;
    })[0];

  if (!registryFile) return [];

  try {
    let workbook: XLSX.WorkBook;
    if (registryFile.mimeType === DRIVE_SHEET_MIME) {
      const exportRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!exportRes.ok) return [];
      workbook = XLSX.read(await exportRes.text(), { type: "string" });
    } else {
      const mediaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${registryFile.id}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!mediaRes.ok) return [];
      workbook = XLSX.read(new Uint8Array(await mediaRes.arrayBuffer()), { type: "array" });
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return [];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, raw: false, defval: "" }) as any[][];

    // Find header row
    const nonEmpty = rows.filter(r => r.some(c => `${c ?? ""}`.trim().length > 0));
    let headerIdx = nonEmpty.findIndex((row, idx) => {
      if (idx > 10) return false;
      const norm = row.map((c: any) => normalize(String(c)));
      return norm.some(c => ["id", "cislo", "number"].some(v => c.includes(v)))
        && norm.some(c => ["jmeno", "nazev", "cast", "part", "fragment"].some(v => c.includes(v)));
    });
    if (headerIdx < 0) headerIdx = 0;

    const header = nonEmpty[headerIdx].map((c: any) => normalize(String(c)));
    const findCol = (hints: string[], fallback: number) => {
      const idx = header.findIndex((h: string) => hints.some(hint => h.includes(hint)));
      return idx >= 0 ? idx : fallback;
    };

    const idCol = findCol(["id", "cislo", "number"], 0);
    const nameCol = findCol(["jmeno", "nazev", "cast", "part", "fragment"], 1);
    const statusCol = findCol(["stav", "status"], 3);

    const entries: DriveRegistryEntry[] = [];
    for (const row of nonEmpty.slice(headerIdx + 1)) {
      const rawName = String(row[nameCol] ?? "").trim();
      if (!rawName) continue;
      const rawId = String(row[idCol] ?? "").trim();
      const idMatch = rawId.match(/\d{1,4}/);
      entries.push({
        id: idMatch ? idMatch[0].padStart(3, "0") : "",
        name: rawName,
        normalizedName: normalize(rawName),
        status: String(row[statusCol] ?? "").trim(),
      });
    }
    return entries;
  } catch (e) {
    console.error("[part-detect] Drive registry read error:", e);
    return [];
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { name } = await req.json();
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "Missing name" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const inputNorm = normalize(name);
    if (!inputNorm) {
      return new Response(JSON.stringify({ matched: false, partName: name, displayName: name, source: "new" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── 1. Search DB registry ──
    const { data: registry } = await supabase
      .from("did_part_registry")
      .select("part_name, display_name, status, age_estimate, language, known_triggers, known_strengths, role_in_system, cluster, last_emotional_state")
      .eq("user_id", user.id);

    let bestDbMatch: any = null;
    let bestDbScore = 0;

    for (const row of (registry || [])) {
      const names = [row.part_name, row.display_name].filter(Boolean);
      for (const n of names) {
        const score = scoreName(inputNorm, normalize(n));
        if (score > bestDbScore) {
          bestDbScore = score;
          bestDbMatch = row;
        }
      }
    }

    // ── 2. Search Drive Excel registry (parallel-safe: errors don't block) ──
    let bestDriveMatch: DriveRegistryEntry | null = null;
    let bestDriveScore = 0;
    let driveEntries: DriveRegistryEntry[] = [];

    try {
      const driveToken = await getAccessToken();
      driveEntries = await loadDriveRegistryEntries(driveToken);
      for (const entry of driveEntries) {
        const score = scoreName(inputNorm, entry.normalizedName);
        if (score > bestDriveScore) {
          bestDriveScore = score;
          bestDriveMatch = entry;
        }
      }
    } catch (e) {
      console.warn("[part-detect] Drive lookup failed (non-blocking):", e.message);
    }

    // ── 3. Decide best match ──
    const MATCH_THRESHOLD = 60;
    const dbOk = bestDbMatch && bestDbScore >= MATCH_THRESHOLD;
    const driveOk = bestDriveMatch && bestDriveScore >= MATCH_THRESHOLD;

    if (dbOk || driveOk) {
      // Prefer DB match if scores are close, otherwise take the highest
      const useDb = dbOk && (!driveOk || bestDbScore >= bestDriveScore);
      const canonicalPartName = useDb ? bestDbMatch.part_name : bestDriveMatch!.name;
      const displayName = useDb ? (bestDbMatch.display_name || bestDbMatch.part_name) : bestDriveMatch!.name;
      const source = dbOk && driveOk ? "both" : dbOk ? "db" : "drive";
      const finalScore = Math.max(bestDbScore, bestDriveScore);

      // Load profile if DB match
      let profile = null;
      if (useDb) {
        const { data: p } = await supabase
          .from("did_part_profiles")
          .select("*")
          .eq("user_id", user.id)
          .eq("part_name", bestDbMatch.part_name)
          .maybeSingle();
        profile = p;
      }

      return new Response(JSON.stringify({
        matched: true,
        partName: canonicalPartName,
        displayName,
        source,
        matchScore: finalScore,
        registry: useDb ? bestDbMatch : null,
        driveEntry: driveOk ? { id: bestDriveMatch!.id, name: bestDriveMatch!.name, status: bestDriveMatch!.status } : null,
        profile,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // No match
    return new Response(JSON.stringify({
      matched: false,
      partName: name.trim(),
      displayName: name.trim(),
      source: "new",
      matchScore: Math.max(bestDbScore, bestDriveScore),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Part detect error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
