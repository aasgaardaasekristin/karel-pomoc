import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef, useEffect } from "react";
import {
  sanitizeVisibleClinicalText,
  sanitizeBriefingVisibleText,
  sanitizeDeliberationVisibleText,
  sanitizeHernaVisibleText,
  sanitizeLiveSessionVisibleText,
  detectClinicalTextViolations,
  countVisibleForbiddenTerms,
  visibleTextQualityAudit,
  useVisibleClinicalTextAudit,
  FORBIDDEN_TECHNICAL_TERMS,
} from "@/lib/visibleClinicalTextGuard";

describe("visibleClinicalTextGuard — helper", () => {
  it("sanitizes legacy bad text and reduces forbidden_count to 0", () => {
    const legacy =
      "program_draft je first_draft pro session_params; backend_context_inputs ukazují operational context. Bezformátový program. Karel-led plán.";
    const before = countVisibleForbiddenTerms(legacy, { surface: "briefing" });
    expect(before).toBeGreaterThan(0);
    const { text } = sanitizeVisibleClinicalText(legacy, { surface: "briefing" });
    const after = countVisibleForbiddenTerms(text, { surface: "briefing" });
    expect(after).toBe(0);
    expect(text).not.toMatch(/program_draft|first_draft|session_params|backend_context_inputs|Bezformátový/i);
    expect(text).toContain("návrh programu");
    expect(text).toContain("kontext z posledních dní");
  });

  it("repairs awkward Czech phrases", () => {
    const out = sanitizeBriefingVisibleText(
      "Herna je vedená Karlem práce. Používá důležitý kontext z posledních dní. Co je jen stopa v datech.",
    );
    expect(out).not.toMatch(/Herna je vedená Karlem práce/);
    expect(out).not.toMatch(/Používá důležitý kontext z posledních dní/);
    expect(out).not.toMatch(/Co je jen stopa v datech/);
    expect(out).toContain("Hernu vede Karel");
  });

  it("allows negated clinical assertions but blocks positive ones (sentence-level)", () => {
    const negated = "Beru to ne jako projekce, jen jako tělesnou reakci.";
    expect(detectClinicalTextViolations(negated, { surface: "briefing" })).toHaveLength(0);

    const positive = "Tato reakce je to projekce ze strany kluků.";
    const v = detectClinicalTextViolations(positive, { surface: "briefing" });
    expect(v.some((x) => x.kind === "ungrounded_clinical_assertion")).toBe(true);
  });

  it("sentence-level negation: 'nesmí z toho dělat symbolický nebo diagnostický závěr' → 0 violations", () => {
    const t = "Karel z toho nesmí dělat symbolický nebo diagnostický závěr bez přímé reakce kluků.";
    const v = detectClinicalTextViolations(t, { surface: "herna-modal" });
    expect(v.filter((x) => x.kind === "ungrounded_clinical_assertion")).toHaveLength(0);
  });

  it("sentence-level negation: 'ne jako projekce, symbol ani diagnostický signál' → 0 violations", () => {
    const t = "Vnímáme to ne jako projekce, symbol ani diagnostický signál.";
    const v = detectClinicalTextViolations(t, { surface: "herna-modal" });
    expect(v.filter((x) => x.kind === "ungrounded_clinical_assertion")).toHaveLength(0);
  });

  it("positive 'je to diagnostický signál' is flagged", () => {
    const t = "Podle Karla je to diagnostický signál pro nový směr.";
    const v = detectClinicalTextViolations(t, { surface: "briefing" });
    expect(v.some((x) => /diagnostick/.test(x.match))).toBe(true);
  });

  it("positive 'Timmy symbolizuje opuštění' is flagged", () => {
    const t = "Timmy symbolizuje opuštění a strach.";
    const v = detectClinicalTextViolations(t, { surface: "briefing" });
    expect(v.some((x) => x.match === "symbolizuje")).toBe(true);
  });

  it("flags 'Živý program sezení' only inside herna-modal surface", () => {
    const text = "Živý program sezení ukazuje další blok.";
    expect(countVisibleForbiddenTerms(text, { surface: "live-session" })).toBe(0);
    const v = detectClinicalTextViolations(text, { surface: "herna-modal" });
    expect(v.some((x) => x.kind === "context_forbidden_label" && /Živý program sezení/.test(x.match))).toBe(true);
  });

  it("flags 'Změna plánu: beze změny' only in replan/in_revision team-deliberation", () => {
    const t = "Změna plánu: beze změny.";
    expect(countVisibleForbiddenTerms(t, { surface: "team-deliberation", status: "approved" })).toBe(0);
    expect(countVisibleForbiddenTerms(t, { surface: "team-deliberation", status: "replan" })).toBeGreaterThan(0);
    expect(countVisibleForbiddenTerms(t, { surface: "team-deliberation", status: "in_revision" })).toBeGreaterThan(0);
  });

  it("flags 'Vyžaduje terapeutku: Ne' only in unapproved Herna", () => {
    const t = "Vyžaduje terapeutku: Ne.";
    expect(countVisibleForbiddenTerms(t, { surface: "herna-modal", hernaUnapproved: false })).toBe(0);
    expect(countVisibleForbiddenTerms(t, { surface: "herna-modal", hernaUnapproved: true })).toBeGreaterThan(0);
  });

  it("does not silently rewrite text — therapist-authored raw quotes pass through visibleTextQualityAudit if clean", () => {
    const therapist = "Káťa: dnes Tundrupek vypadal klidnější, sám si vzal vodu.";
    const audit = visibleTextQualityAudit(therapist, { surface: "team-deliberation" });
    expect(audit.ok).toBe(true);
    expect(audit.forbidden_count).toBe(0);
  });

  it("panel-specific wrappers all delegate to the same engine", () => {
    const bad = "program_draft Bezformátový program";
    expect(sanitizeBriefingVisibleText(bad)).not.toMatch(/program_draft|Bezformátový/i);
    expect(sanitizeDeliberationVisibleText(bad)).not.toMatch(/program_draft|Bezformátový/i);
    expect(sanitizeHernaVisibleText(bad)).not.toMatch(/program_draft|Bezformátový/i);
    expect(sanitizeLiveSessionVisibleText(bad)).not.toMatch(/program_draft|Bezformátový/i);
  });

  it("forbidden lexicon contains the P1 prompt minimum set", () => {
    for (const t of [
      "backend",
      "pipeline",
      "source_ref",
      "source_kind",
      "Pantry",
      "karel_pantry_b_entries",
      "DID-relevantní",
      "ingestion",
      "event_ingestion",
      "program_draft",
      "session_params",
      "first_draft",
      "Karel-led",
      "pending_review",
      "evidence_limited",
      "child evidence",
      "operational context",
      "backend_context_inputs",
      "Bezformátový program",
    ]) {
      expect(FORBIDDEN_TECHNICAL_TERMS).toContain(t);
    }
  });
});

