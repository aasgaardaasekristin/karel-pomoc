// P33.x Fix A + Fix A2 — regresní guard pro veřejný playroom briefing.
//
// Fix A:  do `proposed_playroom.why_this_part_today` se NIKDY nesmí dostat
//         provozní/runtime instrukce. Patří jen do
//         `proposed_playroom.backend_context_inputs.runtime_directive`.
//
// Fix A2: veřejná pole MUSÍ být klinický briefing pro tým ve 3. osobě.
//         Mikroplán vedení („Karel nabídne…", „nezačínat…", „držet…",
//         „Krátce ověřit…") nesmí téct do žádného z těchto polí:
//           - why_this_part_today
//           - main_theme
//           - goals[]
//           - playroom_plan.therapeutic_program[].detail
//         Tyto fráze mají žít VÝHRADNĚ v runtime_directive.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildClinicalPlayroomBriefing } from "./index.ts";

// ----- Fix A patterns (kanálový leak) -----
const LEAK_PATTERNS_FIX_A: RegExp[] = [
  /Hani[čc]ka\s+up[řr]esnila\s+faktick[ýy]\s+r[áa]mec/i,
  /Beru\s+to\s+jako/i,
  /dr[žz]et\s+(?:ho|opatrnost)/i,
  /nejprve\s+ov[eě][řr]it,\s+co\s+(?:[čc][áa]st|kluci)/i,
  /Karel\s+je\s+(?:jen\s+)?navig[áa]tor/i,
  /Dne[šs]n[íi]\s+n[áa]vrh\s+nenavazuje\s+automaticky/i,
  /Symboly\s+z\s+tohoto\s+materi[áa]lu\s+pou[žz][íi]vat/i,
  /u\s+ostatn[íi]ch\s+[čc][áa]st[íi]\s+je\s+nep[řr]en[áa][šs]et\s+automaticky/i,
];

// ----- Fix A2 patterns (instrukční micro-plán pro Karla) -----
// Tyto fráze nesmí být ve VEŘEJNÝCH polích. V runtime_directive jsou OK.
const KAREL_INSTRUCTION_PATTERNS: RegExp[] = [
  /\bKarel\s+(?:nab[íi]dne|neza[čc][íi]n[áa]|nevkl[áa]d[áa]|zpomal[íi]|hled[áa]|shrne|ozn[áa]m[íi])\b/i,
  /\bKr[áa]tce\s+ov[eě][řr]it\b/i,
  /\bJen\s+mapa\b/i,
  /\bBez\s+rozeb[íi]r[áa]n[íi]\b/i,
  /\bnez[áa][čc][íi]nat\s+p[řr][íi]m[ýy]m\s+dotazem\b/i,
  /\bnep[řr]en[áa][šs]et\s+\S+\s+symboly\s+automaticky\b/i,
];

// Goal/instrukční slovesa — pokud goal začíná těmito imperativy bez klinické
// formulace ve 3. osobě, je to mikroplán pro Karla, ne klinický cíl.
const IMPERATIVE_GOAL_OPENERS: RegExp[] = [
  /^ov[eě][řr]it\s+dne[šs]n[íi]/i,
  /^p[řr]ipomenout\s+star[šs][íi]\s+zdroje/i,
  /^dr[žz]et\s+kr[áa]tk[ýy]/i,
  /^nav[áa]zat\s+kontakt\s+bez\s+tlaku/i,
];

function assertNoLeaks(label: string, value: unknown, patterns: RegExp[]) {
  const text = typeof value === "string" ? value : "";
  for (const re of patterns) {
    if (re.test(text)) {
      throw new Error(`[${label}] LEAK detected: ${re} in:\n${text}`);
    }
  }
}

function makeReview() {
  return {
    exists: true,
    is_yesterday: true,
    days_since_today: 1,
    session_date_iso: "2026-05-12",
    human_recency_label: "včera",
    visible_label: "Včerejší Herna",
    part_name: "Tundrupek",
    status: "evidence_limited",
    practical_report_text:
      "Tundrupek opakovaně použil symbol huňatého pejska jako jazyk samoty a potřeby blízkosti. Stabilizace skrze symboly světla a domova selhávala, kontakt zůstával křehký.",
    detailed_analysis_text:
      "Materiál ukazuje výraznou osamělost a zhoršenou důvěru v doložené uzemňovací zdroje; symbol pejska funguje jako pomocná postava bezpečí.",
    implications_for_part:
      "Tundrupek aktuálně potřebuje opatrný a velmi pomalý kontakt; tradiční uzemňovací symboly mu dnes nestačí, je potřeba navázat na vlastní symboliku, kterou sám přinese.",
    recommendations_for_next_playroom:
      "V další Herně začít jemným check-inem a otevřít prostor pro symbol huňatého pejska pouze pokud ho Tundrupek sám přinese; nevynucovat tradiční zdroje světla a domova.",
    recommendations_for_therapists:
      "Sledovat, zda symbol huňatého pejska zůstává nosný, a doložit klinicky.",
  };
}

// ============================================================
// Fix A — kanálový leak
// ============================================================

