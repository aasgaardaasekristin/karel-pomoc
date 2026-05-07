/**
 * P33.5A — daily analyzer fail-soft tests.
 *
 * We re-implement the canonical helpers here (mirrors of the helpers exported
 * from supabase/functions/karel-did-daily-analyzer/index.ts) so vitest can run
 * them without bringing in Deno-only modules. The shapes/behaviour MUST match
 * the edge function. Source guard test below also asserts that the fatal
 * `throw new Error("AI response missing required fields...")` is gone.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function buildEmptyDailyAnalyzerFallback(input: {
  datePrague: string;
  reason: string;
  validationErrors?: string[];
  rawModelOutputPreview?: string;
}) {
  return {
    date: input.datePrague,
    therapists: {
      Hanka: {
        long_term: { traits: [], style: "", reliability: "", experience_notes: "" },
        situational: { energy: "", health: "", current_stressors: [], notes: "" },
      },
      Kata: {
        long_term: { traits: [], style: "", reliability: "", experience_notes: "" },
        situational: { energy: "", health: "", current_stressors: [], notes: "" },
      },
    },
    parts: [] as any[],
    team_observations: { cooperation: "", warnings: [], praise: [] },
    sessions: [] as any[],
    observations: [] as any[],
    tasks: [] as any[],
    risks: [] as any[],
    recommendations: [] as any[],
    external_context: [] as any[],
    metadata: {
      analyzer_status: "controlled_fallback",
      fallback_used: true,
      fallback_reason: input.reason,
      validation_errors: input.validationErrors ?? [],
      raw_model_output_preview: (input.rawModelOutputPreview || "").slice(0, 500),
      generated_at: new Date().toISOString(),
    },
  };
}

function validateDailyAnalyzerResult(parsed: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!parsed || typeof parsed !== "object") return { ok: false, errors: ["result_not_object"] };
  if (!parsed.date || typeof parsed.date !== "string") errors.push("missing_date");
  if (!parsed.therapists || typeof parsed.therapists !== "object") errors.push("missing_therapists");
  if (parsed.parts === undefined || parsed.parts === null) errors.push("missing_parts");
  else if (!Array.isArray(parsed.parts)) errors.push("parts_not_array");
  return { ok: errors.length === 0, errors };
}

function extractJSON(text: string): any {
  const cleaned = (text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) { try { return JSON.parse(cleaned.slice(first, last + 1)); } catch {} }
  return {};
}

/**
 * Simulates the analyzer's AI-output decision branch:
 * parses, validates, returns either real json or fallback. Never throws.
 */
function analyzerHandleAiOutput(aiResponse: string, today = "2026-05-07") {
  let analysisJson: any = extractJSON(aiResponse);
  const validation = validateDailyAnalyzerResult(analysisJson);
  let fallbackUsed = false;
  let fallbackErrors: string[] = [];
  if (!validation.ok) {
    analysisJson = buildEmptyDailyAnalyzerFallback({
      datePrague: today, reason: "missing_required_fields",
      validationErrors: validation.errors, rawModelOutputPreview: aiResponse,
    });
    fallbackUsed = true;
    fallbackErrors = validation.errors;
  }
  if (analysisJson.parts == null || !Array.isArray(analysisJson.parts)) analysisJson.parts = [];
  if (analysisJson.therapists == null || typeof analysisJson.therapists !== "object") analysisJson.therapists = {};
  return { fallbackUsed, fallbackErrors, analysisJson, httpStatus: 200 };
}

describe("P33.5A daily-analyzer fail-soft", () => {
  it("valid AI JSON passes unchanged (no fallback)", () => {
    const valid = JSON.stringify({
      date: "2026-05-07", therapists: { Hanka: {}, Kata: {} },
      parts: [{ name: "ARTHUR", status: "active" }],
    });
    const r = analyzerHandleAiOutput(valid);
    expect(r.fallbackUsed).toBe(false);
    expect(r.analysisJson.parts).toHaveLength(1);
    expect(r.httpStatus).toBe(200);
  });

  it("invalid JSON returns fallback, not throw", () => {
    const r = analyzerHandleAiOutput("totally not json");
    expect(r.fallbackUsed).toBe(true);
    expect(r.analysisJson.metadata.analyzer_status).toBe("controlled_fallback");
  });

  it("truncated JSON returns fallback", () => {
    const r = analyzerHandleAiOutput('{"date":"2026-05-07","therapists":{"Hanka"');
    expect(r.fallbackUsed).toBe(true);
  });

  it("missing date returns fallback", () => {
    const r = analyzerHandleAiOutput(JSON.stringify({ therapists: {}, parts: [] }));
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackErrors).toContain("missing_date");
  });

  it("missing therapists returns fallback", () => {
    const r = analyzerHandleAiOutput(JSON.stringify({ date: "2026-05-07", parts: [] }));
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackErrors).toContain("missing_therapists");
  });

  it("missing parts returns fallback", () => {
    const r = analyzerHandleAiOutput(JSON.stringify({ date: "2026-05-07", therapists: {} }));
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackErrors).toContain("missing_parts");
  });

  it("therapists=null returns fallback with therapists={}", () => {
    const r = analyzerHandleAiOutput(JSON.stringify({ date: "2026-05-07", therapists: null, parts: [] }));
    expect(r.fallbackUsed).toBe(true);
    expect(typeof r.analysisJson.therapists).toBe("object");
  });

  it("parts=null returns fallback with parts=[]", () => {
    const r = analyzerHandleAiOutput(JSON.stringify({ date: "2026-05-07", therapists: {}, parts: null }));
    expect(r.fallbackUsed).toBe(true);
    expect(Array.isArray(r.analysisJson.parts)).toBe(true);
  });

  it("fallback contains all downstream required fields", () => {
    const f = buildEmptyDailyAnalyzerFallback({ datePrague: "2026-05-07", reason: "x" });
    expect(f).toHaveProperty("date");
    expect(f).toHaveProperty("therapists");
    expect(f).toHaveProperty("parts");
    expect(f).toHaveProperty("sessions");
    expect(f).toHaveProperty("observations");
    expect(f).toHaveProperty("tasks");
    expect(f).toHaveProperty("risks");
    expect(f).toHaveProperty("recommendations");
    expect(f).toHaveProperty("external_context");
  });

  it("fallback includes audit metadata", () => {
    const f = buildEmptyDailyAnalyzerFallback({
      datePrague: "2026-05-07", reason: "missing_required_fields", validationErrors: ["missing_date"],
    });
    expect(f.metadata.fallback_used).toBe(true);
    expect(f.metadata.fallback_reason).toBe("missing_required_fields");
    expect(f.metadata.validation_errors).toContain("missing_date");
    expect(f.metadata.analyzer_status).toBe("controlled_fallback");
  });

  it("fallback does not invent parts or therapists content", () => {
    const f = buildEmptyDailyAnalyzerFallback({ datePrague: "2026-05-07", reason: "x" });
    expect(f.parts).toHaveLength(0);
    expect(f.therapists.Hanka.long_term.traits).toHaveLength(0);
    expect(f.therapists.Kata.long_term.traits).toHaveLength(0);
  });

  it("source guard: fatal throw 'AI response missing required fields' removed from analyzer", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "supabase/functions/karel-did-daily-analyzer/index.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/throw\s+new\s+Error\(\s*["']AI response missing required fields/);
    // And canonical helpers exist:
    expect(src).toMatch(/buildEmptyDailyAnalyzerFallback/);
    expect(src).toMatch(/validateDailyAnalyzerResult/);
    // Fail-soft branch present
    expect(src).toMatch(/controlled_fallback/);
  });
});
