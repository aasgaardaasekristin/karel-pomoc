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

  return parts.length > 0 ? parts.join("\n\n") : raw;
}
