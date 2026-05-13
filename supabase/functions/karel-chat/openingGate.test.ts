// P33.11 STEP 2 (revised) — Opening Gate decision contract tests.
// Pure helpers: decision, hard guards, anti-stall, status mapping.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideOpeningGateNextPhase,
  applyHardGuards,
  applyAntiStall,
  checkInStatus,
  detectExplicitSignals,
  OPENING_TURN_LIMIT,
  type OpeningGateOutput,
} from "./openingGate.ts";

const base = (): OpeningGateOutput => ({
  child_present: true,
  probable_match: "yes",
  baseline: "ready",
  can_start_program_now: true,
  attune_text: "x",
  next_micro_step: "",
  soft_close_text: "",
  reason: "test",
});

// ─── original decision contract ──────────────────────────────
Deno.test("READY → program", () => {
  assertEquals(decideOpeningGateNextPhase(base()).phase, "program");
});
Deno.test("baseline=fragile → stabilization (first time)", () => {
  const g = { ...base(), baseline: "fragile" as const, can_start_program_now: false };
  assertEquals(decideOpeningGateNextPhase(g, 0).phase, "stabilization");
});
Deno.test("baseline=fragile + 2 prior stabilize → soft_close (anti-loop)", () => {
  const g = { ...base(), baseline: "fragile" as const, can_start_program_now: false };
  assertEquals(decideOpeningGateNextPhase(g, 2).phase, "soft_close");
});
Deno.test("baseline=unsafe → soft_close even if can_start=true", () => {
  assertEquals(decideOpeningGateNextPhase({ ...base(), baseline: "unsafe" as const }).phase, "soft_close");
});
Deno.test("probable_match=no → soft_close", () => {
  assertEquals(decideOpeningGateNextPhase({ ...base(), probable_match: "no" as const }).phase, "soft_close");
});
Deno.test("probable_match=unclear blocks program", () => {
  assertEquals(decideOpeningGateNextPhase({ ...base(), probable_match: "unclear" as const }).phase, "checkin");
});
Deno.test("can_start=false + ready → checkin", () => {
  assertEquals(decideOpeningGateNextPhase({ ...base(), can_start_program_now: false }).phase, "checkin");
});
Deno.test("child_present=false → never program", () => {
  assertEquals(decideOpeningGateNextPhase({ ...base(), child_present: false }).phase, "checkin");
});

// ─── FIX #2/#3: deterministic hard guards ─────────────────────
Deno.test("hard guard: 'bojím se' downgrades even if AI says ready/can_start=true", () => {
  const g = applyHardGuards(base(), "bojím se");
  assertEquals(g.can_start_program_now, false);
  assertEquals(g.baseline, "fragile");
  assertEquals(decideOpeningGateNextPhase(g).phase, "stabilization");
});
Deno.test("hard guard: 'mám strach' triggers fear guard", () => {
  const g = applyHardGuards(base(), "mám strach z toho");
  assertEquals(g.can_start_program_now, false);
});
Deno.test("hard guard: 'nechci' blocks program", () => {
  const g = applyHardGuards(base(), "nechci");
  assertEquals(g.can_start_program_now, false);
  assert(decideOpeningGateNextPhase(g).phase !== "program");
});
Deno.test("hard guard: willingness alone NOT enough — needs gate=ready+can_start", () => {
  // AI gate said NOT ready/can_start but child wrote "jo můžeme"
  const raw: OpeningGateOutput = { ...base(), baseline: "fragile", can_start_program_now: false };
  const g = applyHardGuards(raw, "jo, můžeme");
  // Hard guards must NOT upgrade. can_start stays false.
  assertEquals(g.can_start_program_now, false);
  assert(decideOpeningGateNextPhase(g).phase !== "program");
});
Deno.test("hard guard: short turn (<=3 tokens) downgrades probable_match yes → unclear", () => {
  const g = applyHardGuards(base(), "ahoj");
  assertEquals(g.probable_match, "unclear");
  assertEquals(g.can_start_program_now, false);
  assertEquals(decideOpeningGateNextPhase(g).phase, "checkin");
});
Deno.test("hard guard: probable_match unclear forces can_start=false", () => {
  const raw: OpeningGateOutput = { ...base(), probable_match: "unclear" as const, can_start_program_now: true };
  const g = applyHardGuards(raw, "tohle je delší věta s několika slovy");
  assertEquals(g.can_start_program_now, false);
});

// ─── FIX #4: anti-stall guard ─────────────────────────────────
Deno.test("anti-stall: under limit → no change", () => {
  const d = { phase: "checkin" as const, reason: "x" };
  assertEquals(applyAntiStall(d, 0, "ready").phase, "checkin");
  assertEquals(applyAntiStall(d, OPENING_TURN_LIMIT - 2, "ready").phase, "checkin");
});
Deno.test("anti-stall: at limit + ready → soft_close (no bottomless probing)", () => {
  const d = { phase: "checkin" as const, reason: "x" };
  assertEquals(applyAntiStall(d, OPENING_TURN_LIMIT - 1, "ready").phase, "soft_close");
});
Deno.test("anti-stall: at limit + fragile → stabilization", () => {
  const d = { phase: "checkin" as const, reason: "x" };
  assertEquals(applyAntiStall(d, OPENING_TURN_LIMIT - 1, "fragile").phase, "stabilization");
});
Deno.test("anti-stall: at limit + unsafe → soft_close", () => {
  const d = { phase: "checkin" as const, reason: "x" };
  assertEquals(applyAntiStall(d, OPENING_TURN_LIMIT - 1, "unsafe").phase, "soft_close");
});
Deno.test("anti-stall: never escalates non-checkin decisions", () => {
  const d = { phase: "program" as const, reason: "x" };
  assertEquals(applyAntiStall(d, 99, "ready").phase, "program");
});

// ─── FIX #5: simplified status ────────────────────────────────
Deno.test("checkInStatus: program → READY", () => {
  assertEquals(checkInStatus({ phase: "program", reason: "" }, base()), "READY");
});
Deno.test("checkInStatus: stabilization → FRAGILE", () => {
  assertEquals(checkInStatus({ phase: "stabilization", reason: "" }, { ...base(), baseline: "fragile" }), "FRAGILE");
});
Deno.test("checkInStatus: soft_close (unsafe) → UNSAFE", () => {
  assertEquals(checkInStatus({ phase: "soft_close", reason: "" }, { ...base(), baseline: "unsafe" }), "UNSAFE");
});
Deno.test("checkInStatus: checkin → PROBING", () => {
  assertEquals(checkInStatus({ phase: "checkin", reason: "" }, base()), "PROBING");
});

// ─── signal regex spot-checks ─────────────────────────────────
Deno.test("regex: fear signals", () => {
  assert(detectExplicitSignals("bojím se").fear);
  assert(detectExplicitSignals("Bojím se moc").fear);
  assert(detectExplicitSignals("mám strach").fear);
});
Deno.test("regex: refusal signals", () => {
  assert(detectExplicitSignals("nechci").refusal);
  assert(detectExplicitSignals("Nechci to dělat").refusal);
});
Deno.test("regex: willing signals", () => {
  assert(detectExplicitSignals("jo, můžeme").willing);
  assert(detectExplicitSignals("chci").willing);
});
