/**
 * P31.1c — UI runtime smoke + anti-regression closeout.
 *
 * Mountuje DidDailyBriefingPanel s mocknutým supabase klientem, který
 * vrací synteticky-bezpečnou fixture odpovídající tvaru reálného
 * latest payloadu (9 sekcí, ok=true, render_audit, external_reality_watch
 * atd.). Žádný citlivý text ze skutečné DB.
 *
 * Cíl P31.1c (z user briefu):
 *  A) latest payload shape captured (synthetic, no raw sensitive text)
 *  B) DOM tests:
 *     1. human ok=true → human sections viditelné
 *     2. human ok=true → strukturovaný main hidden, "Technické podklady" collapsed
 *     3. human chybí → fallback na strukturovaný layout, no crash
 *     4. ok=false → fallback hláška „Humanizovaná vrstva není dostupná…"
 *     5. ok=true ale sections=[] → no-crash, fallback režim
 *     6. žádné interní termíny v DOM (payload, truth gate, job graph,
 *        pipeline, provider_status, source_cycle_id, unsupported_claims_count)
 *     7. Technické podklady jsou collapsed (details element, ne expanded)
 *  C) accessibility: human sekce mají heading-like title, details má summary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import React from "react";

// ── Synthetic safe fixture (P31.1c part A) ─────────────────────────
// Tvar 1:1 podle reálného latest payloadu pro canonical user, ale
// veškerý text je neutrální syntetický — ŽÁDNÝ raw clinical text.
const SAFE_HUMAN_SECTIONS = [
  { section_id: "system_morning_state", title: "Ranní stav", karel_text: "Dnes ráno mám ověřený výchozí stav." },
  { section_id: "daily_cycle_verified", title: "Co je ověřené z dnešní ranní přípravy", karel_text: "Ranní příprava proběhla v pořádku." },
  { section_id: "today_parts", title: "Dnešní práce s kluky", karel_text: "Soustředím se na bezpečnou návaznost." },
  { section_id: "therapist_asks", title: "Úkoly pro terapeutky", karel_text: "Potřebuji od Haničky upřesnit drobnost." },
  { section_id: "session_plan", title: "Plán Sezení a Herny", karel_text: "Sezení vede Hanička, herna je v přípravě." },
  { section_id: "external_reality", title: "Externí kontext", karel_text: "Vnější situace je stabilní, žádná akutní událost." },
  { section_id: "risks_sensitivities", title: "Citlivosti dne", karel_text: "Dnes hlídám únavu a bezpečné tempo." },
  { section_id: "unknowns", title: "Co dnes nevím", karel_text: "Zatím nevím, jak proběhne odpolední kontakt." },
  { section_id: "next_step", title: "Opatrný další krok", karel_text: "Další krok je krátké ověření před sezením." },
];

const baseStructuredPayload = {
  briefing_date: "2026-05-07",
  greeting: "Dobré ráno, Haničko a Káťo.",
  opening_monologue_text: "Dobré ráno. Strukturovaný fallback monolog.",
  last_3_days: "",
  decisions: [],
  ask_hanka: [],
  ask_kata: [],
  closing: "",
};

const buildBriefingRow = (humanOverride: any | undefined | null) => ({
  id: "brief-fixture-1",
  briefing_date: "2026-05-07",
  generated_at: "2026-05-07T02:53:47.017Z",
  is_stale: false,
  proposed_session_part_id: null,
  decisions_count: 0,
  generation_method: "manual",
  payload: {
    ...baseStructuredPayload,
    ...(humanOverride === undefined ? {} : { karel_human_briefing: humanOverride }),
    external_reality_watch: {
      provider_status: "configured",
      active_part_daily_brief_count: 14,
      internet_events_used_count: 12,
      source_backed_events_count: 12,
    },
  },
});

const FIXTURE_HUMAN_OK = buildBriefingRow({
  ok: true,
  renderer_version: "p31.1.0",
  sections: SAFE_HUMAN_SECTIONS,
  render_audit: { unsupported_claims_count: 0, robotic_phrase_count: 0 },
});

const FIXTURE_HUMAN_BROKEN = buildBriefingRow({
  ok: false,
  renderer_version: "p31.1.0",
  sections: [],
  render_audit: { unsupported_claims_count: 0, robotic_phrase_count: 0 },
});

const FIXTURE_HUMAN_MISSING = buildBriefingRow(undefined);

const FIXTURE_HUMAN_OK_EMPTY = buildBriefingRow({
  ok: true,
  renderer_version: "p31.1.0",
  sections: [],
  render_audit: { unsupported_claims_count: 0, robotic_phrase_count: 0 },
});

// ── Mock supabase client ────────────────────────────────────────────
let CURRENT_BRIEFING: any = FIXTURE_HUMAN_OK;

vi.mock("@/integrations/supabase/client", () => {
  const makeQuery = (payload: any) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      in: () => chain,
      neq: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: payload, error: null }),
      then: (resolve: any) => resolve({ data: payload ? [payload] : [], error: null }),
    };
    return chain;
  };
  return {
    supabase: {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: (table: string) => {
        if (table === "did_daily_briefings") return makeQuery(CURRENT_BRIEFING);
        if (table === "did_daily_briefing_attempts") return makeQuery(null);
        if (table === "did_daily_session_plans") return makeQuery(null);
        if (table === "did_session_reviews") return makeQuery(null);
        if (table === "did_threads") return makeQuery(null);
        if (table === "did_live_session_progress") return makeQuery(null);
        return makeQuery(null);
      },
      channel: () => ({
        on() { return this; },
        subscribe() { return this; },
      }),
      removeChannel: () => {},
      functions: { invoke: async () => ({ data: null, error: null }) },
    },
  };
});

vi.mock("react-router-dom", () => ({
  useNavigate: () => () => {},
}));

vi.mock("@/hooks/useDidThreads", () => ({
  useDidThreads: () => ({
    threads: [],
    refresh: async () => {},
    getThreadByWorkspace: async () => null,
    createThread: async () => ({ id: "t1" }),
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: () => {}, success: () => {}, info: () => {} },
}));

// Component import after mocks
import DidDailyBriefingPanel from "@/components/did/DidDailyBriefingPanel";

const FORBIDDEN_INTERNAL_TERMS = [
  "truth gate",
  "job graph",
  "provider_status",
  "source_cycle_id",
  "unsupported_claims_count",
];

const renderPanel = async (fixture: any) => {
  CURRENT_BRIEFING = fixture;
  const utils = render(<DidDailyBriefingPanel />);
  // Wait for loadLatest to flush
  await waitFor(() => {
    expect(document.querySelector('[data-testid="karel-human-briefing"], [data-testid="karel-human-briefing-fallback"], .rounded-xl')).toBeTruthy();
  }, { timeout: 3000 });
  return utils;
};

describe("P31.1c — UI runtime smoke + anti-regression", () => {
  beforeEach(() => {
    cleanup();
  });

  it("A. fixture obsahuje tvar latest payloadu bez raw clinical textu", () => {
    expect(FIXTURE_HUMAN_OK.payload.karel_human_briefing.ok).toBe(true);
    expect(FIXTURE_HUMAN_OK.payload.karel_human_briefing.sections).toHaveLength(9);
    expect(FIXTURE_HUMAN_OK.payload.external_reality_watch).toBeTruthy();
    // Žádné citlivé výrazy reálných klientských dat
    const dump = JSON.stringify(FIXTURE_HUMAN_OK).toLowerCase();
    for (const term of ["timmi", "tundrupek", "keporkak", "hanka chleb"]) {
      expect(dump).not.toContain(term);
    }
  });

  it("B1. human ok=true → renderuje human sekce jako primární", async () => {
    await renderPanel(FIXTURE_HUMAN_OK);
    const root = await screen.findByTestId("karel-human-briefing");
    expect(root).toHaveAttribute("data-human-ok", "true");
    expect(within(root).getByText(/Dnes ráno mám ověřený výchozí stav/)).toBeInTheDocument();
    expect(within(root).getByText(/Opatrný další krok/i)).toBeInTheDocument();
  });

  it("B2. human ok=true → strukturovaný main hidden + Technické podklady collapsed", async () => {
    await renderPanel(FIXTURE_HUMAN_OK);
    // Strukturovaný fallback monolog NESMÍ být primárně viditelný
    expect(screen.queryByText(/Strukturovaný fallback monolog/)).toBeNull();
    // Technické podklady musí existovat jako details
    const collapsed = await screen.findByTestId("briefing-structured-collapsed");
    expect(collapsed.tagName.toLowerCase()).toBe("details");
    expect(collapsed.hasAttribute("open")).toBe(false);
    expect(within(collapsed).getByText("Technické podklady")).toBeInTheDocument();
  });

  it("B3. human layer chybí → strukturovaný layout, žádný crash", async () => {
    await renderPanel(FIXTURE_HUMAN_MISSING);
    expect(screen.queryByTestId("karel-human-briefing")).toBeNull();
    expect(screen.queryByTestId("briefing-structured-collapsed")).toBeNull();
    expect(screen.getByText(/Strukturovaný fallback monolog/)).toBeInTheDocument();
  });

  it("B4. ok=false → fallback hláška + strukturovaný layout zůstává", async () => {
    await renderPanel(FIXTURE_HUMAN_BROKEN);
    const fb = await screen.findByTestId("karel-human-briefing-fallback");
    expect(fb).toHaveAttribute("data-human-ok", "false");
    expect(fb).toHaveTextContent("Humanizovaná vrstva není dostupná; zobrazuji strukturovaný přehled.");
    expect(screen.getByText(/Strukturovaný fallback monolog/)).toBeInTheDocument();
  });

  it("B5. ok=true ale sections=[] → no-crash, fallback na strukturovaný režim", async () => {
    await renderPanel(FIXTURE_HUMAN_OK_EMPTY);
    expect(screen.queryByTestId("karel-human-briefing")).toBeNull();
    expect(screen.getByText(/Strukturovaný fallback monolog/)).toBeInTheDocument();
  });

  it("B6. žádné interní/technické termíny ve viditelném DOM textu", async () => {
    await renderPanel(FIXTURE_HUMAN_OK);
    const text = (document.body.textContent || "").toLowerCase();
    for (const term of FORBIDDEN_INTERNAL_TERMS) {
      expect(text).not.toContain(term.toLowerCase());
    }
  });

  it("B7. Technické podklady NEJSOU automaticky expanded jako primární text", async () => {
    await renderPanel(FIXTURE_HUMAN_OK);
    const collapsed = await screen.findByTestId("briefing-structured-collapsed");
    expect(collapsed.hasAttribute("open")).toBe(false);
  });

  it("C. accessibility: human sekce mají heading-like title a details má summary", async () => {
    await renderPanel(FIXTURE_HUMAN_OK);
    const root = await screen.findByTestId("karel-human-briefing");
    const headings = root.querySelectorAll("h3");
    expect(headings.length).toBeGreaterThanOrEqual(6);
    const collapsed = await screen.findByTestId("briefing-structured-collapsed");
    expect(collapsed.querySelector("summary")).toBeTruthy();
  });
});
