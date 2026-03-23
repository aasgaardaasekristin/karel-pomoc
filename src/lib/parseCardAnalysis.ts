/**
 * Robust parser for card analysis data (client_analyses.content).
 * Always returns a complete typed object — never raw JSON.
 */

export interface CardAnalysisResult {
  clientProfile: string;
  diagnosticHypothesis: {
    primary: string;
    differential: string[];
    confidence: string;
    supportingEvidence: string[];
    sources: string[];
  };
  therapeuticProgress: {
    whatWorks: string[];
    whatDoesntWork: string[];
    clientDynamics: string;
  };
  nextSessionRecommendations: {
    focus: string[];
    suggestedTechniques: string[];
    diagnosticTests: string[];
    thingsToAsk: string[];
  };
  dataGaps: string[];
}

const EMPTY_RESULT: CardAnalysisResult = {
  clientProfile: "Analýza není k dispozici",
  diagnosticHypothesis: { primary: "", differential: [], confidence: "low", supportingEvidence: [], sources: [] },
  therapeuticProgress: { whatWorks: [], whatDoesntWork: [], clientDynamics: "" },
  nextSessionRecommendations: { focus: [], suggestedTechniques: [], diagnosticTests: [], thingsToAsk: [] },
  dataGaps: [],
};

function tryParseJson(str: string): any | null {
  // Strip markdown fences
  let cleaned = str
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  // Try direct parse
  try {
    const p = JSON.parse(cleaned);
    if (typeof p === "string") return JSON.parse(p); // double-encoded
    return p;
  } catch {}

  // Try extracting JSON object from mixed text
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const sub = cleaned.slice(firstBrace, lastBrace + 1);
      const p = JSON.parse(sub);
      if (typeof p === "string") return JSON.parse(p);
      return p;
    } catch {}
  }

  // Try embedded ```json block
  const embeddedMatch = str.match(/```json\s*([\s\S]*?)```/);
  if (embeddedMatch) {
    try {
      return JSON.parse(embeddedMatch[1].trim());
    } catch {}
  }

  return null;
}

function ensureArray(val: any): string[] {
  if (Array.isArray(val)) return val.map(String);
  return [];
}

function ensureString(val: any, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  return String(val);
}

export function parseCardAnalysis(raw: string | null | undefined): CardAnalysisResult {
  if (!raw?.trim()) return { ...EMPTY_RESULT };

  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { ...EMPTY_RESULT };
  }

  const dh = parsed.diagnosticHypothesis;
  const tp = parsed.therapeuticProgress;
  const nr = parsed.nextSessionRecommendations;

  return {
    clientProfile: ensureString(parsed.clientProfile, "Analýza není k dispozici"),
    diagnosticHypothesis: {
      primary: ensureString(dh?.primary),
      differential: ensureArray(dh?.differential),
      confidence: ensureString(dh?.confidence, "low"),
      supportingEvidence: ensureArray(dh?.supportingEvidence),
      sources: ensureArray(dh?.sources),
    },
    therapeuticProgress: {
      whatWorks: ensureArray(tp?.whatWorks),
      whatDoesntWork: ensureArray(tp?.whatDoesntWork),
      clientDynamics: ensureString(tp?.clientDynamics),
    },
    nextSessionRecommendations: {
      focus: ensureArray(nr?.focus),
      suggestedTechniques: ensureArray(nr?.suggestedTechniques),
      diagnosticTests: ensureArray(nr?.diagnosticTests),
      thingsToAsk: ensureArray(nr?.thingsToAsk),
    },
    dataGaps: ensureArray(parsed.dataGaps),
  };
}
