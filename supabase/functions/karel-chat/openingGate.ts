// P33.11 STEP 2 — Pure helpers for the opening-gate decision contract.
// Kept in its own file so unit tests can load it without pulling the whole
// karel-chat edge entry point.

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

export type CheckInStatus = "PROBING" | "READY" | "FRAGILE" | "UNSAFE";

// Hard limit on opening turns before we must escalate (no bottomless check-in).
export const OPENING_TURN_LIMIT = 4;

// Deterministic Czech-language signal patterns. Conservative on purpose:
// only match unambiguous tokens, not soft inferences.
export const FEAR_REGEX =
  /\b(boj[ií]m\s*se|m[áa]m\s+strach|strach[uy]?|panik\w*|d[ěe]s[íi]m\s*se|hr[uů]za|nem[áa]m\s+s[íi]lu)\b/iu;
export const REFUSAL_REGEX =
  /\b(nechci|necht[ěe]l(?:a)?\s+bych|nebudu|nejdu|odejdu|odch[áa]z[íi]m|nech\s+m[ěe]|d[ěe]j\s+mi\s+pokoj|ne\.?$)\b/iu;
export const WILLING_REGEX =
  /\b(jo|ano|m[ůu][žz]eme|chci|jdeme|jdu\s+do\s+toho|jsem\s+ready|pojďme|pojď|hotov[áy]|tak\s+jo)\b/iu;

export function detectExplicitSignals(lastInput: string): {
  fear: boolean;
  refusal: boolean;
  willing: boolean;
} {
  const text = String(lastInput || "");
  return {
    fear: FEAR_REGEX.test(text),
    refusal: REFUSAL_REGEX.test(text),
    willing: WILLING_REGEX.test(text),
  };
}

/**
 * Hard deterministic guards. AI gate output may be DOWNGRADED here, never
 * upgraded. Willingness alone is not enough to start program — the gate must
 * already say ready/yes/can_start.
 */
export function applyHardGuards(
  gate: OpeningGateOutput,
  lastInput: string,
): OpeningGateOutput {
  const sig = detectExplicitSignals(lastInput);
  const out: OpeningGateOutput = { ...gate };
  const reasons: string[] = [];
  if (sig.fear) {
    out.can_start_program_now = false;
    if (out.baseline === "ready") out.baseline = "fragile";
    reasons.push("hard_guard:fear");
  }
  if (sig.refusal) {
    out.can_start_program_now = false;
    if (out.baseline === "ready") out.baseline = "fragile";
    reasons.push("hard_guard:refusal");
  }
  // Conservative identity: do NOT trust strong "yes" match from a single short
  // turn. If the message is very short (≤3 tokens) and no clear context yet,
  // downgrade probable_match yes → unclear.
  const tokens = String(lastInput || "").trim().split(/\s+/).filter(Boolean);
  if (out.probable_match === "yes" && tokens.length <= 3) {
    out.probable_match = "unclear";
    reasons.push("hard_guard:identity_inference_too_thin");
  }
  // Contact must be jasný — if probable_match is no/unclear, never start.
  if (out.probable_match !== "yes") {
    out.can_start_program_now = false;
  }
  if (reasons.length) {
    out.reason = (out.reason ? out.reason + " | " : "") + reasons.join(",");
  }
  return out;
}

/**
 * Pure mapping gate output → next phase.
 *
 * Contract (P33.11 STEP 2, revised):
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

/**
 * Anti-stall: opening must not loop forever in `checkin`. After
 * OPENING_TURN_LIMIT opening turns we force an escalation.
 *  - if baseline ready (but unclear/can_start=false) → soft_close (no bottomless probing)
 *  - if baseline unsafe                              → soft_close
 *  - else                                            → stabilization
 */
export function applyAntiStall(
  decision: OpeningGateDecision,
  openingTurnCount: number,
  baseline: OpeningGateOutput["baseline"],
): OpeningGateDecision {
  if (decision.phase !== "checkin") return decision;
  // openingTurnCount is the count BEFORE this turn; this turn would be N+1.
  if (openingTurnCount + 1 >= OPENING_TURN_LIMIT) {
    if (baseline === "unsafe") {
      return { phase: "soft_close", reason: `anti_stall: opening_turn_count>=${OPENING_TURN_LIMIT} (unsafe) → soft close` };
    }
    if (baseline === "ready") {
      return { phase: "soft_close", reason: `anti_stall: opening_turn_count>=${OPENING_TURN_LIMIT} (no conclusion) → soft close` };
    }
    return { phase: "stabilization", reason: `anti_stall: opening_turn_count>=${OPENING_TURN_LIMIT} → stabilization` };
  }
  return decision;
}

/**
 * UI-facing simplified status. Detailed gate JSON belongs in audit only.
 */
export function checkInStatus(
  decision: OpeningGateDecision,
  gate: OpeningGateOutput,
): CheckInStatus {
  if (decision.phase === "program") return "READY";
  if (gate.baseline === "unsafe" || decision.phase === "soft_close") return "UNSAFE";
  if (gate.baseline === "fragile" || decision.phase === "stabilization") return "FRAGILE";
  return "PROBING";
}
