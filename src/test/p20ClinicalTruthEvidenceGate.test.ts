/**
 * P20.2 — Clinical truth evidence gate
 *
 * Lock the regression seen in incident 2026-05-04:
 *   ARTHUR měl 3.5. pouze pending automaticky vygenerovaný plán
 *   → briefing tvrdil "Sezení s ARTHUR bylo otevřené nebo částečně rozpracované".
 *
 * After P20.2: pending_generated_plan must NEVER produce any started-claim phrase
 * in visible text, and `sanitizeStartedClaimText` must rewrite any such phrase
 * into the truthful "existoval pouze návrh / nebyl schválen ani spuštěn".
 */

import { describe, it, expect } from "vitest";
import {
  classifyClinicalActivityEvidence,
  detectEvidenceGuardViolations,
  sanitizeStartedClaimText,
  computeLastRealSession,
} from "../../supabase/functions/_shared/clinicalActivityEvidence.ts";

describe("P20.2 clinical truth evidence gate", () => {
  it("ARTHUR pending plan only → category=pending_generated_plan, no started claim", () => {
    const ev = classifyClinicalActivityEvidence({
      session_reviews: [],
      part_sessions: [],
      live_progress: [],
      plans: [{
        id: "674c8881-b52a-446c-ad9b-2f5fe830b6c6",
        selected_part: "ARTHUR",
        status: "pending",
        lifecycle_status: "planned",
        program_status: "draft",
        generated_by: "analyst_loop",
      }],
    });
    expect(ev.category).toBe("pending_generated_plan");
    expect(ev.can_claim_started).toBe(false);
    expect(ev.can_claim_clinical_input).toBe(false);
  });

  it("approved plan without start → no started claim", () => {
    const ev = classifyClinicalActivityEvidence({
      plans: [{ selected_part: "ARTHUR", program_status: "approved", approved_at: "2026-05-03T08:00:00Z" }],
    });
    expect(ev.category).toBe("approved_plan_not_started");
    expect(ev.can_claim_started).toBe(false);
  });

  it("started live session → started claim allowed, but not clinical input", () => {
    const ev = classifyClinicalActivityEvidence({
      part_sessions: [{ part_name: "Gustík", session_date: "2026-04-30" }],
    });
    expect(ev.category).toBe("started_session");
    expect(ev.can_claim_started).toBe(true);
    expect(ev.can_claim_clinical_input).toBe(false);
  });

  it("completed review → clinical input claim allowed", () => {
    const ev = classifyClinicalActivityEvidence({
      session_reviews: [{ status: "analyzed", part_name: "Gustík", session_date: "2026-04-30" }],
    });
    expect(ev.category).toBe("completed_session");
    expect(ev.can_claim_clinical_input).toBe(true);
  });

  it("incident text with ARTHUR + pending evidence → guard reports violations", () => {
    const ev = classifyClinicalActivityEvidence({
      plans: [{ selected_part: "ARTHUR", status: "pending", lifecycle_status: "planned", program_status: "draft" }],
    });
    const incidentText =
      "Dnešní přehled navazuje hlavně na včerejší otevřené Sezení s ARTHUR z 3. 5. 2026. " +
      "Sezení s ARTHUR bylo otevřené nebo částečně rozpracované a čeká na plné dovyhodnocení; " +
      "neoznačuji ho jako neproběhlé. Práce byla zahájená, ale klinický vstup ještě není uzavřený.";
    const violations = detectEvidenceGuardViolations(incidentText, ev);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => /otevřené Sezení|otevřené nebo částečně|práce byla zahájen|klinický vstup|neoznačuji/.test(v.phrase))).toBe(true);
  });

  it("sanitizeStartedClaimText rewrites the incident sentence into truthful pending text", () => {
    const ev = classifyClinicalActivityEvidence({
      plans: [{ selected_part: "ARTHUR", status: "pending", lifecycle_status: "planned", program_status: "draft" }],
    });
    const incidentText =
      "Dobré ráno. Sezení s ARTHUR bylo otevřené nebo částečně rozpracované a čeká na plné dovyhodnocení. " +
      "Drží se klidný rytmus.";
    const cleaned = sanitizeStartedClaimText(incidentText, ev, "ARTHUR");
    // Truthful replacement appears
    expect(cleaned).toMatch(/automaticky vygenerovaný návrh/);
    expect(cleaned).toMatch(/nebyl schválen ani spuštěn/);
    // All forbidden phrases gone
    expect(cleaned).not.toMatch(/otevřené nebo částečně rozpracované/);
    expect(cleaned).not.toMatch(/čeká na plné dovyhodnocení/);
    // Re-running the guard returns no violations
    expect(detectEvidenceGuardViolations(cleaned, ev).length).toBe(0);
  });

  it("computeLastRealSession returns Gustík as last real session, ignoring pending ARTHUR plan", () => {
    const last = computeLastRealSession({
      session_reviews: [{ status: "analyzed", part_name: "Gustík", session_date: "2026-04-30" }],
      part_sessions: [],
      live_progress: [],
    });
    expect(last.found).toBe(true);
    expect(last.part_name).toBe("Gustík");
    expect(last.session_date).toBe("2026-04-30");
    expect(last.evidence_source).toBe("session_review");
  });

  it("no DID activity at all → category=no_activity, all claims forbidden", () => {
    const ev = classifyClinicalActivityEvidence({});
    expect(ev.category).toBe("no_activity");
    expect(ev.can_claim_started).toBe(false);
    expect(ev.can_claim_clinical_input).toBe(false);
  });
});
