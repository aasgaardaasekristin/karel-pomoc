/**
 * Section E, F, G Updaters
 *
 * E — Časová osa / Historie (append-only log)
 * F — Plánování a budoucnost (audit + prune stale)
 * G — Deník části (only on explicit request)
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
    console.error("[SectionEFGUpdater] AI call error:", error);
    return "";
  }

  return (data?.result as string) ?? "";
}

/* ================================================================
   SEKCE E — Časová osa
   ================================================================ */

export async function updateSectionE(
  currentSectionE: string,
  threads: Thread[],
  threadDate: string,
  partName: string,
): Promise<string> {
  if (!threads.length) return currentSectionE;

  const threadContent = serializeThreads(threads);

  const prompt = `Analyzuj následující vlákna (rozhovory DID části "${partName}" s Karlem) a vytvoř záznam do časové osy.

## VLÁKNA:
${threadContent}

## INSTRUKCE:
Vytvoř JEDEN řádek záznamu se TŘEMI sloupci oddělenými znakem "|":
DATUM | UDÁLOST | VÝSLEDEK

- DATUM: ${threadDate}
- UDÁLOST: stručný popis co se stalo (kdo inicioval, jaké téma se řešilo, emocionální stav části)
- VÝSLEDEK: co z toho vyplynulo (co Karel udělal, jaká dohoda vznikla, komu se má co předat, co doporučit terapeutkám)

Příklad:
${threadDate} | Rozhovor části s Karlem, iniciovala část, řešila zlé sny, byla vyděšená, úzkostná | Karel uklidnil část, domluvena rituální básnička před spaním, Hanička informována

Vrať POUZE ten jeden řádek, nic dalšího.`;

  const newEntry = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém. Vytváříš záznamy do časové osy karty.
PRAVIDLA: Hanka, Káťa = terapeutky. Locík = pes. Amálka, Tonička = děti. Jiří = partner. Karel = AI. NEJSOU DID části.`,
    prompt,
  );

  if (!newEntry.trim()) return currentSectionE;

  const base = currentSectionE.trim();
  return base ? `${base}\n${newEntry.trim()}` : newEntry.trim();
}

/* ================================================================
   SEKCE F — Plánování a budoucnost
   ================================================================ */

export async function updateSectionF(
  currentSectionF: string,
  threads: Thread[],
  threadDate: string,
  currentDate: string,
): Promise<string> {
  if (!currentSectionF.trim() && !threads.length) return currentSectionF;

  const threadContent = serializeThreads(threads);

  const prompt = `Aktualizuj sekci F (Plánování a budoucnost) karty DID části.

## AKTUÁLNÍ TEXT SEKCE F:
${currentSectionF || "(prázdná)"}

## DNEŠNÍ DATUM: ${currentDate}
## DATUM VLÁKNA: ${threadDate}

## VLÁKNA:
${threadContent || "(žádná)"}

## INSTRUKCE:
1. ODSTRAŇ zastaralé záznamy: Najdi věty obsahující data/měsíce, které již uplynuly (porovnej s dnešním datem ${currentDate}). Tyto věty smaž.
2. AUDIT: Porovnej zbývající text s obsahem vláken. Pokud najdeš rozpor (část říká něco jiného než co je v plánu), uprav text a přidej poznámku: "📝 Aktualizováno ${threadDate}: [důvod změny]"
3. Pokud z vlákna vyplývá nový plán/přání do budoucna, přidej ho.

Vrať KOMPLETNÍ aktualizovaný text sekce F. Pokud není co měnit, vrať původní text beze změny.
Vrať POUZE text sekce, bez markdown fences, bez vysvětlení.`;

  const result = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém. Aktualizuješ plánování v kartě.
PRAVIDLA: Hanka, Káťa = terapeutky. Locík = pes. Amálka, Tonička = děti. Jiří = partner. Karel = AI. NEJSOU DID části.
Kvůli epilepsii NENAVRHUJ dechová cvičení.`,
    prompt,
  );

  return result.trim() || currentSectionF;
}

/* ================================================================
   SEKCE G — Deník části
   ================================================================ */

export async function updateSectionG(
  currentSectionG: string,
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!threads.length) return currentSectionG;

  const threadContent = serializeThreads(threads);

  // First check if there's an explicit diary request
  const checkPrompt = `Projdi následující vlákna a zjisti, zda DID část EXPLICITNĚ žádá, aby se něco zapsalo do deníku.

## VLÁKNA:
${threadContent}

## INSTRUKCE:
Hledej formulace jako:
- "dej to do deníku"
- "zapiš to"
- "napiš to do deníčku"
- "chtěl/a bych to mít v deníku"
- nebo jakoukoliv jinou explicitní žádost o zápis do deníku

Pokud taková žádost EXISTUJE, vytvoř deníkový záznam:
- Formát: "[datum v českém formátu DD.MM.YYYY]\n[text v první osobě, jako by to psala část sama, ve stylu deníku dítěte/části]"
- Text musí odpovídat tomu, na čem se Karel s částí dohodl
- Piš jednoduše, autenticky, jako by to psala ta část

Pokud žádost NEEXISTUJE, vrať přesně text: NO_DIARY_ENTRY

Vrať POUZE záznam nebo NO_DIARY_ENTRY, nic dalšího.`;

  const result = await callAI(
    `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém. Kontroluješ, zda část žádá zápis do deníku.
PRAVIDLA: Hanka, Káťa = terapeutky. Locík = pes. Amálka, Tonička = děti. Jiří = partner. Karel = AI. NEJSOU DID části.`,
    checkPrompt,
  );

  const trimmed = result.trim();
  if (!trimmed || trimmed === "NO_DIARY_ENTRY") {
    return currentSectionG;
  }

  const base = currentSectionG.trim();
  return base ? `${base}\n\n${trimmed}` : trimmed;
}
