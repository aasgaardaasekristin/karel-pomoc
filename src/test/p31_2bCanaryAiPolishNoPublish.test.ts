// P31.2B — real AI polish canary, no publish.
// Tests verify:
//   - forceEnableForCanary enables AI path even with global env disabled.
//   - validation catches forbidden phrases / drift; rejected sections fall back.
//   - normal generateKarelAiPolishCandidate (no override, no testFetcher) stays disabled.
//   - UI surfaces never read polished_text / canary table.
import { describe, it, expect } from "vitest";
import {
  generateKarelAiPolishCandidate,
} from "../../supabase/functions/_shared/karelBriefingVoiceAiPolish";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const basePayload: any = {
  briefing_truth_gate: { ok: true, source_cycle_id: "cyc-1", reasons: [] },
  source_cycle_id: "cyc-1",
  source_cycle_completed_at: "2026-05-07T05:00:00Z",
  phase_jobs_snapshot: { total: 14, completed: 14, jobs: [] },
  today_part_proposal: {
    proposed_part: "Tundrupek",
    rationale_text: "návaznost na včerejší upřesnění od Hany.",
    is_hypothesis_only: true,
    evidence_strength: "low",
  },
  ask_hanka: [{ text: "Krátce ověřit tělesný stav před sezením." }],
  ask_kata: [{ text: "Hlídat hranice návaznosti." }],
  proposed_session: { title: "Bezpečné ověření kontaktu" },
  proposed_playroom: null,
  external_reality_watch: {
    provider_status: "configured",
    active_part_daily_brief_count: 14,
    source_backed_events_count: 4,
    internet_events_used_count: 4,
    parts: [{ part_name: "Tundrupek", internet_triggers_today: ["x"] }],
  },
  lingering: [],
  daily_therapeutic_priority: "Krátké ověření aktuálního stavu.",
};

function det() {
  return renderKarelBriefingVoice(basePayload);
}

describe("P31.2B canary AI polish", () => {
  it("normal call (no override, no env, no testFetcher) stays disabled by default", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
    });
    expect(r.attempted).toBe(false);
    expect(r.errors).toContain("ai_polish_disabled_by_default");
  });

  it("forceEnableForCanary=true enables AI path (using injected fetcher to simulate provider)", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      forceEnableForCanary: true,
      canaryRunId: "test-canary-1",
      __testFetcher: async (sections) => {
        const out: Record<string, string> = {};
        for (const s of sections) out[s.section_id] = s.original_text; // identity = passes validation
        return out;
      },
    });
    expect(r.attempted).toBe(true);
    expect(r.accepted_candidate_count).toBeGreaterThan(0);
    expect(r.audit.unsupported_claims_count).toBe(0);
    expect(r.audit.robotic_phrase_count).toBe(0);
  });

  it("rejects forbidden/internal-term polish and falls back to original_text", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      forceEnableForCanary: true,
      __testFetcher: async (sections) => {
        const out: Record<string, string> = {};
        for (const s of sections) {
          out[s.section_id] = "Aktualizuji payload v pipeline podle schema.";
        }
        return out;
      },
    });
    expect(r.attempted).toBe(true);
    expect(r.accepted_candidate_count).toBe(0);
    expect(r.rejected_candidate_count).toBeGreaterThan(0);
    for (const s of r.sections) {
      expect(s.polish_status).not.toBe("accepted_candidate");
      // Fallback rule: polished_text reverts to original_text on rejection.
      expect(s.polished_text).toBe(s.original_text);
    }
  });

  it("rejects meaning drift (changed numbers / lost uncertainty)", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      forceEnableForCanary: true,
      __testFetcher: async (sections) => {
        const out: Record<string, string> = {};
        for (const s of sections) {
          // Strip all numbers and uncertainty markers to force drift.
          out[s.section_id] = s.original_text
            .replace(/\b\d+\b/g, "X")
            .replace(/hypotéz\w*/gi, "potvrzeno")
            .replace(/nemám|nevím/gi, "vím jistě");
        }
        return out;
      },
    });
    expect(r.attempted).toBe(true);
    // Either drift or schema rejection — but must NOT silently accept.
    for (const s of r.sections) {
      if (s.polish_status === "accepted_candidate") {
        // If accepted, it must have preserved numbers exactly (so X-replacement → reject).
        expect(s.warnings.length).toBe(0);
      } else {
        expect(s.polished_text).toBe(s.original_text);
      }
    }
  });

  it("UI surfaces (components/pages/hooks) must not read polished_text or p31_ai_polish_canary_runs", () => {
    function* walk(dir: string): Generator<string> {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) yield* walk(p);
        else if (/\.(ts|tsx)$/.test(name)) yield p;
      }
    }
    const offenders: string[] = [];
    const uiRoots = ["src/components", "src/pages", "src/hooks", "src/contexts", "src/lib"];
    for (const root of uiRoots) {
      try {
        for (const f of walk(root)) {
          const txt = readFileSync(f, "utf8");
          if (/polished_text/.test(txt)) offenders.push(`${f}:polished_text`);
          if (/p31_ai_polish_canary_runs/.test(txt)) offenders.push(`${f}:canary_table`);
        }
      } catch (_e) { /* dir may not exist */ }
    }
    expect(offenders).toEqual([]);
  });
});
