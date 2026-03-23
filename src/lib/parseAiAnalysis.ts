/**
 * Parses raw AI analysis (often stored as JSON.stringify'd object)
 * and returns clean, human-readable markdown text.
 * Falls back to human-readable plain text, never raw technical JSON blobs.
 */

function decodeJsonLikeString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractStringField(source: string, field: string): string {
  const match = source.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  return match ? decodeJsonLikeString(match[1]).trim() : "";
}

function extractStringArray(source: string, field: string): string[] {
  const blockMatch = source.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "s"));
  if (!blockMatch) return [];
  const values = [...blockMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => decodeJsonLikeString(m[1]).trim()).filter(Boolean);
  return values;
}

function extractObjectArrayPairs(source: string, field: string, titleKey: string, bodyKey: string): string[] {
  const blockMatch = source.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "s"));
  if (!blockMatch) return [];

  const objectMatches = [...blockMatch[1].matchAll(/\{([\s\S]*?)\}/g)];
  return objectMatches
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

  return parts.join("\n\n").trim();
}

/**
 * Parses raw AI analysis (often stored as JSON.stringify'd object)
 * and returns clean, human-readable markdown text.
 * Falls back to the original string if parsing fails.
 */
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
    // Handle double-stringified JSON
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    try {
      parsed = JSON.parse(raw);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
    } catch {
      const recovered = fallbackFromMalformedJson(stripped);
      if (recovered) return recovered;

      const looksLikeTechnicalJson = /"summary"\s*:|"analysis"\s*:|"diagnosticHypothesis"\s*:|^\s*\{[\s\S]*\}\s*$/.test(stripped);
      if (looksLikeTechnicalJson) return "Analýza není k dispozici";

      return raw;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return raw;

  const rec = parsed.sessionRecord && typeof parsed.sessionRecord === "object"
    ? parsed.sessionRecord
    : parsed;

  const parts: string[] = [];

  if (rec.summary) {
    parts.push(String(rec.summary).replace(/\\n/g, "\n"));
  }
  if (rec.analysis) {
    parts.push("## Analýza\n" + String(rec.analysis).replace(/\\n/g, "\n"));
  }
  if (rec.diagnosticHypothesis?.hypothesis) {
    const h = rec.diagnosticHypothesis;
    const conf = h.confidence === "high" ? "vysoká" : h.confidence === "medium" ? "střední" : h.confidence === "low" ? "nízká" : "";
    parts.push(
      `## Diagnostická hypotéza${conf ? ` (${conf} jistota)` : ""}\n${h.hypothesis}`
    );
  }
  if (Array.isArray(rec.therapeuticRecommendations) && rec.therapeuticRecommendations.length) {
    parts.push(
      "## Doporučení\n" +
      rec.therapeuticRecommendations
        .map((r: any) => `- **${r.approach || r.name || ""}**: ${r.reason || r.description || ""}`)
        .join("\n")
    );
  }
  if (Array.isArray(rec.nextSessionFocus) && rec.nextSessionFocus.length) {
    parts.push(
      "## Zaměření příštího sezení\n" +
      rec.nextSessionFocus.map((f: any) => `- ${typeof f === "string" ? f : f.focus || JSON.stringify(f)}`).join("\n")
    );
  }
  if (Array.isArray(rec.clientTasks) && rec.clientTasks.length) {
    parts.push(
      "## Úkoly pro klienta\n" +
      rec.clientTasks.map((t: any) => `- ${typeof t === "string" ? t : t.task || t.description || JSON.stringify(t)}`).join("\n")
    );
  }

  if (parts.length > 0) return parts.join("\n\n");

  const recovered = fallbackFromMalformedJson(stripped);
  if (recovered) return recovered;

  return "Analýza není k dispozici";
}
