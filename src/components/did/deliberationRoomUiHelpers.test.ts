import { describe, expect, it } from "vitest";
import {
  getLiveProgramTitle,
  getPlanChangeLabel,
  isPlayroomDeliberation,
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
});