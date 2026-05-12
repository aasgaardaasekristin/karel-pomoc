/**
 * P33.8.B — 00_CENTRUM part matrix reader.
 *
 * Reads the part registry from KARTOTEKA_DID/00_CENTRUM/01_INDEX (Drive primary)
 * and falls back to did_part_registry mirror (marked as `profile_fallback`).
 *
 * Hard rules:
 *  - Hana / Hanka / Hanička / Karel / Káťa / Kata are NEVER returned.
 *  - Missing CENTRUM ≠ inventing parts; returns read_status=`missing` with []
 *    when neither Drive nor DB mirror is available.
 *  - `display_name` strips `001_/002_` etc. for presentation only.
 *  - `registry_status` is normalized to `active|dormant|sleeping|unknown`.
 */

// Inlined to avoid pulling driveRegistry's xlsx URL import into the TS graph
// when this module is referenced from src/test (vitest, jsdom).
function normalize(s: string): string {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
}
const NON_DID_NORMALIZED = new Set(["hanicka", "hanka", "hana", "kata", "katka", "kaca", "karel"]);
function isNonDidEntity(name: string): boolean {
  return NON_DID_NORMALIZED.has(normalize(name));
}

// deno-lint-ignore no-explicit-any
type SB = any;

export type CentrumReadStatus =
  | "drive_primary"
  | "profile_fallback"
  | "missing";

export type CentrumRegistryStatus = "active" | "dormant" | "sleeping" | "unknown";

export interface CentrumPartRow {
  id: string;
  canonical_name: string;
  display_name: string;
  aliases: string[];
  registry_status: CentrumRegistryStatus;
  raw_status: string;
  source: "drive_index" | "db_mirror";
  index_confirmed_at?: string | null;
  last_seen_at?: string | null;
  updated_at?: string | null;
}

export interface CentrumPartMatrix {
  version: "p33.8";
  source: CentrumReadStatus;
  read_status: CentrumReadStatus;
  date_prague: string;
  rows: CentrumPartRow[];
  warnings: string[];
}

const TECHNICAL_PREFIX_RE = /^00[0-9]_/;

function toDisplay(name: string): string {
  const stripped = String(name || "").trim().replace(TECHNICAL_PREFIX_RE, "").trim();
  if (!stripped) return "";
  return stripped.charAt(0).toLocaleUpperCase("cs") + stripped.slice(1);
}

function normalizeStatus(raw: string): CentrumRegistryStatus {
  const n = normalize(raw || "");
  if (!n) return "unknown";
  if (n.includes("aktiv") || n === "active") return "active";
  if (n.includes("dorman") || n.includes("utlumen")) return "dormant";
  if (n.includes("sleep") || n.includes("spi") || n.includes("usnul") || n.includes("uzavren") || n.includes("inactiv")) return "sleeping";
  return "unknown";
}

function isExcluded(name: string): boolean {
  return isNonDidEntity(name);
}

export interface LoadCentrumInput {
  userId: string;
  datePrague: string;
  driveToken?: string | null;
}

export async function loadCentrumPartMatrix(
  sb: SB,
  input: LoadCentrumInput,
): Promise<CentrumPartMatrix> {
  const warnings: string[] = [];
  const matrix: CentrumPartMatrix = {
    version: "p33.8",
    source: "missing",
    read_status: "missing",
    date_prague: input.datePrague,
    rows: [],
    warnings,
  };

  // 1) Try Drive primary (01_INDEX in 00_CENTRUM/)
  if (input.driveToken) {
    try {
      // Dynamic import keeps driveRegistry's URL imports out of the test TS graph.
      const mod: any = await import("./driveRegistry.ts" as string);
      const driveEntries = await mod.loadDriveRegistryEntries(input.driveToken);
      if (driveEntries.length > 0) {
        for (const e of driveEntries) {
          if (isExcluded(e.primaryName)) continue;
          const display = toDisplay(e.primaryName);
          if (!display) continue;
          matrix.rows.push({
            id: e.id || display,
            canonical_name: e.primaryName,
            display_name: display,
            aliases: e.aliases.filter((a) => !isExcluded(a)),
            registry_status: normalizeStatus(e.status),
            raw_status: e.status || "",
            source: "drive_index",
          });
        }
        matrix.source = "drive_primary";
        matrix.read_status = "drive_primary";
        return matrix;
      } else {
        warnings.push("drive_index_returned_zero_entries");
      }
    } catch (err) {
      warnings.push(`drive_index_failed:${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  } else {
    warnings.push("no_drive_token");
  }

  // 2) Fallback to DB mirror — explicitly marked as profile_fallback.
  // P33.10: did_part_registry has no `part_id` and no `aliases` columns.
  // Use real columns and keep provenance dates so stale mirror state cannot masquerade as today's activity.
  try {
    const { data, error } = await sb
      .from("did_part_registry")
      .select("id, part_name, display_name, status, index_confirmed_at, last_seen_at, updated_at")
      .eq("user_id", input.userId)
      .limit(200);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      const name = String(r?.part_name ?? "").trim();
      if (!name) continue;
      if (isExcluded(name)) continue;
      const displaySource = String(r?.display_name ?? "").trim() || name;
      const display = toDisplay(displaySource);
      if (!display) continue;
      if (isExcluded(display)) continue;
      matrix.rows.push({
        id: String(r?.id ?? display),
        canonical_name: name,
        display_name: display,
        aliases: [],
        registry_status: normalizeStatus(String(r?.status ?? "")),
        raw_status: String(r?.status ?? ""),
        source: "db_mirror",
        index_confirmed_at: r?.index_confirmed_at ?? null,
        last_seen_at: r?.last_seen_at ?? null,
        updated_at: r?.updated_at ?? null,
      });
    }
    if (matrix.rows.length > 0) {
      matrix.source = "profile_fallback";
      matrix.read_status = "profile_fallback";
      return matrix;
    }
    warnings.push("db_mirror_empty");
  } catch (err) {
    warnings.push(`db_mirror_failed:${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }

  // 3) Neither available: controlled missing
  matrix.source = "missing";
  matrix.read_status = "missing";
  return matrix;
}
