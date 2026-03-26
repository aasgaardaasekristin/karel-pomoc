/**
 * Section C Updater — "Potřeby a rizika"
 *
 * Aktualizuje sekci C karty DID části na základě SectionUpdate[] z threadAnalyzer.
 * Obsahuje odstavce: Jádrové potřeby, Jádrové strachy, Triggery, Vnitřní konflikty, Identifikovaná rizika.
 *
 * Logika: Pro každý odstavec porovná stávající body s novými vlákny pomocí AI,
 * rotuje nejméně relevantní bod a aplikuje speciální pravidla pro každý typ.
 */

import type { SectionUpdate, Thread } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   TYPY
   ================================================================ */

type SubsectionKey =
  | "jadrove_potreby"
  | "jadrove_strachy"
  | "triggery"
  | "vnitrni_konflikty"
  | "identifikovana_rizika";

interface RotationResult {
  action: "rotate" | "add" | "annotate" | "none";
  removeIndex: number | null;
  newPoint: string | null;
  annotateIndex: number | null;
  annotation: string | null;
  reasoning: string;
}

/* ================================================================
   PARSOVÁNÍ SEKCE C
   ================================================================ */

interface ParsedSectionC {
  jadrove_potreby: string[];
  jadrove_strachy: string[];
  triggery: string[];
  vnitrni_konflikty: string[];
  identifikovana_rizika: string[];
  raw: string;
}

const SUBSECTION_HEADERS: Record<SubsectionKey, RegExp> = {
  jadrove_potreby: /j[áa]drov[ée]\s+pot[řr]eby/i,
  jadrove_strachy: /j[áa]drov[ée]\s+strachy/i,
  triggery: /trigger[yie]/i,
  vnitrni_konflikty: /vnit[řr]n[ií]\s+konflikty/i,
  identifikovana_rizika: /identifikovan[áa]\s+rizika/i,
};

