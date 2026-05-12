import { describe, expect, it } from "vitest";
import { renderDeliberationTitle } from "@/components/did/deliberationRoomUiHelpers";

/**
 * P33.10.1B — render-time grammar guard for legacy DB rows that still hold
 * buggy titles like "Plán dnešní herny s tundrupek". Visible UI must always
 * render the canonical dash form.
 */
describe("renderDeliberationTitle", () => {
  it("rewrites legacy 'Plán dnešní herny s tundrupek' → '— Tundrupek'", () => {
    const t = renderDeliberationTitle({
      title: "Plán dnešní herny s tundrupek",
      subject_parts: ["Tundrupek"],
      session_params: { session_format: "playroom" },
      deliberation_type: "playroom",
    } as any);
    expect(t).toBe("Plán dnešní herny — Tundrupek");
  });

  it("rewrites 'Plán sezení s gustik' → 'Plán sezení — Gustik'", () => {
    const t = renderDeliberationTitle({
      title: "Plán sezení s gustik",
      subject_parts: ["gustik"],
      session_params: {},
      deliberation_type: "session_plan",
    } as any);
    expect(t).toBe("Plán sezení — Gustik");
  });

  it("falls back to subject_parts[0] when title is missing (playroom)", () => {
    const t = renderDeliberationTitle({
      title: null,
      subject_parts: ["arthur"],
      session_params: { session_format: "playroom" },
      deliberation_type: "playroom",
    } as any);
    expect(t).toBe("Plán dnešní herny — Arthur");
  });

  it("leaves already-canonical dash titles unchanged", () => {
    const t = renderDeliberationTitle({
      title: "Plán sezení — Gustik",
      subject_parts: ["Gustik"],
      session_params: {},
      deliberation_type: "session_plan",
    } as any);
    expect(t).toBe("Plán sezení — Gustik");
  });

  it("leaves unrelated free-form titles unchanged", () => {
    const t = renderDeliberationTitle({
      title: "Společné rozhodnutí o víkendu",
      subject_parts: [],
      session_params: {},
      deliberation_type: "team_task",
    } as any);
    expect(t).toBe("Společné rozhodnutí o víkendu");
  });
});
