/**
 * Section B Updater — "Psychologický profil"
 *
 * Odstavce:
 *   - Aktuální stav (rotace bodů)
 *   - Psychologické charakteristiky (AI shoda + náhrada)
 *   - Psychologická profilace (AI tvorba / aktualizace)
 *   - Obranné mechanismy (add/annotate/rozpory)
 *   - Reakce na kontakt (add/annotate/rozpory)
 */

import type { SectionUpdate, Thread } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";
import { findContradiction } from "@/services/cardUpdaters/sectionAUpdater";

/* ================================================================
   TYPY
   ================================================================ */

interface ParsedSectionB {
  aktualni_stav: string;
  psychologicke_charakteristiky: string;
  psychologicka_profilace: string;
  obranne_mechanismy: string;
  reakce_na_kontakt: string;
  rest: string;
}

interface CharacteristicUpdate {
  original: string;
  replacement: string;
  matchBefore: number;
  matchAfter: number;
}

interface ProfileUpdateResult {
  matchPercentage: number;
  updatedProfile: string;
  changes: string[];
}

/* ================================================================
   PARSER
   ================================================================ */

const SECTION_B_HEADERS: Array<{ key: keyof ParsedSectionB; patterns: string[] }> = [
  { key: "aktualni_stav", patterns: ["aktuální stav"] },
  { key: "psychologicke_charakteristiky", patterns: ["psychologické charakteristiky", "charakteristiky"] },
  { key: "psychologicka_profilace", patterns: ["psychologická profilace", "osobnostní profil", "profilace"] },
  { key: "obranne_mechanismy", patterns: ["obranné mechanismy"] },
  { key: "reakce_na_kontakt", patterns: ["reakce na kontakt"] },
];

