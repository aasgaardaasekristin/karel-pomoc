import { describe, expect, it } from "vitest";
import { formatActionTitle, cleanDisplayName } from "@/lib/didPartNaming";

/**
 * P33.10.1A — Action dialog part-name grammar.
 *
 * Locks the visible-title contract for action / workspace / deliberation
 * dialogs that are spawned from briefing items. The dash format is the
 * safe canonical form because it sidesteps Czech declension errors like
 * "Plán dnešní herny s tundrupek".
 *
 * Acceptance flags:
 *  - no lowercase part names in visible dialog titles
 *  - no "s tundrupek" / "s arthur" / "s gustik"
 *  - no technical "002_" prefixes
 *  - briefing-ask-resolve and DidDailyBriefingPanel both use the helper
 */

describe("P33.10.1A — formatActionTitle dash format", () => {
  it("'tundrupek' → 'Plán dnešní herny — Tundrupek' (never 's tundrupek')", () => {
    const t = formatActionTitle("Plán dnešní herny", "tundrupek");
    expect(t).toBe("Plán dnešní herny — Tundrupek");
    expect(t).not.toMatch(/s tundrupek/i);
    expect(t).not.toMatch(/\bs [a-zěščřžýáíéůúťďň]/);
  });

  it("'arthur' → 'Plán sezení — Arthur' (never 's arthur')", () => {
    const t = formatActionTitle("Plán sezení", "arthur");
    expect(t).toBe("Plán sezení — Arthur");
    expect(t).not.toMatch(/s arthur/i);
  });

  it("'gustik' → 'Porada k části — Gustik' (never 's gustik')", () => {
    const t = formatActionTitle("Porada k části", "gustik");
    expect(t).toBe("Porada k části — Gustik");
    expect(t).not.toMatch(/s gustik/i);
  });

  it("'002_Anička' strips the technical prefix", () => {
    const t = formatActionTitle("Plán dnešní herny", "002_Anička");
    expect(t).toBe("Plán dnešní herny — Anička");
    expect(t).not.toMatch(/002_/);
  });

  it("falls back to the bare prefix when raw is empty", () => {
    expect(formatActionTitle("Plán sezení", "")).toBe("Plán sezení");
    expect(formatActionTitle("Plán sezení", null as any)).toBe("Plán sezení");
    expect(formatActionTitle("Plán sezení", undefined as any)).toBe("Plán sezení");
  });

  it("preserves diacritics in display name", () => {
    expect(cleanDisplayName("tundrupek")).toBe("Tundrupek");
    expect(cleanDisplayName("anička")).toBe("Anička");
  });
});

describe("P33.10.1A — call-site lock (DidDailyBriefingPanel)", () => {
  it("DidDailyBriefingPanel.tsx uses formatActionTitle for both session + playroom titles and never builds 'Plán ... s ${' literals", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/components/did/DidDailyBriefingPanel.tsx", "utf-8");
    expect(src).toContain('formatActionTitle("Plán sezení"');
    expect(src).toContain('formatActionTitle("Plán dnešní herny"');
    // The buggy literal patterns must not reappear.
    expect(src).not.toMatch(/`Plán sezení s \$\{/);
    expect(src).not.toMatch(/`Plán dnešní herny s \$\{/);
  });

  it("Chat.tsx session-thread intro uses formatActionTitle and a sanitized display name", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/pages/Chat.tsx", "utf-8");
    expect(src).toContain('formatActionTitle("Plán sezení", sessionPart)');
    expect(src).not.toMatch(/`Plán sezení s \$\{sessionPart\}`/);
    // threadLabel must be in dash form, not "Sezení: ${sessionPart}"
    expect(src).not.toMatch(/`Sezení: \$\{sessionPart\}`/);
  });

  it("karel-briefing-ask-resolve edge function uses formatActionTitle for its prefill titles", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      "supabase/functions/karel-briefing-ask-resolve/index.ts",
      "utf-8",
    );
    expect(src).toContain('formatActionTitle("Plán dnešní herny", s.part_name)');
    expect(src).toContain('formatActionTitle("Plán sezení", s.part_name)');
    expect(src).not.toMatch(/`Plán sezení s \$\{s\.part_name\}`/);
    expect(src).not.toMatch(/`Plán dnešní herny s \$\{s\.part_name\}`/);
  });
});
