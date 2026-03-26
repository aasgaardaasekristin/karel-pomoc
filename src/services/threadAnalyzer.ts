/**
 * Thread Analyzer — analýza vláken DID částí a třídění do sekcí A-M kartotéky.
 *
 * Tato funkce NEAPLIKUJE změny, pouze je připraví a roztřídí.
 * AI (Gemini) obdrží vlákna + aktuální kartu a vrátí strukturovaný JSON.
 */

import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   TYPY
   ================================================================ */

export interface ThreadMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface Thread {
  id: string;
  part_name: string;
  messages: ThreadMessage[];
  last_activity_at: string;
  thread_label: string | null;
}

/** Aktuální obsah karty – klíče A-M, hodnota je surový text sekce */
export interface CardContent {
  A?: string;
  B?: string;
  C?: string;
  D?: string;
  E?: string;
  F?: string;
  G?: string;
  H?: string;
  I?: string;
  J?: string;
  K?: string;
  L?: string;
  M?: string;
}

export type UpdateAction = "add" | "replace" | "annotate" | "delete";

export type SectionKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M";

export interface SectionUpdate {
  section: SectionKey;
  subsection: string;
  type: UpdateAction;
  content: string;
  sourceDate: string;
  reasoning: string;
}

export type SectionUpdates = Record<SectionKey, SectionUpdate[]>;

/* ================================================================
   PROMPT TEMPLATE
   ================================================================ */

export const THREAD_ANALYSIS_PROMPT = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je analyzovat vlákna (rozhovory DID části s Karlem) a roztřídit informace do sekcí A-M kartotéky.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## INSTRUKCE

1. Přečti chronologicky všechny zprávy od části (ne od Karla/asistenta).
2. Pro každou zprávu extrahuj:
   - emocionální stav
   - zmíněné osoby/části (vztahy)
   - zmíněné aktivity/zájmy
   - zmíněné strachy/obavy
   - zmíněné konflikty
   - přání části
   - explicitní žádosti ("dej do deníku", "řekni Haničce")
   - obranné mechanismy
   - triggery
   - pokrok/regres oproti předchozímu stavu
   - skryté/podvědomé motivy (psychoanalytický rozbor)

3. Každou extrahovanou poznámku zařaď do sekcí:

**A (Identita a aktuální stav):**
- aktualni_stav, povedomí_o_systemu_a_role, vztahy, co_ho_uklidnuje, ochranne_mechanismy

**B (Psychologický profil):**
- aktualni_stav, psychologicke_charakteristiky, psychologicka_profilace, obranne_mechanismy, reakce_na_kontakt

**C (Potřeby a rizika):**
- jadrove_potreby, jadrove_strachy, triggery, vnitrni_konflikty, identifikovana_rizika

**D (Terapeutická doporučení):**
- doporuceni

**E (Časová osa):**
- zaznam

**F (Plánování):**
- plan

**G (Deník):**
- denik (POUZE pokud část explicitně žádá "dej do deníku")

**H (Dlouhodobé cíle):**
- cile

**I (Terapeutické metody):**
- metody

**J (Priority a intervence):**
- priority, krizove_situace

**K (Zpětná vazba):**
- zpetna_vazba

**L (Aktivita):**
- aktivita

**M (Poznámky):**
- poznamky

4. Pro každou poznámku urči typ akce:
- "add" = nová informace
- "replace" = nahrazuje zastaralou informaci (uveď co nahrazuje)
- "annotate" = doplňuje existující informaci komentářem
- "delete" = informace již neplatí

5. VŽDY porovnej s aktuální kartou – pokud informace tam už je a je aktuální, NEVYTVÁŘEJ update.

## BEZPEČNOSTNÍ PRAVIDLA
- NIKDY nezařazuj osobní emoce terapeutek do karty DID části.
- NIKDY nepoužívej intimní oslovení.
- Kvůli epilepsii NENAVRHUJ dechová cvičení.
- Pokud část zmiňuje terapeutku, záznam patří do sekce A (vztahy) NIKOLIV do profilace terapeutky.

## VÝSTUPNÍ FORMÁT

Vrať POUZE validní JSON pole objektů:
[
  {
    "section": "A",
    "subsection": "aktualni_stav",
    "type": "replace",
    "content": "Tundrupek se dnes cítí nejistě, zmiňuje strach z toho, že na něj zapomenou.",
    "sourceDate": "2026-03-26",
    "reasoning": "Část explicitně vyjádřila obavy z opuštění, což nahrazuje předchozí stav 'stabilní nálada'."
  }
]

Pokud z vláken nevyplývají žádné nové informace pro danou sekci, nevytvářej pro ni žádný záznam.
Buď precizní. Každý update musí mít jasné zdůvodnění (reasoning).`;

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

/**
 * Analyzuje vlákna DID části a roztřídí informace do sekcí A-M.
 * Volá edge funkci karel-thread-analyzer, která komunikuje s AI.
 */
export async function analyzeThreadsForPart(
  partId: string,
  threads: Thread[],
  currentCard: CardContent | null,
): Promise<SectionUpdates> {
  const empty = createEmptySectionUpdates();

  if (!threads.length) {
    console.log(`[ThreadAnalyzer] Žádná vlákna pro "${partId}".`);
    return empty;
  }

  console.log(`[ThreadAnalyzer] Analyzuji ${threads.length} vláken pro "${partId}"…`);

  try {
    const { data, error } = await supabase.functions.invoke("karel-thread-analyzer", {
      body: {
        partId,
        threads: threads.map((t) => ({
          id: t.id,
          messages: t.messages,
          last_activity_at: t.last_activity_at,
          thread_label: t.thread_label,
        })),
        currentCard: currentCard ?? {},
      },
    });

    if (error) {
      console.error(`[ThreadAnalyzer] Edge funkce selhala:`, error);
      return empty;
    }

    const updates: SectionUpdate[] = data?.updates ?? [];
    if (!Array.isArray(updates) || updates.length === 0) {
      console.log(`[ThreadAnalyzer] AI nevrátila žádné updaty pro "${partId}".`);
      return empty;
    }

    // Roztřídění do sekcí
    const result = createEmptySectionUpdates();
    for (const u of updates) {
      const key = u.section as SectionKey;
      if (key in result) {
        result[key].push(u);
      }
    }

    console.log(
      `[ThreadAnalyzer] Pro "${partId}" nalezeno ${updates.length} updatů: ` +
        Object.entries(result)
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => `${k}:${v.length}`)
          .join(", "),
    );

    return result;
  } catch (err) {
    console.error(`[ThreadAnalyzer] Neočekávaná chyba:`, err);
    return empty;
  }
}

/* ================================================================
   HELPERS
   ================================================================ */

function createEmptySectionUpdates(): SectionUpdates {
  return {
    A: [], B: [], C: [], D: [], E: [], F: [], G: [],
    H: [], I: [], J: [], K: [], L: [], M: [],
  };
}