describe("useVisibleClinicalTextAudit", () => {
  it("throws in test env when violation present in DOM", () => {
    const Probe = () => {
      const ref = useRef<HTMLDivElement>(null);
      // Throw-on-violation in test env (default).
      useVisibleClinicalTextAudit("herna-modal", ref);
      return null;
    };
    // Mount a div with a violation, attach ref imperatively.
    const node = document.createElement("div");
    node.setAttribute("data-visible-clinical-panel", "herna-modal");
    node.textContent = "Vyžaduje terapeutku: Ne. Živý program sezení.";
    document.body.appendChild(node);
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLDivElement>(null);
        // Force ref to point to our prepared node.
        (ref as any).current = node;
        useEffect(() => {}, []);
        useVisibleClinicalTextAudit("herna-modal", ref, {
          failInTest: true,
          hernaUnapproved: true,
        });
      });
    }).toThrow(/visibleClinicalTextAudit.*herna-modal.*forbidden_count=/);
    document.body.removeChild(node);
    void Probe;
  });

  it("does not throw when DOM is clean", () => {
    const node = document.createElement("div");
    node.textContent = "Hernu vede Karel. Vychází z toho, co se v posledních dnech opravdu stalo.";
    document.body.appendChild(node);
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLDivElement>(null);
        (ref as any).current = node;
        useVisibleClinicalTextAudit("herna-modal", ref, { failInTest: true });
      });
    }).not.toThrow();
    document.body.removeChild(node);
  });

  it("excludes raw therapist-authored regions from audit", () => {
    const node = document.createElement("div");
    const raw = document.createElement("div");
    raw.setAttribute("data-clinical-raw-source", "therapist");
    // Even if raw therapist quote contains a forbidden technical term,
    // the audit must NOT trip on it (we only audit Karel-generated UI).
    raw.textContent = "Káťa říkala doslova: 'program_draft mě mátl'.";
    node.appendChild(raw);
    const clean = document.createElement("p");
    clean.textContent = "Hernu vede Karel.";
    node.appendChild(clean);
    document.body.appendChild(node);
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLDivElement>(null);
        (ref as any).current = node;
        useVisibleClinicalTextAudit("herna-modal", ref, { failInTest: true });
      });
    }).not.toThrow();
    document.body.removeChild(node);
  });
});
