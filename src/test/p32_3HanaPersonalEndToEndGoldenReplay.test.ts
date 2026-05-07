/**
 * P32.3 — Hana/personal end-to-end golden replay suite.
 *
 * Multi-turn replay harness that exercises, on a single in-process pipeline:
 *   - the REAL resolveHanaPersonalIdentity()   (P32 resolver)
 *   - the REAL validateHanaPersonalResponseIdentity() (P32.2 response guard)
 *   - the REAL gateDriveWriteInsert() / blockHanaAliasPartWrite() (P32.1 write guards)
 *
 * No DB, no fetch, no AI. Each turn supplies an `aiStub` to simulate the model
 * response Karel would have produced; the harness then runs the response guard
 * and the write gates, and collects audit-shaped rows + attempted side effects.
 *
 * This closes the original Hana/personal identity bug at the full
 * application level (turn-over-turn).
 */

import { describe, it, expect } from "vitest";
import {
  resolveHanaPersonalIdentity,
  blockHanaAliasPartWrite,
  type HanaPersonalIdentityResolution,
  type MentionedPart,
} from "../../supabase/functions/_shared/hanaPersonalIdentityResolver.ts";
import {
  validateHanaPersonalResponseIdentity,
  renderSafeHanaPersonalFallback,
} from "../../supabase/functions/_shared/hanaPersonalResponseGuard.ts";
import { gateDriveWriteInsert } from "../../supabase/functions/_shared/documentGovernance.ts";

// ── Harness types ──────────────────────────────────────────────────

type KnownPart = { canonical_part_name: string; aliases?: string[] };

interface ProposedSideEffects {
  /** Drive writes Karel would attempt for this turn. */
  driveWrites?: Array<{
    target_document: string;
    bezpecne_payload?: string;
    bezpecne_part_name?: string;
  }>;
  /** Card-update queue rows Karel would attempt. */
  cardUpdates?: Array<{ part_id: string; action: string }>;
  /** DID observations Karel would attempt. */
  observations?: Array<{
    subject_type: "part" | "therapist" | "session";
    subject_id: string;
    note?: string;
  }>;
}

interface Turn {
  user?: string;
  aiStub?: string;
  /** Optional: side effects Karel would attempt this turn (defaults derived from resolution). */
  proposedSideEffects?: ProposedSideEffects;
}

interface ReplayInput {
  turns: Turn[];
  knownParts?: KnownPart[];
}

interface IdentityAuditRow {
  turn_index: number;
  resolution_kind: string;
  speaker_identity: string;
  mentioned_parts: string[];
  mentioned_groups: string[];
  should_create_hana_memory: boolean;
  should_create_part_observation: boolean;
  should_create_part_card_update: boolean;
  memory_targets: string[];
  warnings: string[];
}

interface ResponseGuardAuditRow {
  turn_index: number;
  resolution_kind: string;
  response_guard_status: "ok" | "blocked_and_replaced";
  blocked_reason?: string;
  used_fallback: boolean;
  warnings: string[];
}

interface ReplayResult {
  returnedResponses: string[];
  identityAuditRows: IdentityAuditRow[];
  responseGuardAuditRows: ResponseGuardAuditRow[];
  attemptedDriveWrites: Array<{ turn_index: number; target_document: string; gate_ok: boolean; reason?: string }>;
  attemptedCardUpdates: Array<{ turn_index: number; part_id: string; blocked: boolean; reason?: string }>;
  attemptedObservations: Array<{
    turn_index: number;
    subject_type: string;
    subject_id: string;
    blocked: boolean;
    reason?: string;
  }>;
  memoryTargets: string[];
  finalResolutionKind: string;
  violations: string[];
}

const DEFAULT_KNOWN_PARTS: KnownPart[] = [
  { canonical_part_name: "Gustík", aliases: ["Gusti"] },
  { canonical_part_name: "Tundrupek" },
  { canonical_part_name: "Arthur", aliases: ["Artík"] },
  { canonical_part_name: "Gerhardt" },
  { canonical_part_name: "Timmy" },
];

function partsToNames(p: MentionedPart[]): string[] {
  return p.map((x) => x.canonical_part_name);
}

