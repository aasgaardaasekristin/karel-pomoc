/**
 * Shared Drive Registry utilities for DID part identity resolution.
 * Parses Column B format: "CANONICAL_NAME (ALIAS1, ALIAS2, ...)"
 */

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

// ── Text normalization ──
export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
}

// ── Non-DID entity filter (therapists, not parts) ──
const NON_DID_NORMALIZED = new Set([
  "hanicka", "hanka", "hana",
  "kata", "katka", "kaca",
]);

export function isNonDidEntity(name: string): boolean {
  return NON_DID_NORMALIZED.has(normalize(name));
}

// ── Parse "PRIMARY (ALIAS1, ALIAS2)" format from Column B ──
export function parseAliases(raw: string): { primary: string; aliases: string[] } {
  const trimmed = raw.trim();
  const m = trimmed.match(/^([^(]+?)(?:\s*\(([^)]+)\))?$/);
  if (!m) return { primary: trimmed, aliases: [] };
  const primary = m[1].trim();
  const aliases = m[2]
    ? m[2].split(/[,;]+/).map(a => a.trim()).filter(Boolean)
    : [];
  return { primary, aliases };
}

// ── Levenshtein distance ──
export function levenshtein(a: string, b: string): number {
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

// ── Score input against a single candidate (both already normalized) ──
// Supports partial/substring matching for alias resolution
export function scoreName(input: string, candidate: string): number {
  if (!input || !candidate) return 0;
  if (input === candidate) return 100;
  const shorter = Math.min(input.length, candidate.length);
  const longer = Math.max(input.length, candidate.length);
  if ((input.includes(candidate) || candidate.includes(input)) && shorter / longer >= 0.7) return 80;
  if (shorter >= 3) {
    const dist = levenshtein(input, candidate);
    if (dist === 0) return 100;
    if (dist === 1) return 90;
    if (dist === 2 && shorter >= 4) return 75;
    if (dist === 3 && shorter >= 6) return 65;
  }

  if (input.length >= 4 && candidate.length >= 4) {
    if (input.slice(0, 4) === candidate.slice(0, 4)) return 55;
  }

  return 0;
}

// ── Drive Registry Entry ──
export interface DriveRegistryEntry {
  id: string;
  /** Canonical (primary) name from Column B */
  primaryName: string;
  /** Raw cell value */
  rawName: string;
  /** Normalized primary name */
  normalizedName: string;
  /** Parsed aliases from parentheses */
  aliases: string[];
  /** Normalized aliases */
  normalizedAliases: string[];
  status: string;
}

// ── Drive helpers ──
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLS_MIME_SET = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export async function findKartotekaRoot(token: string): Promise<string | null> {
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

/**
 * Load Drive registry entries.
 *
 * FIX 1.6 (2026-05-17) — new canonical layout in Drive `01_INDEX`:
 *   A=#, B=Jméno (kanonické), C=Aliasy (comma-separated),
 *   D=Status (CZ), E=Status (DB), F=Klastr, G=Role, H=Poznámka
 * Reads `part_name` from B, `aliases` from C (split on comma),
 * `status` from E (Status DB). Sheet tab resolution: primary "Index",
 * fallback first sheet. Old "PRIMARY (ALIAS1)" format is no longer expected.
 */
export async function loadDriveRegistryEntries(token: string): Promise<DriveRegistryEntry[]> {
  const rootId = await findKartotekaRoot(token);
  if (!rootId) return [];

  const rootFiles = await listFilesInFolder(token, rootId);
  const centrumFolder = rootFiles.find(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    (/^00/.test(f.name) || normalize(f.name).includes("centrum"))
  );
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
    let rows: any[][] = [];

    if (registryFile.mimeType === DRIVE_SHEET_MIME) {
      // FIX 1.6: Use Sheets API to pick the "Index" tab (or fall back to first).
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}?fields=sheets.properties(title,sheetId)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!metaRes.ok) {
        console.warn(`[FIX 1.6] sheets metadata fetch failed (${metaRes.status}), falling back to CSV export of first sheet`);
        const exportRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!exportRes.ok) return [];
        const wb = XLSX.read(await exportRes.text(), { type: "string" });
        const first = wb.SheetNames[0];
        rows = first ? (XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, raw: false, defval: "" }) as any[][]) : [];
      } else {
        const meta = await metaRes.json();
        const sheets: Array<{ properties?: { title?: string } }> = meta?.sheets ?? [];
        let target = sheets.find(s => s.properties?.title === "Index");
        if (!target && sheets.length > 0) {
          target = sheets[0];
          console.warn(`[FIX 1.6] Sheet 'Index' not found, falling back to first sheet '${target.properties?.title}'`);
        }
        if (!target?.properties?.title) {
          console.error(`[FIX 1.6] No sheets found in spreadsheet ${registryFile.id}`);
          return [];
        }
        const title = target.properties.title;
        console.log(`[FIX 1.6] Using sheet '${title}' from spreadsheet ${registryFile.id}`);
        const valuesRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}/values/${encodeURIComponent(title)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!valuesRes.ok) {
          console.error(`[FIX 1.6] sheets values fetch failed: ${valuesRes.status}`);
          return [];
        }
        const valuesData = await valuesRes.json();
        rows = (valuesData?.values ?? []) as any[][];
      }
    } else {
      const mediaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${registryFile.id}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!mediaRes.ok) return [];
      const wb = XLSX.read(new Uint8Array(await mediaRes.arrayBuffer()), { type: "array" });
      const first = wb.SheetNames[0];
      if (!first) return [];
      rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, raw: false, defval: "" }) as any[][];
    }

    const nonEmpty = rows.filter(r => Array.isArray(r) && r.some(c => `${c ?? ""}`.trim().length > 0));
    if (nonEmpty.length === 0) return [];

    // FIX 1.6: New layout has fixed columns A..H. Detect header row by checking
    // for 'jmeno'/'name' in column B (index 1). Default to row 0 as header.
    let headerIdx = nonEmpty.findIndex((row, idx) => {
      if (idx > 5) return false;
      const b = normalize(String(row[1] ?? ""));
      return ["jmeno", "name", "cast", "fragment"].some(h => b.includes(h));
    });
    if (headerIdx < 0) headerIdx = 0;

    // Fixed column indexes per FIX 1.6 brief.
    const ID_COL = 0;
    const NAME_COL = 1;     // B — Jméno (kanonické)
    const ALIAS_COL = 2;    // C — Aliasy (comma-separated)
    const STATUS_COL = 4;   // E — Status (DB)

    const entries: DriveRegistryEntry[] = [];
    for (const row of nonEmpty.slice(headerIdx + 1)) {
      const rawName = String(row[NAME_COL] ?? "").trim();
      if (!rawName) continue;

      const rawId = String(row[ID_COL] ?? "").trim();
      const idMatch = rawId.match(/\d{1,4}/);

      const aliasCell = String(row[ALIAS_COL] ?? "").trim();
      const aliases = aliasCell
        ? aliasCell.split(/[,;]+/).map(a => a.trim()).filter(Boolean)
        : [];

      const status = String(row[STATUS_COL] ?? "").trim();

      entries.push({
        id: idMatch ? idMatch[0].padStart(3, "0") : "",
        primaryName: rawName,
        rawName,
        normalizedName: normalize(rawName),
        aliases,
        normalizedAliases: aliases.map(normalize),
        status,
      });
    }
    // Filter out non-DID entities (therapists)
    return entries.filter(e => !isNonDidEntity(e.primaryName));
  } catch (e) {
    console.error("[driveRegistry] Drive registry read error:", e);
    return [];
  }
}

/**
 * Score an input against a DriveRegistryEntry, checking primary name AND each alias individually.
 * Returns the best score found.
 */
export function scoreEntryMatch(inputNorm: string, entry: DriveRegistryEntry): number {
  // Check primary name
  let best = scoreName(inputNorm, entry.normalizedName);

  // Check each alias individually
  for (const aliasNorm of entry.normalizedAliases) {
    const s = scoreName(inputNorm, aliasNorm);
    if (s > best) best = s;
  }

  return best;
}

/**
 * Build a human-readable alias map string for context injection.
 * E.g.: "ARTHUR = ARTUR, ARTÍK\nDMYTRI = DYMI, DYMKO"
 */
export function buildAliasMapText(entries: DriveRegistryEntry[]): string {
  return entries
    .filter(e => e.aliases.length > 0)
    .map(e => `${e.primaryName} = ${e.aliases.join(", ")}`)
    .join("\n");
}

/**
 * Build a full alias lookup: normalized alias → canonical primary name
 */
export function buildAliasLookup(entries: DriveRegistryEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.normalizedName, entry.primaryName);
    for (const aliasNorm of entry.normalizedAliases) {
      map.set(aliasNorm, entry.primaryName);
    }
  }
  return map;
}