function parseSectionB(raw: string): ParsedSectionB {
  const result: ParsedSectionB = {
    aktualni_stav: "",
    psychologicke_charakteristiky: "",
    psychologicka_profilace: "",
    obranne_mechanismy: "",
    reakce_na_kontakt: "",
    rest: "",
  };

  const lines = raw.split("\n");
  let currentKey: keyof ParsedSectionB | null = null;
  const buffer: string[] = [];

  const flushBuffer = () => {
    if (currentKey && buffer.length > 0) {
      result[currentKey] = buffer.join("\n").trim();
    }
    buffer.length = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const matchedKey = detectSectionBHeader(trimmed);
    if (matchedKey) {
      flushBuffer();
      currentKey = matchedKey;
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

function detectSectionBHeader(line: string): keyof ParsedSectionB | null {
  const cleaned = line.replace(/^#+\s*/, "").replace(/[*_]/g, "").trim().toLowerCase();
  for (const { key, patterns } of SECTION_B_HEADERS) {
    for (const p of patterns) {
      if (cleaned.includes(p)) return key;
    }
  }
  return null;
}

function reassembleSectionB(p: ParsedSectionB): string {
  const sections: string[] = [];
  if (p.rest.trim()) sections.push(p.rest.trim());
  sections.push(`### Aktuální stav\n${p.aktualni_stav}`);
  sections.push(`### Psychologické charakteristiky\n${p.psychologicke_charakteristiky}`);
  sections.push(`### Psychologická profilace\n${p.psychologicka_profilace}`);
  sections.push(`### Obranné mechanismy\n${p.obranne_mechanismy}`);
  sections.push(`### Reakce na kontakt\n${p.reakce_na_kontakt}`);
  return sections.join("\n\n");
}

/* ================================================================
   HELPERS
   ================================================================ */

/** Rozloží text na pole bodů (řádky začínající -, •, číslem) */
function parsePoints(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•\d]/.test(l))
    .map((l) => l.replace(/^[-•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

function pointsToText(points: string[]): string {
  return points.map((p) => `- ${p}`).join("\n");
}

function serializeThreads(threads: Thread[]): string {
  return threads
    .map((t, i) => {
      const msgs = t.messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n");
      return `--- Vlákno ${i + 1} (${t.last_activity_at || "?"}, label: ${t.thread_label || "bez názvu"}) ---\n${msgs}`;
    })
    .join("\n\n");
}

function groupBySubsection(updates: SectionUpdate[]): Record<string, SectionUpdate[]> {
  const groups: Record<string, SectionUpdate[]> = {};
  for (const u of updates) {
    const key = u.subsection;
    if (!groups[key]) groups[key] = [];
    groups[key].push(u);
  }
  return groups;
}

function appendLine(text: string, line: string): string {
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n- ${line}` : `- ${line}`;
}

/* ================================================================
   AI VOLÁNÍ S RETRY
   ================================================================ */

async function callSectionBProfile(
  body: Record<string, unknown>,
  maxRetries = 3,
): Promise<{ data: any; error: string | null }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.functions.invoke("karel-section-b-profile", { body });

      if (error) {
        console.warn(`[SectionB] AI attempt ${attempt}/${maxRetries} failed:`, error);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return { data: null, error: String(error) };
      }

      return { data, error: null };
    } catch (err) {
      console.warn(`[SectionB] AI attempt ${attempt}/${maxRetries} exception:`, err);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return { data: null, error: String(err) };
    }
  }
  return { data: null, error: "Max retries exceeded" };
}

/* ================================================================
   AKTUALIZAČNÍ LOGIKA PRO OBRANNÉ MECHANISMY / REAKCE
   ================================================================ */

async function applyDefenseUpdates(
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
      text += `\n⚠️ Dle rozhovoru z vlákna (${date}) tato informace nemusí být platná. Důvod/odhad: ${u.reasoning || contradiction.reasoning || "není stanoveno"}`;
    } else if (u.type === "annotate") {
      text += `\n📝 Poznámka (${date}): ${u.content}`;
    } else if (u.type === "replace") {
      text = appendLine(text, `${u.content} (aktualizováno ${date})`);
    }
  }

  return text;
}

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

/**
 * Aktualizuje sekci B karty DID části.
 */
export async function updateSectionB(
  currentSectionB: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!updates.length && !threads.length) return currentSectionB;

  const paragraphs = parseSectionB(currentSectionB);
  const date = threadDate.slice(0, 10);
  const bySubsection = groupBySubsection(updates);
  const threadsText = serializeThreads(threads);

  // --- 1. AKTUÁLNÍ STAV (rotace bodů) ---
  {
    const existingPoints = parsePoints(paragraphs.aktualni_stav);
    const newPoints = (bySubsection.aktualni_stav || []).map((u) => u.content);

    // Odstraň první 3 body (nejstarší)
    const trimmed = existingPoints.length > 3 ? existingPoints.slice(3) : [];

    // Přidej až 3 nové body
    const toAdd = newPoints.slice(0, 3);
    const combined = [...trimmed, ...toAdd];

    if (combined.length > 0) {
      paragraphs.aktualni_stav = pointsToText(combined);
    }
  }

  // --- 2. PSYCHOLOGICKÉ CHARAKTERISTIKY (AI shoda) ---
  if (paragraphs.psychologicke_charakteristiky.trim() && threads.length > 0) {
    console.log("[SectionB] Analyzing characteristics match...");
    const { data, error } = await callSectionBProfile({
      mode: "characteristics",
      currentCharacteristics: paragraphs.psychologicke_charakteristiky,
      threads: threadsText,
      partName: threads[0]?.part_name || "neznámá",
    });

    if (!error && data?.characteristics?.length > 0) {
      let text = paragraphs.psychologicke_charakteristiky;
      for (const ch of data.characteristics as CharacteristicUpdate[]) {
        if (ch.replacement && ch.matchBefore < 100) {
          // Nahraď původní tvrzení novým
          if (text.includes(ch.original)) {
            text = text.replace(ch.original, `${ch.replacement} (aktualizováno ${date}, shoda ${ch.matchBefore}% → ${ch.matchAfter}%)`);
          } else {
            text = appendLine(text, `${ch.replacement} (${date}, shoda ${ch.matchAfter}%)`);
          }
        }
      }
      paragraphs.psychologicke_charakteristiky = text;
    } else if (error) {
      console.warn("[SectionB] Characteristics analysis failed:", error);
    }
  }

  // --- 3. PSYCHOLOGICKÁ PROFILACE (tvorba / aktualizace) ---
  if (threads.length > 0) {
    const hasExistingProfile = paragraphs.psychologicka_profilace.trim().length > 50;

    if (!hasExistingProfile) {
      console.log("[SectionB] Creating new psychological profile...");
      const { data, error } = await callSectionBProfile({
        mode: "create_profile",
        threads: threadsText,
        partName: threads[0]?.part_name || "neznámá",
      });

      if (!error && data?.profile) {
        paragraphs.psychologicka_profilace = data.profile;
      } else {
        console.error("[SectionB] Profile creation failed:", error);
        paragraphs.psychologicka_profilace = paragraphs.psychologicka_profilace
          ? paragraphs.psychologicka_profilace + `\n⚠️ Aktualizace profilace selhala [${date}], nutno opakovat.`
          : `⚠️ Vytvoření profilace selhalo [${date}], nutno opakovat.`;
      }
    } else {
      console.log("[SectionB] Updating existing psychological profile...");
      const { data, error } = await callSectionBProfile({
        mode: "update_profile",
        currentProfile: paragraphs.psychologicka_profilace,
        threads: threadsText,
        partName: threads[0]?.part_name || "neznámá",
      });

      if (!error && data?.updatedProfile) {
        paragraphs.psychologicka_profilace = data.updatedProfile;
        if (data.changes?.length) {
          console.log(`[SectionB] Profile updated (${data.matchPercentage}% match): ${data.changes.join("; ")}`);
        }
      } else {
        console.error("[SectionB] Profile update failed:", error);
        paragraphs.psychologicka_profilace += `\n⚠️ Aktualizace profilace selhala [${date}], nutno opakovat.`;
      }
    }
  }

  // --- 4. OBRANNÉ MECHANISMY ---
  if (bySubsection.obranne_mechanismy?.length) {
    paragraphs.obranne_mechanismy = await applyDefenseUpdates(
      paragraphs.obranne_mechanismy,
      bySubsection.obranne_mechanismy,
      date,
    );
  }

  // --- 5. REAKCE NA KONTAKT ---
  if (bySubsection.reakce_na_kontakt?.length) {
    paragraphs.reakce_na_kontakt = await applyDefenseUpdates(
      paragraphs.reakce_na_kontakt,
      bySubsection.reakce_na_kontakt,
      date,
    );
  }

  return reassembleSectionB(paragraphs);
}
