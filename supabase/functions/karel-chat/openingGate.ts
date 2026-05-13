// P33.11 STEP 2 — Pure helper for the opening-gate decision contract.
// Kept in its own file so unit tests can load it without pulling the whole
// karel-chat edge entry point (which has unrelated TS-strict warnings and
// triggers a serve()).

export type OpeningGateOutput = {
  child_present: boolean;
  probable_match: "yes" | "unclear" | "no";
  baseline: "ready" | "fragile" | "unsafe";
  can_start_program_now: boolean;
  attune_text: string;
  next_micro_step: string;
  soft_close_text: string;
  reason: string;
};

export type OpeningGateDecision = {
  phase: "program" | "stabilization" | "soft_close" | "checkin";
  reason: string;
};

/**
 * Pure mapping gate output → next phase.
 *
 * Contract (P33.11 STEP 2):
 *   - probable_match=no                              → soft_close
 *   - baseline=unsafe                                → soft_close
 *   - can_start_program_now=true AND baseline=ready
 *     AND child_present=true AND probable_match=yes  → program
 *   - baseline=fragile                               → stabilization
 *       (anti-loop: 2 stabilize turns in a row → soft_close)
 *   - else                                           → checkin (multi-turn)
 *
 * Forbidden behaviours encoded by negative tests:
 *   - never advance to program purely because N turns elapsed
 *   - never advance to program when probable_match=unclear
 *   - never advance to program when child_present=false
 */
export function decideOpeningGateNextPhase(
  gate: OpeningGateOutput,
  consecutiveStabilizeCount = 0,
): OpeningGateDecision {
  if (gate.probable_match === "no") {
    return { phase: "soft_close", reason: "probable_match=no → no contact / mismatch" };
  }
  if (gate.baseline === "unsafe") {
    return { phase: "soft_close", reason: "baseline=unsafe → defer / soft close" };
  }
  if (
    gate.can_start_program_now === true &&
    gate.baseline === "ready" &&
    gate.child_present === true &&
    gate.probable_match === "yes"
  ) {
    return { phase: "program", reason: "gate=READY → enter approved program" };
  }
  if (gate.baseline === "fragile") {
    if (consecutiveStabilizeCount >= 2) {
      return { phase: "soft_close", reason: "anti_loop: fragile after 2 stabilize turns → soft close" };
    }
    return { phase: "stabilization", reason: "baseline=fragile → one micro-step, then re-evaluate" };
  }
  return { phase: "checkin", reason: "gate not yet conclusive → stay in opening gate" };
}