function parseSectionC(text: string): ParsedSectionC {
  const result: ParsedSectionC = {
    jadrove_potreby: [],
    jadrove_strachy: [],
    triggery: [],
    vnitrni_konflikty: [],
    identifikovana_rizika: [],
    raw: text,
  };

  if (!text?.trim()) return result;

  const lines = text.split("\n");
  let currentKey: SubsectionKey | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect subsection header
    let matched = false;
    for (const [key, regex] of Object.entries(SUBSECTION_HEADERS)) {
      if (regex.test(trimmed)) {
        currentKey = key as SubsectionKey;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Add line to current subsection
    if (currentKey) {
      const clean = trimmed.replace(/^[-•*]\s*/, "").trim();
      if (clean) result[currentKey].push(clean);
    }
  }

  return result;
}

function rebuildSectionC(parsed: ParsedSectionC): string {
  const sections: string[] = [];

  const addSection = (title: string, points: string[]) => {
    sections.push(`### ${title}`);
    if (points.length === 0) {
      sections.push("- (zatím nezjištěno)");
    } else {
      for (const p of points) {
        sections.push(`- ${p}`);
      }
    }
    sections.push("");
  };

  addSection("Jádrové potřeby", parsed.jadrove_potreby);
  addSection("Jádrové strachy", parsed.jadrove_strachy);
  addSection("Triggery", parsed.triggery);
  addSection("Vnitřní konflikty", parsed.vnitrni_konflikty);
  addSection("Identifikovaná rizika", parsed.identifikovana_rizika);

  return sections.join("\n").trim();
}

/* ================================================================
   AI ROTACE — porovnání bodů s vlákny
   ================================================================ */

async function analyzeSubsectionRotation(
  subsectionName: string,
  existingPoints: string[],
  threadContent: string,
  specialRules: string,
): Promise<RotationResult> {
  if (existingPoints.length === 0 && !threadContent.trim()) {
    return { action: "none", removeIndex: null, newPoint: null, annotateIndex: null, annotation: null, reasoning: "Prázdná subsekce a prázdné vlákno." };
  }

  const prompt = `Analyzuj odstavec "${subsectionName}" karty DID části.

## STÁVAJÍCÍ BODY:
${existingPoints.length > 0 ? existingPoints.map((p, i) => `${i + 1}. ${p}`).join("\n") : "(žádné)"}

## OBSAH VLÁKEN (rozhovory části s Karlem):
${threadContent}

## SPECIÁLNÍ PRAVIDLA PRO TENTO ODSTAVEC:
${specialRules}

## INSTRUKCE:
1. Porovnej každý stávající bod s tím, co vyplývá z vláken.
2. Urči, který bod NEJMÉNĚ odpovídá aktuálnímu stavu části dle vlákna.
3. Navrhni, co s ním udělat: rotovat (nahradit relevantnějším), anotovat, nebo přidat nový bod.
4. Ověř, že celek odstavce bude po úpravě VÍCE relevantní.

## VÝSTUPNÍ FORMÁT (JSON):
{
  "action": "rotate" | "add" | "annotate" | "none",
  "removeIndex": <číslo bodu k odstranění (1-based) nebo null>,
  "newPoint": "<text nového bodu nebo null>",
  "annotateIndex": <číslo bodu k anotaci (1-based) nebo null>,
  "annotation": "<text anotace nebo null>",
  "reasoning": "<zdůvodnění>"
}

Vrať POUZE validní JSON bez markdown fences.`;

  try {
    const { data, error } = await supabase.functions.invoke("karel-section-c-rotation", {
      body: { prompt },
    });

    if (error) {
      console.error(`[SectionCUpdater] AI rotation error for ${subsectionName}:`, error);
      return { action: "none", removeIndex: null, newPoint: null, annotateIndex: null, annotation: null, reasoning: `AI chyba: ${error.message}` };
    }

    const result = data?.result as RotationResult | undefined;
    if (!result || !result.action) {
      return { action: "none", removeIndex: null, newPoint: null, annotateIndex: null, annotation: null, reasoning: "AI nevrátila validní výsledek." };
    }

    return result;
  } catch (err) {
    console.error(`[SectionCUpdater] Unexpected error:`, err);
    return { action: "none", removeIndex: null, newPoint: null, annotateIndex: null, annotation: null, reasoning: `Neočekávaná chyba: ${err}` };
  }
}

/* ================================================================
   APLIKACE ROTACE NA BODY
   ================================================================ */

function applyRotation(points: string[], rotation: RotationResult, threadDate: string): string[] {
  const result = [...points];

  switch (rotation.action) {
    case "rotate":
      if (rotation.removeIndex != null && rotation.removeIndex >= 1 && rotation.removeIndex <= result.length && rotation.newPoint) {
        result[rotation.removeIndex - 1] = rotation.newPoint;
      }
      break;

    case "add":
      if (rotation.newPoint) {
        result.push(rotation.newPoint);
      }
      break;

    case "annotate":
      if (rotation.annotateIndex != null && rotation.annotateIndex >= 1 && rotation.annotateIndex <= result.length && rotation.annotation) {
        result[rotation.annotateIndex - 1] += ` ${rotation.annotation}`;
      }
      break;

    case "none":
    default:
      break;
  }

  return result;
}

/* ================================================================
   SPECIÁLNÍ PRAVIDLA
   ================================================================ */

const SPECIAL_RULES: Record<SubsectionKey, string> = {
  jadrove_potreby: `Pro JÁDROVÉ POTŘEBY:
- Rotuj nejméně relevantní bod za relevantnější z vlákna.
- Potřeby jsou stabilnější, rotuj pouze při jasné evidenci.`,

  jadrove_strachy: `Pro JÁDROVÉ STRACHY:
- Pokud se ve vlákně část zmíní o novém strachu (hlubší/dlouhodobější): PŘIDEJ nový bod (action: "add").
- Pokud část říká, že se něčeho už nebojí A tento strach je v kartě: anotuj bod poznámkou:
  "📝 Dle rozhovoru z [datum]: indicie, že tento strach je momentálně na ústupu"
- Jinak rotuj nejméně relevantní bod.`,

  triggery: `Pro TRIGGERY:
- Pokud se ve vlákně projeví nový trigger: PŘIDEJ (action: "add").
- Pokud trigger z karty ve vlákně nefungoval (část nereagovala negativně na daný podnět): anotuj bod.
- Jinak rotuj nejméně relevantní bod.`,

  vnitrni_konflikty: `Pro VNITŘNÍ KONFLIKTY:
- Pokud se ve vlákně projeví nový konflikt: PŘIDEJ (action: "add").
- Pokud se konflikt z karty vyřešil (dle vlákna): anotuj s datem a poznámkou o vyřešení.
- Jinak rotuj nejméně relevantní bod.`,

  identifikovana_rizika: `Pro IDENTIFIKOVANÁ RIZIKA:
- Pokud se ve vlákně projeví nové riziko: PŘIDEJ (action: "add").
- Pokud riziko z karty již není aktuální: anotuj s datem a důvodem.
- Jinak rotuj nejméně relevantní bod.`,
};

/* ================================================================
   SERIALIZACE VLÁKEN
   ================================================================ */

function serializeThreads(threads: Thread[]): string {
  return threads
    .map((t, i) => {
      const msgs = (t.messages || [])
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n");
      return `--- Vlákno ${i + 1} (${t.last_activity_at || "?"}) ---\n${msgs}`;
    })
    .join("\n\n");
}

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

/**
 * Aktualizuje sekci C ("Potřeby a rizika") karty DID části.
 * Pro každý odstavec volá AI rotaci a aplikuje speciální pravidla.
 */
export async function updateSectionC(
  currentSectionC: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  const parsed = parseSectionC(currentSectionC);
  const threadContent = serializeThreads(threads);

  // Filtrujeme updates pro sekci C
  const cUpdates = updates.filter((u) => u.section === "C");

  // Zpracuj každý odstavec paralelně
  const subsections: SubsectionKey[] = [
    "jadrove_potreby",
    "jadrove_strachy",
    "triggery",
    "vnitrni_konflikty",
    "identifikovana_rizika",
  ];

  const DISPLAY_NAMES: Record<SubsectionKey, string> = {
    jadrove_potreby: "Jádrové potřeby",
    jadrove_strachy: "Jádrové strachy",
    triggery: "Triggery",
    vnitrni_konflikty: "Vnitřní konflikty",
    identifikovana_rizika: "Identifikovaná rizika",
  };

  // Zpracování – sekvenční kvůli rate limitům
  for (const key of subsections) {
    const subsectionUpdates = cUpdates.filter((u) => u.subsection === key);
    const existingPoints = parsed[key];

    // Pokud nejsou updaty ani vlákna relevantní, přeskoč
    if (subsectionUpdates.length === 0 && threads.length === 0) continue;

    // Nejprve aplikuj přímé updaty z threadAnalyzer
    for (const update of subsectionUpdates) {
      switch (update.type) {
        case "add":
          parsed[key].push(update.content);
          break;
        case "replace":
          // Nahraď nejstarší/nejméně relevantní bod
          if (parsed[key].length > 0) {
            parsed[key][parsed[key].length - 1] = update.content;
          } else {
            parsed[key].push(update.content);
          }
          break;
        case "annotate":
          if (parsed[key].length > 0) {
            parsed[key][parsed[key].length - 1] += ` 📝 ${update.content}`;
          }
          break;
        case "delete":
          parsed[key] = parsed[key].filter((p) => !p.includes(update.content));
          break;
      }
    }

    // Poté AI rotace pokud máme vlákna
    if (threads.length > 0 && existingPoints.length > 0) {
      const specialRules = SPECIAL_RULES[key].replace(/\[datum\]/g, threadDate);
      const rotation = await analyzeSubsectionRotation(
        DISPLAY_NAMES[key],
        parsed[key],
        threadContent,
        specialRules,
      );

      if (rotation.action !== "none") {
        console.log(`[SectionCUpdater] ${DISPLAY_NAMES[key]}: ${rotation.action} — ${rotation.reasoning}`);
        parsed[key] = applyRotation(parsed[key], rotation, threadDate);
      }
    }
  }

  return rebuildSectionC(parsed);
}
