/**
 * P16 — Primary morning orchestrator + "DB review" visible-text guard
 * ───────────────────────────────────────────────────────────────────
 * Acceptance contract:
 *   1. The phrase "DB review" must NEVER appear in visible clinical text.
 *      The sanitizer must replace it with human Czech ("dřívější záznam").
 *   2. Method classification: latest primary briefing (method "auto" or
 *      "primary_orchestrator") MUST be categorized as "primary" — never
 *      "watchdog" or "manual".
 *   3. A watchdog row never beats a primary row when both exist for the
 *      same date — this is enforced upstream, but we keep the categorization
 *      contract pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeBriefingVisibleText,
  detectClinicalTextViolations,
  FORBIDDEN_TECHNICAL_TERMS,
} from "@/lib/visibleClinicalTextGuard";
import {
  categorizeBriefingMethod,
  isPrimaryBriefingMethod,
  isWatchdogBriefingMethod,
} from "@/lib/briefingMethodAuthority";

describe("P16 — DB review visible-text guard", () => {
  it("lists 'DB review' among forbidden technical terms", () => {
    expect(FORBIDDEN_TECHNICAL_TERMS).toContain("DB review");
  });

  it("sanitizes 'z DB review' → 'z dřívějšího záznamu' in briefing text", () => {
    const input =
      "Beru to jako bezpečně omezený přehled: závěry z Herny jsou převzaté z DB review a návrh další Herny je na ně výslovně navázaný.";
    const out = sanitizeBriefingVisibleText(input);
    expect(out.text).not.toMatch(/DB review/i);
    expect(out.text).toMatch(/z dřívějšího záznamu/);
    expect(out.replaced).toBe(true);
  });

  it("sanitizes standalone 'DB review' → 'dřívější záznam'", () => {
    const out = sanitizeBriefingVisibleText("Použito jako DB review pro dnešek.");
    expect(out.text).not.toMatch(/DB review/i);
    expect(out.text).toMatch(/dřívější záznam/);
  });

  it("detects 'DB review' as a forbidden_technical_term violation when present raw", () => {
    const violations = detectClinicalTextViolations("Vstup: DB review.", {
      surface: "briefing",
    });
    expect(
      violations.some(
        (v) => v.kind === "forbidden_technical_term" && /DB review/i.test(v.match),
      ),
    ).toBe(true);
  });
});

describe("P16 — primary briefing method authority", () => {
  it("'auto' is categorized as primary (not watchdog)", () => {
    expect(categorizeBriefingMethod("auto")).toBe("primary");
    expect(isPrimaryBriefingMethod("auto")).toBe(true);
    expect(isWatchdogBriefingMethod("auto")).toBe(false);
  });

  it("'primary_orchestrator' is categorized as primary", () => {
    expect(categorizeBriefingMethod("primary_orchestrator")).toBe("primary");
    expect(isPrimaryBriefingMethod("primary_orchestrator")).toBe(true);
  });

  it("'sla_watchdog' is categorized as watchdog (never primary)", () => {
    expect(categorizeBriefingMethod("sla_watchdog")).toBe("watchdog");
    expect(isPrimaryBriefingMethod("sla_watchdog")).toBe(false);
    expect(isWatchdogBriefingMethod("sla_watchdog")).toBe(true);
  });
});
