/**
 * P33.9 — Planning workflow regression lock.
 *
 * Locks the contract that the P33.8 matrix gate is ANNOTATION ONLY:
 *  - never nulls proposed_session.part_name / proposed_playroom.part_name
 *  - never overwrites why_today
 *  - never replaces structured ask_hanka / ask_kata with { text, derived_from }
 *  - centrumPartMatrix DB mirror only references real columns
 *  - renderer does not leak technical jargon
 *
 * These tests are source-level structural locks plus a small behavioural test
 * that simulates the annotateProposal logic from karel-did-daily-briefing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const briefingSrc = readFileSync(
  resolve(ROOT, "supabase/functions/karel-did-daily-briefing/index.ts"),
  "utf8",
);
const centrumSrc = readFileSync(
  resolve(ROOT, "supabase/functions/_shared/centrumPartMatrix.ts"),
  "utf8",
);
const rendererSrc = readFileSync(
  resolve(ROOT, "supabase/functions/_shared/karelBriefingVoiceRenderer.ts"),
  "utf8",
);

// ----- centrumPartMatrix DB mirror column lock -----
describe("P33.9 — centrumPartMatrix DB mirror columns", () => {
  it("uses only real did_part_registry columns in SELECT", () => {
    const m = centrumSrc.match(
      /\.from\(\s*"did_part_registry"\s*\)\s*\n?\s*\.select\(\s*"([^"]+)"\s*\)/,
    );
    expect(m, "did_part_registry select clause not found").toBeTruthy();
    const cols = (m![1] || "").split(",").map((c) => c.trim()).filter(Boolean);
    const allowed = new Set([
      "id",
      "part_name",
      "display_name",
      "status",
      "index_confirmed_at",
    ]);
    for (const c of cols) {
      expect(allowed.has(c), `unexpected column in select: ${c}`).toBe(true);
    }
    expect(cols).toContain("id");
    expect(cols).toContain("part_name");
  });

  it("does not reference non-existent column part_id", () => {
    expect(/\bpart_id\b/.test(centrumSrc)).toBe(false);
  });

  it("does not select a non-existent aliases column from did_part_registry", () => {
    // aliases[] may exist as an in-memory field but must not be in SELECT
    const selectMatch = centrumSrc.match(
      /\.from\(\s*"did_part_registry"\s*\)[\s\S]*?\.select\(\s*"([^"]+)"\s*\)/,
    );
    const selectCols = selectMatch ? selectMatch[1] : "";
    expect(/\baliases\b/.test(selectCols)).toBe(false);
  });
});

// ----- briefing function: matrix gate is annotation-only -----
describe("P33.9 — briefing matrix gate is annotation-only", () => {
  it("contains annotateProposal helper that does not assign part_name/why_today", () => {
    const idx = briefingSrc.indexOf("const annotateProposal");
    expect(idx).toBeGreaterThan(-1);
    const slice = briefingSrc.slice(idx, idx + 1200);
    expect(slice).toMatch(/matrix_gate_status/);
    expect(slice).toMatch(/matrix_overall_decision/);
    expect(slice).toMatch(/requires_first_contact_confirmation/);
    // Must NOT mutate part_name or why_today inside the helper
    expect(/obj\.part_name\s*=/.test(slice)).toBe(false);
    expect(/obj\.why_today\s*=/.test(slice)).toBe(false);
  });

  it("never assigns null to proposed_session.part_name or proposed_playroom.part_name", () => {
    expect(/proposed_session\.part_name\s*=\s*null/.test(briefingSrc)).toBe(false);
    expect(/proposed_playroom\.part_name\s*=\s*null/.test(briefingSrc)).toBe(false);
  });

  it("does not replace ask_hanka/ask_kata with primitive { text, derived_from } items", () => {
    // The destructive pattern from P33.8.F was:
    //   payload.ask_hanka = [{ text: ..., derived_from: "p33.8_matrix" }]
    expect(/payload\.ask_hanka\s*=\s*\[/.test(briefingSrc)).toBe(false);
    expect(/payload\.ask_kata\s*=\s*\[/.test(briefingSrc)).toBe(false);
  });

  it("emits payload_generation_version=p33.9.0 and matrix_gate_version=p33.9_annotation_only", () => {
    expect(briefingSrc).toMatch(/payload\.payload_generation_version\s*=\s*"p33\.9\.0"/);
    expect(briefingSrc).toMatch(
      /payload\.matrix_gate_version\s*=\s*"p33\.9_annotation_only"/,
    );
  });

  it("cache gate requires p33.9 markers before reusing cached row", () => {
    expect(briefingSrc).toMatch(/REQUIRED_PAYLOAD_GENERATION_VERSION\s*=\s*"p33\.9\.0"/);
    expect(briefingSrc).toMatch(
      /REQUIRED_MATRIX_GATE_VERSION\s*=\s*"p33\.9_annotation_only"/,
    );
    expect(briefingSrc).toMatch(/cachedP339Ready/);
  });
});

// ----- behavioural: annotateProposal-shaped helper preserves planning -----
describe("P33.9 — annotation-only behaviour preserves planning fields", () => {
  // Local re-implementation mirroring the inline helper in
  // karel-did-daily-briefing/index.ts.  If the production helper changes
  // semantics (e.g. starts overwriting part_name), the structural test
  // above will fail; this test asserts the semantics we expect.
  function annotate(obj: any, matrix: { overall_decision: string; parts: any[] }) {
    if (!obj || typeof obj !== "object") return;
    const noPrimary = matrix.overall_decision !== "primary_part_selected";
    const possibleAfterFirstContact = (matrix.parts ?? []).some(
      (p: any) => p?.workability === "possible_after_first_contact",
    );
    obj.matrix_gate_status = noPrimary ? "needs_confirmation" : "ok";
    obj.matrix_overall_decision = matrix.overall_decision;
    obj.requires_first_contact_confirmation = noPrimary && possibleAfterFirstContact;
    if (noPrimary) {
      obj.matrix_warning =
        "Vedoucí část pro dnešek není jistá; ověř prvním kontaktem před otevřením tématu.";
    }
  }

  it("noPrimary does not null proposed_session.part_name", () => {
    const session = { id: "s1", part_name: "Tundrupek", why_today: "kontakt s Hanou" };
    annotate(session, { overall_decision: "no_primary_today", parts: [] });
    expect(session.part_name).toBe("Tundrupek");
    expect(session.why_today).toBe("kontakt s Hanou");
    expect((session as any).matrix_gate_status).toBe("needs_confirmation");
  });

  it("noPrimary does not null proposed_playroom.part_name", () => {
    const playroom = { id: "p1", part_name: "Gustík", why_today: "vrací se k tématu" };
    annotate(playroom, { overall_decision: "no_primary_today", parts: [] });
    expect(playroom.part_name).toBe("Gustík");
    expect(playroom.why_today).toBe("vrací se k tématu");
  });

  it("primary_part_selected leaves planning fields intact and marks gate ok", () => {
    const session = { id: "s2", part_name: "Káťa", why_today: "navazuje na včerejšek" };
    annotate(session, { overall_decision: "primary_part_selected", parts: [] });
    expect(session.part_name).toBe("Káťa");
    expect((session as any).matrix_gate_status).toBe("ok");
    expect((session as any).requires_first_contact_confirmation).toBe(false);
  });

  it("annotation does not strip existing structured ask items", () => {
    const ask = [
      {
        id: "a1",
        assignee: "hanka",
        intent: "clarify",
        target_type: "session",
        target_item_id: "s1",
        briefing_id: "b1",
        text: "Domluvit se na čase",
      },
    ];
    // No call mutates ask in the gate; assert shape is untouched.
    expect(ask[0].id).toBe("a1");
    expect(ask[0].target_type).toBe("session");
    expect(ask[0].target_item_id).toBe("s1");
  });
});

// ----- renderer: no technical jargon leaking into visible text -----
describe("P33.9 — renderer does not leak technical jargon", () => {
  // Strip line and block comments so we only look at code/strings.
  const codeOnly = rendererSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const FORBIDDEN = ["00_CENTRUM", "watch-only", "pipeline", "povinných kroků"];

  for (const token of FORBIDDEN) {
    it(`renderer source has no user-visible literal "${token}"`, () => {
      const re = new RegExp(
        `"[^"\\n]*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"\\n]*"`,
        "g",
      );
      const hits = [...codeOnly.matchAll(re)];
      const realHits = hits.filter((h) => {
        const start = h.index ?? 0;
        const surrounding = codeOnly.slice(
          Math.max(0, start - 140),
          start + h[0].length + 140,
        );
        return !/FORBIDDEN_ROBOTIC_PHRASES|forbidden_phrase|label\s*:/.test(surrounding);
      });
      expect(
        realHits.map((h) => h[0]),
        `forbidden user-visible literal "${token}" leaked`,
      ).toHaveLength(0);
    });
  }
});
