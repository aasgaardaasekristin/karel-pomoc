/**
 * Section A Updater — "Identita a aktuální stav"
 *
 * Aktualizuje sekci A karty DID části na základě SectionUpdate[] z threadAnalyzer.
 * Čistá funkce (pure): vstup → výstup, žádné side effects (kromě findContradiction,
 * která volá edge funkci pro AI detekci rozporů).
 */

import type { SectionUpdate } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   TYPY
   ================================================================ */

export interface ContradictionResult {
  found: boolean;
  contradictedSentence: string | null;
  reasoning: string | null;
}

/* ================================================================
   DETEKCE ROZPORŮ (AI)
   ================================================================ */

/**
 * Porovná novou informaci s existujícím textem a detekuje rozpor.
 * Volá edge funkci karel-contradiction-check, která komunikuje s AI.
 */
export async function findContradiction(
  existingText: string,
  newInfo: string,
): Promise<ContradictionResult> {
  const noContradiction: ContradictionResult = {
    found: false,
    contradictedSentence: null,
    reasoning: null,
  };

  if (!existingText.trim() || !newInfo.trim()) return noContradiction;

  try {
    const { data, error } = await supabase.functions.invoke(
      "karel-contradiction-check",
      {
        body: { existingText, newInfo },
      },
    );

    if (error) {
      console.error("[SectionA] Contradiction check failed:", error);
      return noContradiction;
    }

    return {
      found: data?.found ?? false,
      contradictedSentence: data?.contradictedSentence ?? null,
      reasoning: data?.reasoning ?? null,
    };
  } catch (err) {
    console.error("[SectionA] Contradiction check error:", err);
    return noContradiction;
  }
}

/* ================================================================
   PARSERY ODSTAVCŮ
   ================================================================ */

const PARAGRAPH_HEADERS = [
  "Aktuální stav",
  "Povědomí o systému a role",
  "Vztahy",
  "Co ho uklidňuje",
  "Ochranné mechanismy",
] as const;

interface ParsedParagraphs {
  aktualni_stav: string;
  povedomí_o_systemu_a_role: string;
  vztahy: string;
  co_ho_uklidnuje: string;
  ochranne_mechanismy: string;
  rest: string;
}

/**
 * Rozloží surový text sekce A na jednotlivé odstavce podle nadpisů.
 */
function parseSectionA(raw: string): ParsedParagraphs {
  const result: ParsedParagraphs = {
    aktualni_stav: "",
    povedomí_o_systemu_a_role: "",
    vztahy: "",
    co_ho_uklidnuje: "",
    ochranne_mechanismy: "",
    rest: "",
  };

  const lines = raw.split("\n");
  let currentKey: keyof ParsedParagraphs | null = null;
  const buffer: string[] = [];

  const flushBuffer = () => {
    if (currentKey && buffer.length > 0) {
      result[currentKey] = buffer.join("\n").trim();
    }
    buffer.length = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const matchedHeader = detectHeader(trimmed);
    if (matchedHeader) {
      flushBuffer();
      currentKey = matchedHeader;
      continue;
    }
    if (currentKey) {
      buffer.push(line);
    } else {
      result.rest += line + "\n";
    }
  }
  flushBuffer();

  return result;
}

