import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * P31.1b — UI display-rule regression.
 *
 * Tento test je source-level guard, ne plnohodnotný DOM render
 * (DidDailyBriefingPanel.tsx je 2200+ řádků s desítkami závislostí
 * na supabase/hooks; plné mountování by skončilo ve flaky režimu).
 * Místo toho ověřujeme kontrakt přímo nad zdrojákem:
 *
 *  1. Existuje data-testid="karel-human-briefing" gated na ok=true.
 *  2. Existuje fallback "Humanizovaná vrstva není dostupná" pro ok=false.
 *  3. Strukturované sekce (last_3_days, lingering, daily_therapeutic_priority,
 *     visibleRealityContext) jsou wrapped guardem
 *     `!((p as any).karel_human_briefing?.ok === true)` — takže když human
 *     vrstva je primární, nezobrazí se duplicitní strukturovaný text.
 *  4. Žádné z interních pojmů (`payload`, `truth gate`, `job graph`,
 *     `pipeline`, `provider_status`) NEJSOU součástí textu, který panel
 *     rendruje terapeutce. (Substring je povolený jen v komentářích nebo
 *     v `data-*` / `data-testid` atributech.)
 *  5. Map přes hb.sections je null-safe: kontroluje `Array.isArray` +
 *     `length > 0` + `s?.section_id || idx` jako key.
 */

const PANEL = readFileSync(
  resolve(__dirname, "../components/did/DidDailyBriefingPanel.tsx"),
  "utf8",
);

describe("P31.1b briefing panel display rule", () => {
  it("rendruje human briefing pouze když ok === true a sections.length > 0", () => {
    expect(PANEL).toContain('data-testid="karel-human-briefing"');
    expect(PANEL).toMatch(/hb\.ok === true/);
    expect(PANEL).toMatch(/Array\.isArray\(hb\.sections\)/);
    expect(PANEL).toMatch(/hb\.sections\.length\s*>\s*0/);
  });

  it("má fallback hlášku pro ok=false", () => {
    expect(PANEL).toContain("Humanizovaná vrstva není dostupná");
    expect(PANEL).toContain('data-testid="karel-human-briefing-fallback"');
  });

  it("strukturované hlavní sekce jsou skryté, když je human vrstva primární", () => {
    // Před hlavním blokem strukturovaných sekcí musí být guard.
    expect(PANEL).toMatch(
      /!\(\(p as any\)\.karel_human_briefing\?\.ok === true\)\s*&&\s*\(<>/,
    );
    // Schovaná verze strukturovaných podkladů jako collapsed details.
    expect(PANEL).toContain('data-testid="briefing-structured-collapsed"');
    expect(PANEL).toContain("Technické podklady");
  });

  it("null-safe map přes sections (key fallback na idx, prázdný karel_text se vyhodí)", () => {
    expect(PANEL).toMatch(/hb\.sections\.map\(\(s: any, idx: number\)/);
    expect(PANEL).toMatch(/s\?\.section_id\s*\|\|\s*idx/);
    expect(PANEL).toMatch(/if \(!text\.trim\(\)\) return null/);
  });

  it("renderovaný text neobsahuje žádné interní/technické pojmy v UI", () => {
    // Odstraníme komentáře a data-* atributy; co zbude je text pro UI.
    const stripped = PANEL
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/data-[a-z-]+=\{[^}]*\}/g, "")
      .replace(/data-[a-z-]+="[^"]*"/g, "");
    const forbidden = ["truth gate", "job graph", "provider_status"];
    for (const term of forbidden) {
      expect(stripped.toLowerCase()).not.toContain(term.toLowerCase());
    }
    // "payload" a "pipeline" smí být v identifikátorech (p.payload),
    // takže kontrolujeme jen literály, které by viděla terapeutka.
    expect(stripped).not.toMatch(/>\s*payload\s*</i);
    expect(stripped).not.toMatch(/>\s*pipeline\s*</i);
  });
});