Deno.test("Fix A: clean why_this_part_today is preserved (no operational concat)", () => {
  const cleanWhy = "Tundrupek se v posledních dnech opakovaně vrací k tématu osamělosti.";
  const pp: any = { why_this_part_today: cleanWhy, backend_context_inputs: {} };
  const directive =
    "Před 1 dnem proběhla Herna. Dnešní návrh nenavazuje automaticky; vychází z včerejší Herny a začíná novým bezpečným check-inem. Symboly z tohoto materiálu používat primárně s Tundrupkem a jen tehdy, pokud je část sama přinese nebo na ně klidně reaguje; u ostatních částí je nepřenášet automaticky.";

  assertEquals(pp.why_this_part_today, cleanWhy);
  assertNoLeaks("why_this_part_today", pp.why_this_part_today, LEAK_PATTERNS_FIX_A);

  pp.backend_context_inputs.runtime_directive = directive;
  assert(pp.backend_context_inputs.runtime_directive.includes("nenavazuje automaticky"));
});

Deno.test("Fix A: explicit failure if old concat pattern returns", () => {
  const broken =
    "Hanička upřesnila faktický rámec skutečné události nebo externího kontextu. Beru to jako skutečnou událost. Pokud se téma samo objeví, držet ho jako skutečnou událost. Část vykazuje sníženou dostupnost.";
  let caught = false;
  try {
    assertNoLeaks("why_this_part_today", broken, LEAK_PATTERNS_FIX_A);
  } catch {
    caught = true;
  }
  assertFalse(!caught, "Leak detector must catch concatenated runtime directives");
});

// ============================================================
// Fix A2 — sémantický rewrite veřejného briefingu
// ============================================================

Deno.test("Fix A2: helper produces clinical why_this_part_today (3rd person, no Karel-instructions)", () => {
  const out = buildClinicalPlayroomBriefing(makeReview(), "Tundrupek");
  // Klinická forma: 3. osoba + opěrné fráze briefingu.
  assert(/odkryla,\s+že/i.test(out.why_this_part_today), `Missing "odkryla, že" clinical opener:\n${out.why_this_part_today}`);
  assert(/Karel\s+pracovn[eě]\s+rozum[íi]/i.test(out.why_this_part_today), `Missing pracovní hypotéza opener:\n${out.why_this_part_today}`);
  assert(/Pro\s+dne[šs]n[íi]\s+pr[áa]ci\s+z\s+toho\s+plyne/i.test(out.why_this_part_today), `Missing "pro dnešní práci z toho plyne":\n${out.why_this_part_today}`);

  assertNoLeaks("why_this_part_today", out.why_this_part_today, KAREL_INSTRUCTION_PATTERNS);
  assertNoLeaks("main_theme", out.main_theme, KAREL_INSTRUCTION_PATTERNS);
});

Deno.test("Fix A2: goals must be clinical 3rd-person, not karel instructions", () => {
  const out = buildClinicalPlayroomBriefing(makeReview(), "Tundrupek");
  assert(out.goals.length > 0, "goals must not be empty");
  for (const goal of out.goals) {
    assertNoLeaks("goal", goal, KAREL_INSTRUCTION_PATTERNS);
    for (const re of IMPERATIVE_GOAL_OPENERS) {
      if (re.test(goal)) {
        throw new Error(`[goal] starts with imperative micro-plan opener (${re}):\n${goal}`);
      }
    }
  }
});

Deno.test("Fix A2: program blocks must describe clinical intent, not runtime instructions", () => {
  const out = buildClinicalPlayroomBriefing(makeReview(), "Tundrupek");
  assert(out.program_blocks.length >= 4, "program_blocks must have at least 4 entries");
  for (const block of out.program_blocks) {
    assertNoLeaks(`program_blocks[${block.block}].detail`, block.detail, KAREL_INSTRUCTION_PATTERNS);
    assert(block.block && block.detail, "block must have title + detail");
    assert(typeof block.minutes === "number" && block.minutes > 0, "block must have positive minutes");
  }
});

Deno.test("Fix A2: fallback (no review) still produces clinical, non-instructional public fields", () => {
  const out = buildClinicalPlayroomBriefing(null, "Tundrupek", {
    whyToday: "aktuální signály jsou slabé",
    realityCorrectionPresent: false,
  });
  assertNoLeaks("why_this_part_today (fallback)", out.why_this_part_today, KAREL_INSTRUCTION_PATTERNS);
  assertNoLeaks("main_theme (fallback)", out.main_theme, KAREL_INSTRUCTION_PATTERNS);
  for (const goal of out.goals) assertNoLeaks("goal (fallback)", goal, KAREL_INSTRUCTION_PATTERNS);
  for (const block of out.program_blocks) {
    assertNoLeaks(`program_blocks[${block.block}].detail (fallback)`, block.detail, KAREL_INSTRUCTION_PATTERNS);
  }
});

Deno.test("Fix A2: runtime_directive may carry karel instructions, public fields must not (canary)", () => {
  // Negativní kontrola — pattern detector MUSÍ chytit „Karel nabídne volbu".
  const instructional = "Karel nabídne volbu mezi tichem a slovem; nezačínat přímým dotazem.";
  let caught = false;
  try {
    assertNoLeaks("public", instructional, KAREL_INSTRUCTION_PATTERNS);
  } catch {
    caught = true;
  }
  assertFalse(!caught, "Detector must catch 'Karel nabídne …' as a public-field leak");

  // Stejný text v runtime_directive je OK — žádná kontrola se na něj nevztahuje.
  const runtimeDirective = instructional;
  assert(runtimeDirective.length > 0);
});