function detectHeader(line: string): keyof ParsedParagraphs | null {
  const cleaned = line.replace(/^#+\s*/, "").replace(/[*_]/g, "").trim().toLowerCase();

  if (cleaned.includes("aktuální stav")) return "aktualni_stav";
  if (cleaned.includes("povědomí o systému") || cleaned.includes("role")) return "povedomí_o_systemu_a_role";
  if (cleaned.includes("vztahy")) return "vztahy";
  if (cleaned.includes("co ho uklidňuje") || cleaned.includes("co ji uklidňuje") || cleaned.includes("uklidňuje")) return "co_ho_uklidnuje";
  if (cleaned.includes("ochranné mechanismy") || cleaned.includes("obranné mechanismy")) return "ochranne_mechanismy";
  return null;
}

/**
 * Složí odstavce zpátky do textu sekce A.
 */
function reassembleSectionA(p: ParsedParagraphs): string {
  const sections: string[] = [];

  if (p.rest.trim()) sections.push(p.rest.trim());

  sections.push(`### Aktuální stav\n${p.aktualni_stav}`);
  sections.push(`### Povědomí o systému a role\n${p.povedomí_o_systemu_a_role}`);
  sections.push(`### Vztahy\n${p.vztahy}`);
  sections.push(`### Co ho uklidňuje\n${p.co_ho_uklidnuje}`);
  sections.push(`### Ochranné mechanismy\n${p.ochranne_mechanismy}`);

  return sections.join("\n\n");
}

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

/**
 * Aktualizuje sekci A karty DID části.
 *
 * @param currentSectionA - aktuální text sekce A z Drive
 * @param updates - pole SectionUpdate[] pro sekci A z threadAnalyzer
 * @param threadDate - datum vlákna (ISO string nebo YYYY-MM-DD)
 * @returns aktualizovaný text sekce A
 */
export async function updateSectionA(
  currentSectionA: string,
  updates: SectionUpdate[],
  threadDate: string,
): Promise<string> {
  if (!updates.length) return currentSectionA;

  const paragraphs = parseSectionA(currentSectionA);
  const date = threadDate.slice(0, 10); // YYYY-MM-DD

  // Seskup updaty podle subsekce
  const bySubsection = groupBySubsection(updates);

  // 1. AKTUÁLNÍ STAV
  if (bySubsection.aktualni_stav?.length) {
    const latest = bySubsection.aktualni_stav[bySubsection.aktualni_stav.length - 1];
    paragraphs.aktualni_stav = `${date} - ${latest.content}`;
  }

  // 2. POVĚDOMÍ O SYSTÉMU A ROLE
  if (bySubsection.povedomí_o_systemu_a_role?.length) {
    paragraphs.povedomí_o_systemu_a_role = applyGenericUpdates(
      paragraphs.povedomí_o_systemu_a_role,
      bySubsection.povedomí_o_systemu_a_role,
      date,
    );
  }

  // 3. VZTAHY
  if (bySubsection.vztahy?.length) {
    paragraphs.vztahy = await applyVztahyUpdates(
      paragraphs.vztahy,
      bySubsection.vztahy,
      date,
    );
  }

  // 4. CO HO UKLIDŇUJE
  if (bySubsection.co_ho_uklidnuje?.length) {
    paragraphs.co_ho_uklidnuje = await applyUklidnujeUpdates(
      paragraphs.co_ho_uklidnuje,
      bySubsection.co_ho_uklidnuje,
      date,
    );
  }

  // 5. OCHRANNÉ MECHANISMY
  if (bySubsection.ochranne_mechanismy?.length) {
    paragraphs.ochranne_mechanismy = await applyMechanismyUpdates(
      paragraphs.ochranne_mechanismy,
      bySubsection.ochranne_mechanismy,
      date,
    );
  }

  return reassembleSectionA(paragraphs);
}

/* ================================================================
   AKTUALIZAČNÍ LOGIKA PRO ODSTAVCE
   ================================================================ */

function groupBySubsection(
  updates: SectionUpdate[],
): Record<string, SectionUpdate[]> {
  const groups: Record<string, SectionUpdate[]> = {};
  for (const u of updates) {
    const key = u.subsection;
    if (!groups[key]) groups[key] = [];
    groups[key].push(u);
  }
  return groups;
}

/**
 * Generická logika pro odstavce, které jen obohacujeme (Povědomí o systému).
 */
function applyGenericUpdates(
  existing: string,
  updates: SectionUpdate[],
  date: string,
): string {
  let text = existing;

  for (const u of updates) {
    switch (u.type) {
      case "add":
        text = appendLine(text, u.content);
        break;
      case "replace":
        text = text + `\n[Aktualizace ${date}]: ${u.content}`;
        break;
      case "annotate":
        text = text + `\n📝 Poznámka (${date}): ${u.content}`;
        break;
      case "delete":
        text = text + `\n⚠️ Neplatné od ${date}: ${u.content}`;
        break;
    }
  }

  return text;
}

/**
 * Vztahy – přidávání nových, anotace rozporů.
 */
async function applyVztahyUpdates(
  existing: string,
  updates: SectionUpdate[],
  date: string,
): Promise<string> {
  let text = existing;

  for (const u of updates) {
    if (u.type === "add") {
      text = appendLine(text, `${u.content}, zaznamenáno z vlákna dne ${date}`);
      continue;
    }

    // Pro replace/annotate hledáme rozpor
    const contradiction = await findContradiction(text, u.content);
    if (contradiction.found && contradiction.contradictedSentence) {
      text = text + `\n⚠️ Dne ${date} vyplývá z rozhovoru: ${u.content}. Možné příčiny: ${u.reasoning || contradiction.reasoning || "není stanoveno"}`;
    } else if (u.type === "annotate") {
      text = text + `\n📝 Poznámka (${date}): ${u.content}`;
    } else if (u.type === "replace") {
      text = appendLine(text, `${u.content}, zaznamenáno z vlákna dne ${date}`);
    }
  }

  return text;
}

/**
 * Co ho uklidňuje – přidávání, rozpory s citací.
 */
async function applyUklidnujeUpdates(
  existing: string,
  updates: SectionUpdate[],
  date: string,
): Promise<string> {
  let text = existing;

  for (const u of updates) {
    if (u.type === "add") {
      text = appendLine(text, u.content);
      continue;
    }

    const contradiction = await findContradiction(text, u.content);
    if (contradiction.found && contradiction.contradictedSentence) {
      text = text +
        `\n⚠️ Dne ${date} vyplývá z rozhovoru, že k ${contradiction.contradictedSentence} již není pozitivní vazba. ` +
        `Vyjádření (${date}): „${u.content}". ` +
        `Možné příčiny: ${u.reasoning || contradiction.reasoning || "není stanoveno"}`;
    } else if (u.type === "replace") {
      text = appendLine(text, `${u.content} (aktualizováno ${date})`);
    } else if (u.type === "annotate") {
      text = text + `\n📝 Poznámka (${date}): ${u.content}`;
    }
  }

  return text;
}

/**
 * Ochranné mechanismy – obohacení, rozpory.
 */
async function applyMechanismyUpdates(
  existing: string,
  updates: SectionUpdate[],
  date: string,
): Promise<string> {
  let text = existing;

  for (const u of updates) {
    if (u.type === "add") {
      text = appendLine(text, u.content);
      continue;
    }

    const contradiction = await findContradiction(text, u.content);
    if (contradiction.found) {
      text = text +
        `\n⚠️ Dle rozhovoru z vlákna (${date}) tato informace nemusí být platná. ` +
        `Důvod/odhad: ${u.reasoning || contradiction.reasoning || "není stanoveno"}`;
    } else if (u.type === "annotate") {
      text = text + `\n📝 Poznámka (${date}): ${u.content}`;
    } else if (u.type === "replace") {
      text = appendLine(text, `${u.content} (aktualizováno ${date})`);
    }
  }

  return text;
}

/* ================================================================
   UTILITY
   ================================================================ */

function appendLine(text: string, line: string): string {
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n- ${line}` : `- ${line}`;
}