function defaultProposedSideEffects(
  res: HanaPersonalIdentityResolution,
): ProposedSideEffects {
  // Realistic minimal "Karel would propose this" baseline derived from the resolver:
  // - Hana memory writes go to recommended_memory_targets (always Hana side, never KARTA_HANA).
  // - When Hana mentions a single part with high/medium confidence, Karel would
  //   propose a `reported_by_hana_about_part` observation against that part —
  //   we model that as observations[].subject_id = canonical_part_name.
  // - We never propose KARTA_HANA / KARTA_KAREL drive writes.
  const driveWrites = (res.recommended_memory_targets || []).map((t) => ({
    // Memory targets live under PAMET_KAREL/DID/HANKA — they are NOT KARTA_*.
    target_document: t,
  }));
  const observations: ProposedSideEffects["observations"] =
    res.should_create_part_observation && res.mentioned_parts.length > 0
      ? res.mentioned_parts.map((p) => ({
          subject_type: "part" as const,
          subject_id: p.canonical_part_name,
          note: "reported_by_hana_about_part",
        }))
      : [];
  return { driveWrites, cardUpdates: [], observations };
}

export function runHanaPersonalGoldenReplay(input: ReplayInput): ReplayResult {
  const knownParts = input.knownParts ?? DEFAULT_KNOWN_PARTS;
  const result: ReplayResult = {
    returnedResponses: [],
    identityAuditRows: [],
    responseGuardAuditRows: [],
    attemptedDriveWrites: [],
    attemptedCardUpdates: [],
    attemptedObservations: [],
    memoryTargets: [],
    finalResolutionKind: "non_hana_surface",
    violations: [],
  };

  let turnIndex = -1;
  let lastResolution: HanaPersonalIdentityResolution | null = null;

  for (const turn of input.turns) {
    if (turn.user !== undefined) {
      turnIndex += 1;
      // 1) Resolve identity for the user message.
      const res = resolveHanaPersonalIdentity({
        text: turn.user,
        knownParts,
        surface: "hana_personal",
      });
      lastResolution = res;
      result.identityAuditRows.push({
        turn_index: turnIndex,
        resolution_kind: res.resolution_kind,
        speaker_identity: res.speaker_identity,
        mentioned_parts: partsToNames(res.mentioned_parts),
        mentioned_groups: res.mentioned_groups.slice(),
        should_create_hana_memory: res.should_create_hana_memory,
        should_create_part_observation: res.should_create_part_observation,
        should_create_part_card_update: res.should_create_part_card_update,
        memory_targets: res.recommended_memory_targets.slice(),
        warnings: res.warnings.slice(),
      });
      result.memoryTargets.push(...res.recommended_memory_targets);
      result.finalResolutionKind = res.resolution_kind;

      // Hard invariant: speaker on hana_personal MUST always be hana_therapist
      // (never switch to a part), and addressed identity MUST be Karel.
      if (res.speaker_identity !== "hana_therapist") {
        result.violations.push(`turn_${turnIndex}_speaker_not_hana_therapist:${res.speaker_identity}`);
      }
      if (res.should_switch_speaker_to_part) {
        result.violations.push(`turn_${turnIndex}_switched_speaker_to_part`);
      }
      if (res.should_create_part_card_update) {
        result.violations.push(`turn_${turnIndex}_proposed_part_card_update_on_hana_surface`);
      }

      continue;
    }

    if (turn.aiStub !== undefined) {
      // 2) Run the response guard on the AI candidate response.
      const guard = validateHanaPersonalResponseIdentity({
        responseText: turn.aiStub,
        identityResolution: lastResolution,
        userText: undefined,
      });

      const finalResponse = guard.blocked
        ? guard.safe_fallback_text ?? renderSafeHanaPersonalFallback(lastResolution)
        : turn.aiStub;
      result.returnedResponses.push(finalResponse);
      result.responseGuardAuditRows.push({
        turn_index: turnIndex,
        resolution_kind: lastResolution?.resolution_kind ?? "non_hana_surface",
        response_guard_status: guard.blocked ? "blocked_and_replaced" : "ok",
        blocked_reason: guard.reason,
        used_fallback: guard.blocked,
        warnings: guard.warnings.slice(),
      });

      // 3) Run write gates against proposed side effects for this turn.
      const proposed =
        turn.proposedSideEffects ??
        (lastResolution ? defaultProposedSideEffects(lastResolution) : {});

      for (const w of proposed.driveWrites ?? []) {
        const gate = gateDriveWriteInsert({
          target_document: w.target_document,
          bezpecne_payload: w.bezpecne_payload,
          bezpecne_part_name: w.bezpecne_part_name,
        });
        result.attemptedDriveWrites.push({
          turn_index: turnIndex,
          target_document: w.target_document,
          gate_ok: gate.ok,
          reason: gate.reason,
        });
        // Hana surface MUST never produce a KARTA_HANA / KARTA_KAREL accepted write.
        if (gate.ok && /KARTA_(HANA|HANK|HANIC|KAREL)/i.test(w.target_document)) {
          result.violations.push(`turn_${turnIndex}_forbidden_card_write_passed:${w.target_document}`);
        }
      }

      for (const c of proposed.cardUpdates ?? []) {
        const block = blockHanaAliasPartWrite({
          target_kind: "card_update_queue",
          part_id: c.part_id,
          source: "p32_3_replay",
        });
        result.attemptedCardUpdates.push({
          turn_index: turnIndex,
          part_id: c.part_id,
          blocked: block.blocked,
          reason: block.reason,
        });
        if (!block.blocked && /^(hana|hanka|hanic|hanič|karel)/i.test(c.part_id)) {
          result.violations.push(`turn_${turnIndex}_forbidden_card_update_passed:${c.part_id}`);
        }
      }

      for (const o of proposed.observations ?? []) {
        const block = blockHanaAliasPartWrite({
          target_kind: "did_observations",
          part_name: o.subject_type === "part" ? o.subject_id : null,
          source: "p32_3_replay",
        });
        result.attemptedObservations.push({
          turn_index: turnIndex,
          subject_type: o.subject_type,
          subject_id: o.subject_id,
          blocked: block.blocked,
          reason: block.reason,
        });
        if (
          !block.blocked &&
          o.subject_type === "part" &&
          /^(hana|hanka|hanic|hanič|karel)/i.test(o.subject_id)
        ) {
          result.violations.push(`turn_${turnIndex}_forbidden_observation_passed:${o.subject_id}`);
        }
      }
    }
  }

  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

const HANKA_BASE = "PAMET_KAREL/DID/HANKA";

describe("P32.3 Hana personal end-to-end golden replay", () => {
  it("Scenario 1 — Hana self, multi-turn (blocks 'Část Hanička', stays hana_self)", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Karle, já už nemůžu, mám pocit, že jsem na všechno sama." },
        { aiStub: "Část Hanička je hodně zahlcená." },
        { user: "Děkuju. Myslela jsem tím opravdu sebe, ne kluky." },
        { aiStub: "Haničko, děkuju za upřesnění. Zůstanu u tebe." },
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("hana_self");
    expect(out.identityAuditRows[0].speaker_identity).toBe("hana_therapist");
    expect(out.identityAuditRows[0].should_create_hana_memory).toBe(true);
    expect(out.identityAuditRows[0].should_create_part_observation).toBe(false);
    expect(out.identityAuditRows[0].should_create_part_card_update).toBe(false);
    expect(out.identityAuditRows[0].memory_targets.some((t) => t.startsWith(`${HANKA_BASE}/SITUACNI_ANALYZA`))).toBe(true);

    // Turn 1 AI was bad → blocked + replaced by hana_self fallback.
    expect(out.responseGuardAuditRows[0].response_guard_status).toBe("blocked_and_replaced");
    expect(out.responseGuardAuditRows[0].used_fallback).toBe(true);
    expect(out.returnedResponses[0]).toMatch(/Haničko/);

    // Turn 2 AI was OK → passed.
    expect(out.identityAuditRows[1].resolution_kind).toBe("hana_self");
    expect(out.responseGuardAuditRows[1].response_guard_status).toBe("ok");

    // No KARTA_HANA writes anywhere.
    expect(out.attemptedDriveWrites.every((w) => !/KARTA_HAN|KARTA_KAREL/i.test(w.target_document))).toBe(true);
    // No part observations.
    expect(out.attemptedObservations.length).toBe(0);
  });

  it("Scenario 2 — Hana mentions Gustík (blocks 'Gustíku, slyším tě'; observation only as reported_by_hana_about_part)", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Karle, dnes jsem mluvila s Gustíkem. Byl hodně stažený." },
        { aiStub: "Gustíku, slyším tě." },
        { user: "Já se jen bojím, že jsem na něj moc zatlačila." },
        { aiStub: "Haničko, slyším tvůj strach. Zůstávám s tebou." },
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("hana_mentions_part");
    expect(out.identityAuditRows[0].mentioned_parts).toContain("Gustík");
    expect(out.identityAuditRows[0].speaker_identity).toBe("hana_therapist");
    expect(out.identityAuditRows[0].should_create_part_card_update).toBe(false);
    expect(out.identityAuditRows[0].should_create_part_observation).toBe(true);

    // Turn 1 AI addressed Gustík directly → blocked.
    expect(out.responseGuardAuditRows[0].response_guard_status).toBe("blocked_and_replaced");
    expect(out.responseGuardAuditRows[0].blocked_reason).toMatch(/part_addressed_directly/);

    // Observation against Gustík was proposed and NOT blocked (allowed as reported_by_hana_about_part).
    const gustikObs = out.attemptedObservations.find((o) => o.subject_id === "Gustík");
    expect(gustikObs).toBeTruthy();
    expect(gustikObs?.blocked).toBe(false);

    // Turn 2 — speaker still Hana, NOT switched to Gustík.
    expect(out.identityAuditRows[1].speaker_identity).toBe("hana_therapist");
    expect(out.identityAuditRows[1].mentioned_parts).not.toContain("Hana");
  });

  it("Scenario 3 — Hana mentions kluci as group (blocks specific-part inference)", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Kluci jsou dnes divně stažení, nevím, jestli to je únava nebo strach." },
        { aiStub: "To bude nejspíš Tundrupek." },
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("hana_mentions_group_kluci");
    expect(out.identityAuditRows[0].mentioned_groups).toContain("kluci");
    expect(out.identityAuditRows[0].mentioned_parts).toEqual([]);
    expect(out.identityAuditRows[0].should_create_part_observation).toBe(false);

    expect(out.responseGuardAuditRows[0].response_guard_status).toBe("blocked_and_replaced");
    expect(out.responseGuardAuditRows[0].blocked_reason).toMatch(/group_response_picked_specific_part/);
    expect(out.returnedResponses[0]).not.toMatch(/Tundrupek/);
  });

  it("Scenario 4 — ambiguous self vs part (blocks 'To je Gustík.', requires clarification)", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Nevím, jestli to říkám já, nebo někdo z kluků." },
        { aiStub: "To je Gustík." },
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("ambiguous_needs_clarification");
    expect(out.identityAuditRows[0].should_create_hana_memory).toBe(false);
    expect(out.identityAuditRows[0].should_create_part_observation).toBe(false);
    expect(out.identityAuditRows[0].should_create_part_card_update).toBe(false);
    expect(out.identityAuditRows[0].memory_targets).toEqual([]);

    expect(out.responseGuardAuditRows[0].response_guard_status).toBe("blocked_and_replaced");
    expect(out.returnedResponses[0]).toMatch(/\?/); // fallback asks a question
    // No part-side effects at all.
    expect(out.attemptedObservations.length).toBe(0);
    expect(out.attemptedCardUpdates.length).toBe(0);
    // Drive writes for ambiguous: none (memory_targets=[]).
    expect(out.attemptedDriveWrites.length).toBe(0);
  });

  it("Scenario 5 — Hana names herself in third person ('Hanička se dnes bojí…') stays hana_self", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Hanička se dnes bojí, že to nezvládne." },
        { aiStub: "Haničko, slyším tvůj strach a jsem tu s tebou." },
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("hana_self");
    expect(out.identityAuditRows[0].mentioned_parts).toEqual([]);
    expect(out.identityAuditRows[0].memory_targets.some(
      (t) => t === `${HANKA_BASE}/SITUACNI_ANALYZA.txt` || t === `${HANKA_BASE}/VLAKNA_POSLEDNI.txt`,
    )).toBe(true);
    expect(out.responseGuardAuditRows[0].response_guard_status).toBe("ok");
  });

  it("Scenario 6 — registry contamination defense (Hanička/Karel in knownParts are ignored)", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Hanička je dnes úplně vyčerpaná." },
        { aiStub: "Haničko, slyším, jak je to těžké." },
      ],
      knownParts: [
        { canonical_part_name: "Gustík" },
        { canonical_part_name: "hanička" }, // contamination
        { canonical_part_name: "Karel" },   // contamination
      ],
    });

    expect(out.violations).toEqual([]);
    expect(out.identityAuditRows[0].resolution_kind).toBe("hana_self");
    expect(out.identityAuditRows[0].mentioned_parts).toEqual([]);
    expect(out.identityAuditRows[0].warnings.some((w) => w.includes("registry_part_is_hana_alias_ignored"))).toBe(true);
    // Even if a downstream tried a KARTA_HANIČKA / KARTA_KAREL drive write, gate must block it.
    const tryKarta = gateDriveWriteInsert({
      target_document: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_HANIČKA",
    });
    const tryKarel = gateDriveWriteInsert({
      target_document: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_KAREL",
    });
    expect(tryKarta.ok).toBe(false);
    expect(tryKarel.ok).toBe(false);
    expect(tryKarta.reason).toMatch(/blocked_by_identity_guard/);
    expect(tryKarel.reason).toMatch(/blocked_by_identity_guard/);
  });

  it("Memory target verification — hana_self routes only to HANKA targets", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [
        { user: "Karle, potřebuju s tebou mluvit jinak, pomalej tempo." },
        { aiStub: "Haničko, rozumím." },
      ],
    });
    const targets = out.identityAuditRows[0].memory_targets;
    expect(targets.every((t) => t.startsWith(HANKA_BASE))).toBe(true);
    // Strategy target should appear when communication style is mentioned.
    expect(targets).toContain(`${HANKA_BASE}/STRATEGIE_KOMUNIKACE.txt`);
  });

  it("Memory target verification — ambiguous routes to NO memory targets", () => {
    const out = runHanaPersonalGoldenReplay({
      turns: [{ user: "Nevím, jestli to říkám já, nebo někdo z kluků." }],
    });
    expect(out.identityAuditRows[0].memory_targets).toEqual([]);
    expect(out.identityAuditRows[0].should_create_hana_memory).toBe(false);
  });

  it("Cross-cutting invariant — across all scenarios, no forbidden drive write or observation passes", () => {
    const allTurns: Turn[] = [
      { user: "Já už nemůžu." },
      { aiStub: "Část Hana je vyčerpaná." },
      { user: "Mluvila jsem s Gustíkem." },
      { aiStub: "Gustíku, slyším tě." },
      { user: "Kluci jsou dnes divní." },
      { aiStub: "To bude Tundrupek." },
      { user: "Nevím, jestli mluvím já, nebo někdo z kluků." },
      { aiStub: "To je Arthur." },
      { user: "Hanička je dnes vyčerpaná." },
      { aiStub: "Haničko, slyším tě." },
    ];
    const out = runHanaPersonalGoldenReplay({ turns: allTurns });
    expect(out.violations).toEqual([]);
    // Every blocked turn produced a fallback that does NOT contain "část Hana"
    // or "část Hanička".
    for (const r of out.responseGuardAuditRows) {
      const idx = out.responseGuardAuditRows.indexOf(r);
      const text = out.returnedResponses[idx];
      expect(text.toLowerCase()).not.toMatch(/část\s+hana/);
    }
    // No attempted observation against Hana/Karel ever passes.
    for (const o of out.attemptedObservations) {
      if (/^(hana|hanka|hanic|hanič|karel)/i.test(o.subject_id)) {
        expect(o.blocked).toBe(true);
      }
    }
  });
});
