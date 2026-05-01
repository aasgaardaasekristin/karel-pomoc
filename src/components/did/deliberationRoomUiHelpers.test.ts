import { describe, expect, it } from "vitest";
import {
  countHernaForbiddenTerms,
  getLiveProgramTitle,
  getPlanChangeLabel,
  HERNA_VISIBLE_FORBIDDEN_TERMS,
  isPlayroomDeliberation,
  sanitizeHernaVisibleText,
} from "./deliberationRoomUiHelpers";
import type { TeamDeliberation } from "@/types/teamDeliberation";

const baseDeliberation = (override: Partial<TeamDeliberation>): TeamDeliberation =>
  ({
    id: "test",
    user_id: "user",
    title: "Test",
    reason: null,
    status: "active",
    priority: "normal",
    deliberation_type: "session_plan",
    subject_parts: [],
    participants: [],
    created_by: "karel",
    initial_karel_brief: null,
    karel_proposed_plan: null,
    questions_for_hanka: [],
    questions_for_kata: [],
    agenda_outline: [],
    discussion_log: [],
    hanka_signed_at: null,
    kata_signed_at: null,
    karel_signed_at: null,
    linked_live_session_id: null,
    linked_task_id: null,
    linked_drive_write_id: null,
    linked_crisis_event_id: null,
    linked_briefing_id: null,
    linked_briefing_item_id: null,
    final_summary: null,
    followup_needed: false,
    session_params: {},
    program_draft: null,
    karel_synthesis: null,
    karel_synthesized_at: null,
    created_at: "2026-05-01T08:00:00.000Z",
    updated_at: "2026-05-01T08:00:00.000Z",
    closed_at: null,
    ...override,
  }) as TeamDeliberation;

describe("deliberationRoomUiHelpers", () => {
  it("renders Herna external-event replan as urgent revision, never unchanged", () => {
    const deliberation = baseDeliberation({
      deliberation_type: "playroom" as TeamDeliberation["deliberation_type"],
      status: "in_revision",
      hanka_signed_at: null,
      kata_signed_at: null,
      session_params: {
        session_actor: "karel_direct",
        ui_surface: "did_kids_playroom",
        session_format: "playroom",
        external_current_event_replan: {
          active: true,
          event_label: "Timmy",
        },
      },
    });

    const label = getPlanChangeLabel(deliberation);
    expect(label).not.toContain("beze změny");
    expect(label).toContain("urgentní externí události");
    expect(label).toContain("Timmy");
    expect(isPlayroomDeliberation(deliberation)).toBe(true);
    expect(getLiveProgramTitle(deliberation)).toBe("Živý program Herny");
  });

  it("allows unchanged only for a fully approved normal session", () => {
    const deliberation = baseDeliberation({
      deliberation_type: "session_plan",
      status: "approved",
      hanka_signed_at: "2026-05-01T09:00:00.000Z",
      kata_signed_at: "2026-05-01T09:05:00.000Z",
      session_params: {},
    });

    expect(getPlanChangeLabel(deliberation)).toBe("beze změny");
    expect(getLiveProgramTitle(deliberation)).toBe("Živý program Sezení");
  });

  it("does not call in_revision without external event unchanged", () => {
    const deliberation = baseDeliberation({
      status: "in_revision",
      hanka_signed_at: null,
      kata_signed_at: null,
      session_params: {},
    });

    expect(getPlanChangeLabel(deliberation)).toContain("vráceno k úpravě");
    expect(getPlanChangeLabel(deliberation)).not.toContain("beze změny");
  });

  describe("Herna visible-text guard", () => {
    const legacyBrief = [
      "🎲 **Plán dnešní herny s Tundrupek**",
      "",
      "Otevírám poradu ke schválení samostatného programu Herny. Herna je Karel-led práce s částí; nepoužije se plán terapeutického sezení ani first_draft.",
    ].join("\n");

    it("sanitizes legacy Karel-led / first_draft phrasing into clinical Czech", () => {
      const cleaned = sanitizeHernaVisibleText(legacyBrief);
      expect(cleaned).not.toMatch(/Karel-led/i);
      expect(cleaned).not.toMatch(/first_draft/i);
      expect(cleaned).toContain("vedená Karlem");
      expect(cleaned).toContain("pracovní návrh");
    });

    it("forbidden term scan returns 0 after sanitization", () => {
      const cleaned = sanitizeHernaVisibleText(legacyBrief);
      expect(countHernaForbiddenTerms(cleaned)).toBe(0);
    });

    it("forbidden term scan flags raw legacy text", () => {
      expect(countHernaForbiddenTerms(legacyBrief)).toBeGreaterThan(0);
    });

    it("required clinical phrases compose correctly for Herna replan UI", () => {
      const replanDeliberation = baseDeliberation({
        deliberation_type: "playroom" as TeamDeliberation["deliberation_type"],
        status: "in_revision",
        session_params: {
          session_actor: "karel_direct",
          external_current_event_replan: { active: true, event_label: "Timmy" },
        },
      });
      const composed = [
        getLiveProgramTitle(replanDeliberation),
        getPlanChangeLabel(replanDeliberation),
        "Herna je práce vedená Karlem po schválení terapeutkami.",
        "Herna má vlastní schválený herní program.",
      ].join(" | ");

      expect(composed).toContain("Živý program Herny");
      expect(composed).toContain("čeká na nové schválení");
      expect(composed).toContain("Herna je práce vedená Karlem po schválení terapeutkami");
      expect(composed).toContain("Herna má vlastní schválený herní program");
      expect(countHernaForbiddenTerms(composed)).toBe(0);
    });

    it("forbidden term list covers required entries", () => {
      for (const term of [
        "first_draft",
        "Karel-led",
        "program_draft",
        "session_params",
        "backend",
        "Pantry",
        "karel_pantry_b_entries",
        "Živý program sezení",
        "Změna plánu: beze změny",
        "Vyžaduje terapeutku: Ne",
      ]) {
        expect(HERNA_VISIBLE_FORBIDDEN_TERMS).toContain(term as never);
      }
    });
  });
});
