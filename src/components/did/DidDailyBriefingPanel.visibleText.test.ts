import { describe, expect, it } from "vitest";
import { backendContextSummary, briefingFreshnessBannerText, cleanVisibleClinicalText, ensureKarelOpeningVoice, getBriefingFreshnessMeta, humanizeRecencyInProse, realityContextText, recencySectionNoticeText, revalidateRecencyForViewer, toProposedPlayroomView, toProposedSessionView } from "./DidDailyBriefingPanel";

const forbidden = [
  "pending_review",
  "evidence_limited",
  "child evidence",
  "evidence discipline",
  "therapist_factual_correction",
  "external_fact",
  "real-world context",
  "real-world kontext",
  "operational context",
  "operační kontext",
  "briefing_input",
  "source_ref",
  "source_kind",
  "backend_context_inputs",
  "processed_at",
  "ingestion",
  "Pantry B",
  "karel_pantry_b_entries",
  "did_event_ingestion_log",
  "faktická korekce reality",
  "needs_therapist_input",
  "awaiting_therapist_review",
  "backend_context_inputs",
];

const expectClean = (text: string) => {
  for (const term of forbidden) {
    expect(text.toLowerCase()).not.toContain(term.toLowerCase());
  }
};

describe("DidDailyBriefingPanel visible clinical text helpers", () => {
  it("translates internal statuses into human clinical prose", () => {
    const text = cleanVisibleClinicalText(
      "pending_review / evidence_limited; therapist_factual_correction / external_fact; child evidence; evidence discipline; source_ref; backend_context_inputs; faktická korekce reality",
    );

    expectClean(text);
    expect(text).toContain("otevřené nebo částečně rozpracované");
    expect(text).toContain("Hanička upřesnila faktický rámec");
    expect(text).toContain("skutečné události");
    expect(text).toContain("vlastní slova, tělesná reakce nebo chování kluků");
  });

  it("renders backend context summary without audit metadata terms", () => {
    const text = backendContextSummary({
      used_recent_operational_context: true,
      source_refs: ["source_ref:abc"],
      backend_context_inputs: true,
      what_not_to_conclude: ["real-world context is not child evidence"],
    });

    expectClean(text);
    expect(text).toContain("Používá včerejší důležitý kontext");
    expect(text).toContain("Nejdřív ověřit vlastní reakci kluků");
  });

  it("renders reality context as user-facing prose", () => {
    const text = realityContextText({
      greeting: "",
      last_3_days: "",
      decisions: [],
      ask_hanka: [],
      ask_kata: [],
      closing: "",
      operational_context_used: [
        {
          summary: "Timmi/keporkak: therapist_factual_correction; faktická korekce reality; not child evidence; source_ref",
          evidence_level: "external_fact",
        },
      ],
    });

    expectClean(text);
    expect(text).toContain("Timmi/keporkak");
    expect(text).toContain("Samo o sobě to ještě nevypovídá");
  });

  it("does not render a one-block technical fallback as executable session", () => {
    const view = toProposedSessionView({
      part_name: "tundrupek",
      why_today: "pending_review backend_context_inputs",
      led_by: "Hanička",
      first_draft: "Evidence-limited bezpečné ověření připravenosti needs_therapist_input",
      agenda_outline: [{ block: "Evidence-limited bezpečné ověření připravenosti", minutes: 10, detail: "needs_therapist_input" }],
    });

    expect(view?.executable).toBe(false);
    expect(view?.blocks).toHaveLength(0);
    expect(view?.status_label).toContain("není připraveno");
    expectClean(JSON.stringify(view));
  });

  it("keeps therapist-led session role contract visible and safe", () => {
    const view = toProposedSessionView({
      part_name: "tundrupek",
      why_today: "Ověřit aktuální stav.",
      led_by: "Hanička",
      duration_min: 45,
      first_draft: "Terapeutkou vedené sezení.",
      agenda_outline: [
        { block: "Bezpečný vstup", minutes: 8, detail: "Ověřit bezpečí." },
        { block: "Mapování těla", minutes: 10, detail: "Sledovat tělesnou reakci." },
        { block: "Opatrné téma", minutes: 15, detail: "Nabídnout volbu." },
        { block: "Měkké ukončení", minutes: 8, detail: "Shrnout ověřené." },
      ],
    });

    expect(view?.executable).toBe(true);
    expect(view?.lead).toBe("Hanička");
    expect(view?.status_label).toContain("Karel asistuje");
    expect(view?.blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("renders playroom as human text with therapist approval gate", () => {
    const view = toProposedPlayroomView({
      part_name: "tundrupek",
      status: "awaiting_therapist_review",
      why_this_part_today: "backend_context_inputs source_ref",
      main_theme: "Bezpečný kontakt",
      goals: ["needs_therapist_input", "ověřit dostupnost"],
      playroom_plan: {
        therapeutic_program: [{ block: "Bezpečný práh", minutes: 3, detail: "awaiting_therapist_review" }],
        child_safe_version: "Dnes jen opatrně.",
        risks_and_stop_signals: ["zahlcení"],
      },
    });

    expect(view?.lead_label).toBe("vede Karel");
    expect(view?.approval_label).toContain("schválení terapeutkami");
    expectClean(JSON.stringify(view));
  });

  it("rewrites rule-like third-person opening into Karel's first-person clinical voice", () => {
    const visible = ensureKarelOpeningVoice(
      "Dnešní přehled drží Timmiho jako skutečnou událost. Sezení nesmí vést Karel sám; Karel je jen navigátor a zapisovatel. Herna může běžet jen jako schválený kontakt.",
    );

    for (const term of ["Karel je", "Karel bude", "Karel nesmí", "Karel může", "Dnešní přehled drží", "Sezení nesmí", "Herna může běžet jen"]) {
      expect(visible).not.toContain(term);
    }
    expect(visible).toContain("Včerejší událost s Timmim/keporkakem");
    expect(visible).toContain("Budu jí pomáhat");
    expect(visible).toContain("Potřebujeme jemně zjistit");
  });

  it("never labels a 3-day-old playroom as 'včerejší' in visible prose", () => {
    const playRecency = {
      exists: true,
      session_date_iso: "2026-04-27",
      days_since_today: 3,
      human_recency_label: "před 3 dny",
      is_yesterday: false,
    };
    const out = humanizeRecencyInProse(
      "Symboly z včerejška a navázat na včerejší Hernu, ze včerejší Herny pokračujeme.",
      playRecency,
      null,
    );
    expect(out).not.toMatch(/včerejší\s+Hernu/i);
    expect(out).not.toMatch(/ze\s+včerejška/i);
    expect(out.toLowerCase()).toContain("poslední herna z");
    expect(out).toContain("před 3 dny");
  });

  it("never labels a 2-day-old session as 'včerejší' in visible prose", () => {
    const sessRecency = {
      exists: true,
      session_date_iso: "2026-04-28",
      days_since_today: 2,
      human_recency_label: "předevčírem",
      is_yesterday: false,
    };
    const out = humanizeRecencyInProse(
      "Včerejší Sezení s tundrupkem ukázalo posun. Ze včerejšího Sezení vyplývá kontakt.",
      null,
      sessRecency,
    );
    expect(out).not.toMatch(/Včerejší\s+Sezení/);
    expect(out).not.toMatch(/ze\s+včerejšího\s+Sezení/i);
    expect(out).toContain("předevčerejší Sezení");
  });

  it("opening monologue is sanitized for non-yesterday playroom recency", () => {
    const playRecency = {
      exists: true,
      session_date_iso: "2026-04-27",
      days_since_today: 3,
      human_recency_label: "před 3 dny",
      is_yesterday: false,
    };
    const visible = ensureKarelOpeningVoice(
      "Dnes navážeme na včerejší Hernu s tundrupkem; ze včerejší Herny vyplývá důležitý posun.",
      playRecency,
      null,
    );
    expect(visible).not.toMatch(/včerejší\s+Hernu/i);
    expect(visible).not.toMatch(/ze\s+včerejší\s+Herny/i);
  });

  it("opening monologue NEVER contains the 'Herna/Sezení neproběhla' notice — that belongs only to the dedicated section", () => {
    const monologWithNotice = [
      "Dobré ráno, Haničko a Káťo.",
      "Včera Herna neproběhla. Poslední doložená Herna s Tundrupkem je z 27. 4. 2026, tedy před 3 dny.",
      "Dnes chci navazovat jen na přesně datovaný materiál klidně a bez tlaku.",
    ].join("\n\n");
    const out = ensureKarelOpeningVoice(monologWithNotice, null, null);
    expect(out).not.toMatch(/V[čc]era\s+Herna\s+neprob[eě]hla/i);
    expect(out).not.toMatch(/V[čc]erej[šs][íi]\s+Herna\s+neprob[eě]hla/i);
    expect(out).toContain("Dobré ráno");
    expect(out).toContain("Dnes chci navazovat");
  });

  it("opening monologue strips 'Včera Sezení neproběhlo' as well", () => {
    const monolog = "Dobré ráno, Haničko a Káťo.\n\nVčera Sezení neproběhlo. Pracujeme s tím, co máme z minulého týdne.\n\nDnešní priorita je ověřit dostupnost.";
    const out = ensureKarelOpeningVoice(monolog, null, null);
    expect(out).not.toMatch(/V[čc]era\s+Sezen[íi]\s+neprob[eě]hlo/i);
    expect(out).toContain("Dnešní priorita");
  });

  it("opening monologue strips 'Poslední doložená Herna ... je z DD. M. YYYY, tedy před N dny.' admin sentence", () => {
    const monolog = [
      "Dobré ráno, Haničko a Káťo.",
      "Poslední doložená Herna s Tundrupek je z 27. 4. 2026, tedy před 3 dny. Událost s Timmim/keporkakem vnímám jako silný emoční otisk.",
      "Moje pracovní formulace pro dnešek je opatrná.",
    ].join("\n\n");
    const out = ensureKarelOpeningVoice(monolog, null, null);
    expect(out).not.toMatch(/Posledn[íi]\s+dolo[žz]en[áa]\s+Herna[^.!?]*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i);
    expect(out).toContain("Dobré ráno");
    expect(out).toContain("Událost s Timmim");
    expect(out).toContain("Moje pracovní formulace");
  });

  it("opening monologue strips 'Předevčerejší Sezení proběhlo DD. M. YYYY.' dated recency sentence", () => {
    const monolog = "Dobré ráno.\n\nPředevčerejší Sezení proběhlo 28. 4. 2026. Beru ho jako otevřené.\n\nDnes ověřujeme stav.";
    const out = ensureKarelOpeningVoice(monolog, null, null);
    expect(out).not.toMatch(/P[řr]edev[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo\s+\d/i);
    expect(out).toContain("Dnes ověřujeme stav");
  });

  it("frontend revalidates stale cached session recency and exposes the old-briefing banner text", () => {
    const recency = revalidateRecencyForViewer({
      exists: true,
      source_date_iso: "2026-04-29",
      is_yesterday: true,
      human_recency_label: "včera",
    }, "2026-05-01", "session");
    const text = humanizeRecencyInProse("Včerejší Sezení proběhlo 29. 4. 2026.", null, recency);
    const banner = briefingFreshnessBannerText("2026-04-30", "2026-05-01");
    const meta = getBriefingFreshnessMeta("2026-04-30", "2026-05-01");

    expect(text).not.toMatch(/Včerejší\s+Sezení/);
    expect(text).toContain("29. 4. 2026");
    expect(text).toMatch(/předevčírem|Poslední doložené Sezení/);
    expect(banner).toBe("Zobrazuji poslední dostupný přehled ze dne 30. 4. 2026. Dnešní přehled zatím nevznikl.");
    expect(meta.is_current_briefing).toBe(false);
    expect(meta.days_since_briefing).toBe(1);
  });

  it("frontend renders exact 3-day-old playroom notice without calling it yesterday", () => {
    const recency = revalidateRecencyForViewer({
      exists: true,
      source_date_iso: "2026-04-27",
      session_date_iso: "2026-04-27",
      part_name: "Tundrupek",
    } as any, "2026-04-30", "playroom");
    const notice = recencySectionNoticeText("playroom", recency, "Tundrupek");

    expect(recency?.visible_label).toBe("Poslední Herna");
    expect(recency?.is_yesterday).toBe(false);
    expect(recency?.days_since_today).toBe(3);
    expect(recency?.human_recency_label).toBe("před 3 dny");
    expect(notice).toContain("Včera Herna neproběhla.");
    expect(notice).toContain("Poslední doložená Herna s Tundrupkem proběhla 27. 4. 2026, tedy před 3 dny.");
    expect(notice).not.toMatch(/Včerejší\s+Herna|včerejší\s+herní\s+materiál|ze\s+včerejší\s+Herny|navázat\s+na\s+včerejší\s+Hernu/i);
  });
});

describe("frozen 'Včerejší X proběhlo DD. M. YYYY' pattern is sanitized", () => {
  it("rewrites session sentence to absolute-date-first when viewer date is the day after source", () => {
    const sessRecency: any = {
      exists: true,
      held: true,
      source_date_iso: "2026-04-29",
      session_date_iso: "2026-04-29",
      days_since_today: 1,
      is_yesterday: true,
      human_recency_label: "včera",
    };
    const out = humanizeRecencyInProse("Včerejší Sezení proběhlo 29. 4. 2026.", null, sessRecency);
    expect(out).not.toMatch(/V[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo\s+\d/);
    expect(out).toContain("29. 4. 2026");
    expect(out).toContain("včera");
  });

  it("rewrites session sentence with 'předevčírem' when viewer is two days after source", () => {
    const sessRecency: any = {
      exists: true,
      held: true,
      source_date_iso: "2026-04-29",
      session_date_iso: "2026-04-29",
      days_since_today: 2,
      is_yesterday: false,
      human_recency_label: "předevčírem",
    };
    const out = humanizeRecencyInProse("Včerejší Sezení proběhlo 29. 4. 2026.", null, sessRecency);
    expect(out).not.toMatch(/V[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo\s+\d/);
    expect(out).toContain("29. 4. 2026");
    expect(out).toContain("předevčírem");
  });

  it("rewrites playroom sentence the same way", () => {
    const playRecency: any = {
      exists: true,
      held: true,
      source_date_iso: "2026-04-29",
      session_date_iso: "2026-04-29",
      days_since_today: 1,
      is_yesterday: true,
      human_recency_label: "včera",
    };
    const out = humanizeRecencyInProse("Včerejší Herna proběhla 29. 4. 2026.", playRecency, null);
    expect(out).not.toMatch(/V[čc]erej[šs][íi]\s+Herna\s+prob[eě]hla\s+\d/);
    expect(out).toContain("29. 4. 2026");
    expect(out).toContain("včera");
  });

  it("rewrites the section heading 'VČEREJŠÍ DŮLEŽITÝ KONTEXT'", () => {
    const out = humanizeRecencyInProse("VČEREJŠÍ DŮLEŽITÝ KONTEXT\nněco", null, null);
    expect(out).not.toContain("VČEREJŠÍ DŮLEŽITÝ KONTEXT");
    expect(out).toContain("DŮLEŽITÝ KONTEXT Z POSLEDNÍCH DNÍ");
  });
});
