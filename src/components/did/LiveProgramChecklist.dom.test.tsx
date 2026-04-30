import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import LiveProgramChecklist from "./LiveProgramChecklist";

// Stub Supabase client — komponenta načítá progress, ale my pouze ověřujeme DOM render.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    functions: { invoke: async () => ({ data: null, error: null }) },
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const ACTIVE_PLAN_MD = `# Schválený plán z týmové porady
**Porada:** Plán sezení s gustik

## Program sezení

1. **Bezpečný vstup a ověření přítomnosti** (8 min)
   Terapeutka nejdřív ověří, jestli je gustik dnes dostupná.

2. **Tělesné a emoční mapování** (10 min)
   Terapeutka jemně mapuje tělo a emoci.

3. **Opatrné otevření tématu nebo stabilizační alternativa** (15 min)
   Pokud je kontakt stabilní, nabídne malé přiblížení.

4. **Integrace a měkké ukončení** (8 min)
   Terapeutka shrne jen to, co bylo skutečně řečeno.
`;

describe("LiveProgramChecklist DOM proof", () => {
  beforeEach(() => {
    cleanup();
    if (typeof window !== "undefined") window.localStorage.clear();
  });

  it("renders 4 program bullets from active plan markdown", () => {
    const { container } = render(
      <LiveProgramChecklist
        planMarkdown={ACTIVE_PLAN_MD}
        storageKey="test::live::151e33f3"
        partName="gustik"
        therapistName="Hanka"
        sessionId="151e33f3-671f-4152-a2e2-7394b24624bb"
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Program bod po bodu");
    expect(text).toContain("0/4");
    expect(text).toContain("Bezpečný vstup");
    expect(text).toContain("Tělesné a emoční mapování");
    expect(text).toContain("Opatrné otevření");
    expect(text).toContain("Integrace");

    // Forbidden silent-fallback string MUST NOT appear in the rendered UI.
    expect(text).not.toContain("Bezformátový program");
    expect(text).not.toContain("sleduj plán v chatu");
  });

  it("shows explicit error state when plan markdown is empty (no silent fallback)", () => {
    const { container, queryByTestId } = render(
      <LiveProgramChecklist
        planMarkdown=""
        storageKey="test::live::empty"
        partName="gustik"
        therapistName="Hanka"
        sessionId="empty-plan"
      />,
    );
    const text = container.textContent ?? "";
    expect(queryByTestId("live-program-error-state")).not.toBeNull();
    expect(text).toContain("Program sezení se nepodařilo načíst");
    expect(text).toContain("Načíst znovu plán");
    expect(text).not.toContain("Bezformátový program");
    expect(text).not.toContain("sleduj plán v chatu");
  });

  it("shows error state for legacy JSON-dump that produced 0 bullets when invalid", () => {
    const md = `# Schválený plán z týmové porady\n[]`;
    const { container, queryByTestId } = render(
      <LiveProgramChecklist
        planMarkdown={md}
        storageKey="test::live::empty-json"
        partName="gustik"
        therapistName="Hanka"
        sessionId="empty-json-plan"
      />,
    );
    const text = container.textContent ?? "";
    expect(queryByTestId("live-program-error-state")).not.toBeNull();
    expect(text).not.toContain("Bezformátový program");
  });
});
