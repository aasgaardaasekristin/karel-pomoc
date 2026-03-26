/**
 * Section K, L, M Updaters
 *
 * K — Zpětná vazba na aktivity (append on significant signal only)
 * L — Sledování aktivity (rotate oldest, add new)
 * M — Poznámky Karla (always update, prune contradictions)
 */

import type { Thread } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   HELPERS
   ================================================================ */

function serializeThreads(threads: Thread[]): string {
  return threads
    .map((t, i) => {
      const msgs = (t.messages || [])
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n");
      return `--- Vlákno ${i + 1} (${t.last_activity_at || "?"}, label: ${t.thread_label || "?"}) ---\n${msgs}`;
    })
    .join("\n\n");
}

async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("karel-section-efg", {
    body: { systemPrompt, userPrompt },
  });

  if (error) {
    console.error("[SectionKLMUpdater] AI call error:", error);
    return "";
  }

  return (data?.result as string) ?? "";
}

const ENTITY_RULES = `PRAVIDLA ENTITY SEPARACE:
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.
Kvůli epilepsii NENAVRHUJ dechová cvičení.`;

/* ================================================================
   SEKCE K — Zpětná vazba na aktivity
   ================================================================ */

export async function updateSectionK(
  currentSectionK: string,
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!threads.length) return currentSectionK;

  const threadContent = serializeThreads(threads);

  const prompt = `Analyzuj vlákna a zjisti, zda DID část vyjadřuje SIGNIFIKANTNÍ zpětnou vazbu na nějakou aktivitu.

## VLÁKNA:
${threadContent}

## INSTRUKCE:
Hledej tyto jevy:
1. Část se POZITIVNĚ vyjádřila k nějaké aktivitě (např. "lyžování se mi líbilo", "to kreslení bylo fajn")
2. Část se NEGATIVNĚ vyjádřila k nějaké aktivitě (např. "nechci už chodit ven", "nelíbilo se mi to")
3. Část SPONTÁNNĚ zmínila nějakou minulou aktivitu

Pokud takový jev EXISTUJE, vytvoř záznam(y) ve formátu:
${threadDate} | [aktivita] | [pozitivní/negativní] | [citace nebo parafráze z vlákna]

Může být více záznamů (jeden na řádek).

Pokud žádný signifikantní jev NEEXISTUJE, vrať přesně: NO_FEEDBACK

Vrať POUZE záznamy nebo NO_FEEDBACK, nic dalšího.`;

  const result = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém. Analyzuješ zpětnou vazbu na aktivity.\n${ENTITY_RULES}`,
    prompt,
  );

  const trimmed = result.trim();
  if (!trimmed || trimmed === "NO_FEEDBACK") return currentSectionK;

  const base = currentSectionK.trim();
  return base ? `${base}\n${trimmed}` : trimmed;
}

/* ================================================================
   SEKCE L — Sledování aktivity
   ================================================================ */

export async function updateSectionL(
  currentSectionL: string,
  threads: Thread[],
  threadDate: string,
  allActivePartsLast24h: string[],
): Promise<string> {
  if (!threads.length) return currentSectionL;

  const threadContent = serializeThreads(threads);

  // Parse existing lines, remove oldest
  const lines = currentSectionL
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const existingEntries = lines.filter((l) => l.includes("|") || /^\d{4}/.test(l));

  // Remove oldest entry (first one)
  const keptEntries = existingEntries.length > 0 ? existingEntries.slice(1) : [];

  // Determine activity type
  const partName = threads[0]?.part_name ?? "?";
  const otherParts = allActivePartsLast24h.filter((p) => p !== partName);
  const activityType =
    otherParts.length === 0
      ? "Aktivní převahou"
      : `Střídá se s: ${otherParts.join(", ")}`;

  // Generate note via AI
  const prompt = `Analyzuj vlákna DID části a vytvoř stručnou bodovou charakteristiku projevu za posledních 24h.

## VLÁKNA:
${threadContent}

## INSTRUKCE:
Shrň hlavní charakteristiky projevu části v tomto vlákně do jedné věty, bodově oddělené čárkami.
Příklad: "pozitivní naladění, sociofobie přetrvává, nespavost a noční můry zmíněny"

Vrať POUZE tu jednu větu, nic dalšího.`;

  const note = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.\n${ENTITY_RULES}`,
    prompt,
  );

  const noteText = note.trim() || "bez zvláštností";
  const newEntry = `${threadDate} | ${activityType} | ${noteText}`;

  keptEntries.push(newEntry);

  return keptEntries.join("\n");
}

/* ================================================================
   SEKCE M — Poznámky Karla
   ================================================================ */

export async function updateSectionM(
  currentSectionM: string,
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!threads.length) return currentSectionM;

  const threadContent = serializeThreads(threads);

  const prompt = `Aktualizuj sekci M (Poznámky Karla) karty DID části.

## AKTUÁLNÍ POZNÁMKY:
${currentSectionM || "(prázdné)"}

## VLÁKNA:
${threadContent}

## INSTRUKCE:
1. Přečti stávající poznámky v sekci M.
2. Porovnej je s obsahem vláken.
3. Pokud najdeš poznámku, která je V ROZPORU s tím, co vyplývá z vlákna:
   - Smaž nerelevantní/zastaralý záznam
   - Nahraď ho relevantním
4. Přidej své vlastní analytické postřehy, dedukce a poznámky k části na základě tohoto vlákna.
   - Piš ve třetí osobě, z pozice vedoucího terapeutického týmu
   - Zaměř se na: skryté motivy, podvědomé vzorce, terapeutické příležitosti, rizika, doporučení
   - Formát nových poznámek: "[${threadDate}] [poznámka]"

5. Vrať KOMPLETNÍ aktualizovaný text sekce M (staré relevantní + nové).
   Vrať POUZE text sekce, bez markdown fences, bez vysvětlení.`;

  const result = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém. Píšeš své analytické poznámky do karty.
${ENTITY_RULES}
NIKDY nepoužívej intimní oslovení. Piš profesionálně, z pozice vedoucího týmu.`,
    prompt,
  );

  return result.trim() || currentSectionM;
}
