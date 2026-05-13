// P33.11 STEP 2 — Opening Gate decision contract tests.
// Pure helper: maps gate output → next phase. No AI, no network.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideOpeningGateNextPhase, type OpeningGateOutput } from "./openingGate.ts";

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

Deno.test("READY → program", () => {
  const d = decideOpeningGateNextPhase(base());
  assertEquals(d.phase, "program");
});

Deno.test("baseline=fragile → stabilization (first time)", () => {
  const g = { ...base(), baseline: "fragile" as const, can_start_program_now: false };
  const d = decideOpeningGateNextPhase(g, 0);
  assertEquals(d.phase, "stabilization");
});

Deno.test("baseline=fragile + 2 prior stabilize → soft_close (anti-loop)", () => {
  const g = { ...base(), baseline: "fragile" as const, can_start_program_now: false };
  const d = decideOpeningGateNextPhase(g, 2);
  assertEquals(d.phase, "soft_close");
});

Deno.test("baseline=unsafe → soft_close even if can_start=true", () => {
  const g = { ...base(), baseline: "unsafe" as const };
  const d = decideOpeningGateNextPhase(g);
  assertEquals(d.phase, "soft_close");
});

Deno.test("probable_match=no → soft_close (mismatch / no contact)", () => {
  const g = { ...base(), probable_match: "no" as const };
  const d = decideOpeningGateNextPhase(g);
  assertEquals(d.phase, "soft_close");
});

Deno.test("probable_match=unclear blocks program even if baseline=ready", () => {
  const g = { ...base(), probable_match: "unclear" as const };
  const d = decideOpeningGateNextPhase(g);
  // unclear + ready + can_start=true → still NOT program; stays in checkin
  assertEquals(d.phase, "checkin");
});

Deno.test("can_start=false + ready → checkin (multi-turn opening gate)", () => {
  const g = { ...base(), can_start_program_now: false };
  const d = decideOpeningGateNextPhase(g);
  assertEquals(d.phase, "checkin");
});

Deno.test("child_present=false → never program", () => {
  const g = { ...base(), child_present: false };
  const d = decideOpeningGateNextPhase(g);
  assertEquals(d.phase, "checkin");
});
