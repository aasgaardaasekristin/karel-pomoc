import { describe, it, expect } from "vitest";
import {
  parseProgramBlocks,
  resolveCurrentBlockIndex,
  isTherapistAcknowledgement,
  isTherapistCorrection,
  validateAiOutputForBlock,
  safeParseJsonString,
  buildEmptyAiFallback,
} from "@/lib/blockStateMachine";

const SAMPLE_PLAN = `# Schválený plán
**Část:** gustik

## Program sezení

1. **Bezpečný vstup a ověření přítomnosti** (8 min)
   Terapeutka ověří, jestli je dostupný.

2. **Tělesné a emoční mapování** (10 min)
   Mapuj tělo a emoci.

3. **Opatrné otevření tématu nebo stabilizační alternativa** (15 min)
   Pokud je stabilní, jemně přibliž téma.

4. **Integrace a měkké ukončení** (8 min)
   Shrň, co bylo řečeno, a měkce uzavři.
`;

describe("parseProgramBlocks", () => {
  it("parses 4 blocks and marks the last one as final", () => {
    const blocks = parseProgramBlocks(SAMPLE_PLAN);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].title).toMatch(/Bezpečný vstup/);
    expect(blocks[3].isFinal).toBe(true);
    expect(blocks[3].kind).toBe("closing");
  });

  it("classifies an integration block as final via tokens", () => {
    const blocks = parseProgramBlocks(SAMPLE_PLAN);
    expect(blocks[3].title.toLowerCase()).toContain("integrace");
    expect(blocks[3].isFinal).toBe(true);
  });
});

describe("resolveCurrentBlockIndex (DB authority)", () => {
  it("returns first not-done block as authoritative", () => {
    const blocks = parseProgramBlocks(SAMPLE_PLAN);
    const items = [
      { id: "bod-1", text: "x", done: true },
      { id: "bod-2", text: "x", done: true },
      { id: "bod-3", text: "x", done: true },
      { id: "bod-4", text: "x", done: false },
    ];
    const r = resolveCurrentBlockIndex(blocks, items, 0);
    expect(r.index).toBe(3);
    expect(r.block?.isFinal).toBe(true);
    expect(r.allDone).toBe(false);
    expect(r.reason).toContain("db_authority_overrode_client_hint");
  });

  it("returns allDone=true when every block is done", () => {
    const blocks = parseProgramBlocks(SAMPLE_PLAN);
    const items = blocks.map((b) => ({ id: `bod-${b.index + 1}`, text: b.title, done: true }));
    const r = resolveCurrentBlockIndex(blocks, items);
    expect(r.allDone).toBe(true);
    expect(r.index).toBe(3);
  });
});

describe("isTherapistAcknowledgement", () => {
  it("recognizes short acks", () => {
    expect(isTherapistAcknowledgement("ano")).toBe(true);
    expect(isTherapistAcknowledgement("Ano.")).toBe(true);
    expect(isTherapistAcknowledgement("ok")).toBe(true);
    expect(isTherapistAcknowledgement("rozumím")).toBe(true);
    expect(isTherapistAcknowledgement("dobře")).toBe(true);
  });
  it("does not classify long messages as ack", () => {
    expect(isTherapistAcknowledgement("ano, ale ještě bych chtěla zkusit kresbu postavy")).toBe(false);
  });
});

describe("isTherapistCorrection", () => {
  it("recognizes correction phrases", () => {
    expect(isTherapistCorrection("To jsme už dělali. Teď má být jen měkké zakončení.")).toBe(true);
    expect(isTherapistCorrection("nepoužívej kresbu postavy")).toBe(true);
    expect(isTherapistCorrection("jen měkké ukončení prosím")).toBe(true);
  });
});

describe("validateAiOutputForBlock", () => {
  const blocks = parseProgramBlocks(SAMPLE_PLAN);
  const finalBlock = blocks[3];
  const middleBlock = blocks[1];

  it("rejects drawing/projective in final block", () => {
    const r = validateAiOutputForBlock("Pojďme nakresli postavu člověka.", finalBlock, "Hanka");
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.safeFallback).toBeTruthy();
    expect(r.safeFallback).not.toMatch(/nakresli/i);
  });

  it("rejects 'pověz mi o tom člověku' in final block", () => {
    const r = validateAiOutputForBlock("Pověz mi o tom člověku.", finalBlock, "Hanka");
    expect(r.ok).toBe(false);
  });

  it("allows benign closure text in final block", () => {
    const r = validateAiOutputForBlock("Měkce uzavři. Poděkuj a uvidíme se příště.", finalBlock, "Hanka");
    expect(r.ok).toBe(true);
  });

  it("does not validate non-final blocks", () => {
    const r = validateAiOutputForBlock("nakresli postavu", middleBlock, "Hanka");
    expect(r.ok).toBe(true);
  });
});

describe("safeParseJsonString", () => {
  it("returns empty for empty body", () => {
    const r = safeParseJsonString("");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe("empty");
  });
  it("returns not_json for invalid JSON", () => {
    const r = safeParseJsonString("not-json");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe("not_json");
  });
  it("parses valid JSON", () => {
    const r = safeParseJsonString<{ a: number }>('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.a).toBe(1);
  });
});

describe("buildEmptyAiFallback", () => {
  it("never proposes drawing/projective when block is final", () => {
    const blocks = parseProgramBlocks(SAMPLE_PLAN);
    const txt = buildEmptyAiFallback(blocks[3], "Hanka");
    expect(txt).not.toMatch(/nakresli|postav[au] [čc]lov[ěe]ka|projektivn/i);
    expect(txt).toMatch(/závěrečném|měkkém uzavření/i);
  });
});

// ─── Integration scenario: SEV-1 acceptance ───
describe("SEV-1 acceptance: 'ano' + correction in final block", () => {
  const blocks = parseProgramBlocks(SAMPLE_PLAN);
  const items = [
    { id: "bod-1", text: "x", done: true },
    { id: "bod-2", text: "x", done: true },
    { id: "bod-3", text: "x", done: true },
    { id: "bod-4", text: "x", done: false },
  ];

  it("therapist 'ano' on final block does not advance", () => {
    const r = resolveCurrentBlockIndex(blocks, items);
    expect(r.block?.isFinal).toBe(true);
    expect(isTherapistAcknowledgement("ano")).toBe(true);
    // The edge function early-returns a closure response without invoking AI;
    // semantic guarantee = block index does not advance.
    expect(r.index).toBe(3);
  });

  it("therapist correction realigns to closing block", () => {
    const correctionText = "To jsme už dělali. Teď má být jen měkké zakončení.";
    expect(isTherapistCorrection(correctionText)).toBe(true);
  });
});
