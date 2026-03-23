/**
 * Parses raw AI analysis (often stored as JSON.stringify'd object)
 * and returns clean, human-readable markdown text.
 * Never returns raw JSON blobs — always formatted markdown or fallback message.
 */

/** Clean residual escape sequences and formatting artefacts from text */
function cleanText(val: any): string {
  if (val == null) return "";
  let s = String(val);
  // Unescape common residual escapes (double-escaped after JSON.parse)
  s = s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    // Remove stray single backslashes before letters (e.g. \K, \N)
    .replace(/\\([a-zA-ZěščřžýáíéůúďťňĚŠČŘŽÝÁÍÉŮÚĎŤŇ])/g, "$1");
  return s.trim();
}

function decodeJsonLikeString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return cleanText(value);
  }
}

function extractStringField(source: string, field: string): string {
  const match = source.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  return match ? cleanText(decodeJsonLikeString(match[1])) : "";
}

function extractStringArray(source: string, field: string): string[] {
  const blockMatch = source.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "s"));
  if (!blockMatch) return [];
  return [...blockMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((m) => cleanText(decodeJsonLikeString(m[1])))
    .filter(Boolean);
}

function extractObjectArrayPairs(source: string, field: string, titleKey: string, bodyKey: string): string[] {
  const blockMatch = source.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "s"));
  if (!blockMatch) return [];

  return [...blockMatch[1].matchAll(/\{([\s\S]*?)\}/g)]
    .map((obj) => {
      const title = extractStringField(obj[0], titleKey);
      const body = extractStringField(obj[0], bodyKey);
      if (!title && !body) return "";
      return `- **${title || "Doporučení"}**: ${body}`.trim();
    })
    .filter(Boolean);
}

function fallbackFromMalformedJson(source: string): string {
  const summary = extractStringField(source, "summary");
  const analysis = extractStringField(source, "analysis");
  const hypothesis = extractStringField(source, "hypothesis");
  const confidence = extractStringField(source, "confidence");
  const nextSessionFocus = extractStringArray(source, "nextSessionFocus");
  const clientTasks = extractStringArray(source, "clientTasks");
  const missingData = extractStringArray(source, "missingData");
  const recommendations = extractObjectArrayPairs(source, "therapeuticRecommendations", "approach", "reason");

  const parts: string[] = [];

  if (summary) parts.push(summary);
  if (analysis) parts.push(`## Analýza\n${analysis}`);
  if (hypothesis) {
    const conf = confidence === "high" ? "vysoká" : confidence === "medium" ? "střední" : confidence === "low" ? "nízká" : "";
    parts.push(`## Diagnostická hypotéza${conf ? ` (${conf} jistota)` : ""}\n${hypothesis}`);
  }
  if (recommendations.length) parts.push(`## Doporučení\n${recommendations.join("\n")}`);
  if (nextSessionFocus.length) parts.push(`## Zaměření příštího sezení\n${nextSessionFocus.map((item) => `- ${item}`).join("\n")}`);
  if (clientTasks.length) parts.push(`## Úkoly pro klienta\n${clientTasks.map((item) => `- ${item}`).join("\n")}`);
  if (missingData.length) parts.push(`## Chybějící data\n${missingData.map((item) => `- ${item}`).join("\n")}`);

  return parts.join("\n\n").trim();
}

export function parseAiAnalysis(raw: string | null | undefined): string {
  if (!raw?.trim()) return "";

  // Strip markdown code-block wrappers
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    try {
      parsed = JSON.parse(raw);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
    } catch {
      // Try extracting JSON object from mixed text
      const firstBrace = stripped.indexOf("{");
      const lastBrace = stripped.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
        } catch {
          // Fall through to regex fallback
        }
      }

      if (!parsed) {
        const recovered = fallbackFromMalformedJson(stripped);
        if (recovered) return recovered;

        const looksLikeTechnicalJson = /"summary"\s*:|"analysis"\s*:|"diagnosticHypothesis"\s*:|"transcription"\s*:|^\s*\{[\s\S]*\}\s*$/.test(stripped);
        if (looksLikeTechnicalJson) return "Analýza není k dispozici";

        return cleanText(raw);
      }
    }
  }

  if (typeof parsed !== "object" || parsed === null) return cleanText(raw);

  const rec = parsed.sessionRecord && typeof parsed.sessionRecord === "object"
    ? parsed.sessionRecord
    : parsed;

  const parts: string[] = [];

  if (rec.summary) {
    parts.push(cleanText(rec.summary));
  }
  if (rec.analysis) {
    parts.push("## Analýza\n" + cleanText(rec.analysis));
  }
  if (rec.diagnosticHypothesis?.hypothesis) {
    const h = rec.diagnosticHypothesis;
    const conf = h.confidence === "high" ? "vysoká" : h.confidence === "medium" ? "střední" : h.confidence === "low" ? "nízká" : "";
    parts.push(
      `## Diagnostická hypotéza${conf ? ` (${conf} jistota)` : ""}\n${cleanText(h.hypothesis)}`
    );
    if (Array.isArray(h.missingData) && h.missingData.length) {
      parts.push("## Chybějící data\n" + h.missingData.map((d: any) => `- ${cleanText(d)}`).join("\n"));
    }
  }
  if (Array.isArray(rec.therapeuticRecommendations) && rec.therapeuticRecommendations.length) {
    parts.push(
      "## Doporučení\n" +
      rec.therapeuticRecommendations
        .map((r: any) => `- **${cleanText(r.approach || r.name)}**: ${cleanText(r.reason || r.description)}`)
        .join("\n")
    );
  }
  if (Array.isArray(rec.nextSessionFocus) && rec.nextSessionFocus.length) {
    parts.push(
      "## Zaměření příštího sezení\n" +
      rec.nextSessionFocus.map((f: any) => `- ${typeof f === "string" ? cleanText(f) : cleanText(f.focus) || cleanText(JSON.stringify(f))}`).join("\n")
    );
  }
  if (Array.isArray(rec.clientTasks) && rec.clientTasks.length) {
    parts.push(
      "## Úkoly pro klienta\n" +
      rec.clientTasks.map((t: any) => `- ${typeof t === "string" ? cleanText(t) : cleanText(t.task || t.description) || cleanText(JSON.stringify(t))}`).join("\n")
    );
  }

  if (parts.length > 0) return parts.join("\n\n");

  // Parsed object but no recognized fields — try regex fallback
  const recovered = fallbackFromMalformedJson(stripped);
  if (recovered) return recovered;

  return "Analýza není k dispozici";
}
