/**
 * Bezpečný JSON parser pro AI výstupy.
 * Zvládne: markdown code blocks, trailing commas, komentáře, BOM, prázdné odpovědi, částečný JSON.
 */

export interface ParseResult<T = any> {
  success: boolean;
  data: T | null;
  raw: string;
  error?: string;
  cleaned?: string;
  method?: string;
}

export function safeJsonParse<T = any>(
  raw: string | null | undefined,
  fallback?: T
): ParseResult<T> {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    return { success: false, data: fallback || null, raw: raw || "", error: "empty_input", method: "none" };
  }

  let cleaned = raw.trim();

  // Remove BOM
  if (cleaned.charCodeAt(0) === 0xFEFF) cleaned = cleaned.slice(1);

  // Remove markdown code blocks
  cleaned = cleaned.replace(/^```json?\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  // Try direct parse (fastest path)
  try {
    return { success: true, data: JSON.parse(cleaned) as T, raw, cleaned, method: "direct" };
  } catch { /* continue */ }

  // Extract JSON object/array from text
  const jsonStart = cleaned.indexOf("{");
  const jsonArrayStart = cleaned.indexOf("[");
  let start = -1, end = -1;

  if (jsonStart === -1 && jsonArrayStart === -1) {
    return { success: false, data: fallback || null, raw, error: "no_json_found", method: "none" };
  }

  if (jsonArrayStart !== -1 && (jsonStart === -1 || jsonArrayStart < jsonStart)) {
    start = jsonArrayStart;
    end = cleaned.lastIndexOf("]");
  } else {
    start = jsonStart;
    end = cleaned.lastIndexOf("}");
  }

  if (start === -1 || end === -1 || end <= start) {
    return { success: false, data: fallback || null, raw, error: "incomplete_json", method: "none" };
  }

  let extracted = cleaned.slice(start, end + 1);

  // Try parse extracted
  try {
    return { success: true, data: JSON.parse(extracted) as T, raw, cleaned: extracted, method: "extracted" };
  } catch { /* continue */ }

  // Remove comments and trailing commas
  extracted = extracted.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([\]}])/g, "$1");

  try {
    return { success: true, data: JSON.parse(extracted) as T, raw, cleaned: extracted, method: "cleaned" };
  } catch { /* continue */ }

  // Last resort: fix single quotes and unquoted keys
  try {
    const lastResort = extracted.replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":').replace(/,\s*([\]}])/g, "$1");
    return { success: true, data: JSON.parse(lastResort) as T, raw, cleaned: lastResort, method: "last_resort" };
  } catch (finalErr) {
    return {
      success: false, data: fallback || null, raw, cleaned: extracted,
      error: `parse_failed: ${finalErr instanceof Error ? finalErr.message : String(finalErr)}`,
      method: "failed",
    };
  }
}

/** Validace že JSON obsahuje požadované klíče. */
export function validateJsonKeys(data: any, requiredKeys: string[]): { valid: boolean; missing: string[] } {
  if (!data || typeof data !== "object") return { valid: false, missing: requiredKeys };
  const missing = requiredKeys.filter(key => !(key in data));
  return { valid: missing.length === 0, missing };
}

/** Sanitizace AI výstupů — ořez příliš dlouhých stringů, polí, a prompt injection. */
export function sanitizeAiOutput(data: any): any {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    let s = data.length > 2000 ? data.slice(0, 2000) + "... (zkráceno)" : data;
    return s.replace(/\[SYSTEM\]/gi, "[SYS]").replace(/\[INST\]/gi, "[INS]").replace(/<\|.*?\|>/g, "");
  }

  if (Array.isArray(data)) return data.slice(0, 50).map(sanitizeAiOutput);

  if (typeof data === "object") {
    const out: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.length > 100) continue;
      out[key] = sanitizeAiOutput(value);
    }
    return out;
  }

  return data;
}
