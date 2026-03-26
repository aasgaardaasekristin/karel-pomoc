/**
 * Section H, I, J Updaters
 *
 * H — Dlouhodobé cíle
 * I — Terapeutické metody (AI psychoanalýza)
 * J — Priority a intervence
 */

import type { SectionUpdate, Thread } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";
import { findContradiction } from "@/services/cardUpdaters/sectionAUpdater";

/* ================================================================
   HELPERS
   ================================================================ */

function serializeThreads(threads: Thread[]): string {
  return threads
    .map((t, i) => {
      const msgs = t.messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
      return `--- Vlákno ${i + 1} (${t.last_activity_at || "?"}, label: ${t.thread_label || "bez názvu"}) ---\n${msgs}`;
    })
    .join("\n\n");
}

function parsePoints(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
}

function appendLine(text: string, line: string): string {
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n- ${line}` : `- ${line}`;
}

function groupBySubsection(updates: SectionUpdate[]): Record<string, SectionUpdate[]> {
  const groups: Record<string, SectionUpdate[]> = {};
  for (const u of updates) {
    if (!groups[u.subsection]) groups[u.subsection] = [];
    groups[u.subsection].push(u);
  }
  return groups;
}

/* ================================================================
   AI CALL WITH RETRY
   ================================================================ */

async function callEdgeFunction(
  name: string,
  body: Record<string, unknown>,
  maxRetries = 3,
): Promise<{ data: any; error: string | null }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.functions.invoke(name, { body });
      if (error) {
        console.warn(`[${name}] Attempt ${attempt}/${maxRetries} failed:`, error);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return { data: null, error: String(error) };
      }
      return { data, error: null };
    } catch (err) {
      console.warn(`[${name}] Attempt ${attempt}/${maxRetries} exception:`, err);
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
   SECTION H — Dlouhodobé cíle
   ================================================================ */

/**
 * Aktualizuje sekci H (Dlouhodobé cíle).
 * - Dosažené cíle: ✅
 * - Změněné cíle: úprava + poznámka
 * - Nové cíle: přidání
 */
export async function updateSectionH(
  currentSectionH: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!updates.length) return currentSectionH;

  const date = threadDate.slice(0, 10);
  let text = currentSectionH;
  const lines = parsePoints(text);
  const bySubsection = groupBySubsection(updates);
  const goalUpdates = bySubsection.cile || updates;

  for (const u of goalUpdates) {
    switch (u.type) {
      case "add":
        text = appendLine(text, `${u.content} *(přidáno ${date})*`);
        break;

      case "replace": {
        // Hledáme cíl, který se má nahradit
        let replaced = false;
        for (const line of lines) {
          if (line.toLowerCase().includes(u.content.toLowerCase().slice(0, 20))) {
            text = text.replace(line, `${line}\n  ✅ Cíle dosaženo (${date}): ${u.content}`);
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          text = appendLine(text, `${u.content} *(aktualizováno ${date}, důvod: ${u.reasoning || "neuvedeno"})*`);
        }
        break;
      }

      case "annotate":
        text += `\n📝 Poznámka k cílům (${date}): ${u.content}`;
        break;

      case "delete": {
        // Označení cíle jako dosaženého
        for (const line of lines) {
          if (line.toLowerCase().includes(u.content.toLowerCase().slice(0, 20))) {
            text = text.replace(line, `${line} ✅ Cíle dosaženo (${date})`);
            break;
          }
        }
        break;
      }
    }
  }

  return text;
}

/* ================================================================
   SECTION I — Terapeutické metody (AI psychoanalýza)
   ================================================================ */

interface TherapeuticActivity {
  name: string;
  goal: string;
  steps: string[];
  materials: string;
  reasoning: string;
  therapist: string;
  timeframe: string;
}

/**
 * Aktualizuje sekci I (Terapeutické metody).
 * Volá AI pro profesionální psychoanalytický rozbor vlákna.
 * NIKDY neodstraňuje staré metody, pouze přidává nové.
 */
export async function updateSectionI(
  currentSectionI: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
): Promise<string> {
  if (!threads.length) return currentSectionI;

  const date = threadDate.slice(0, 10);
  const partId = threads[0]?.part_name || "neznámá";
  const threadsText = serializeThreads(threads);

  console.log(`[SectionI] Psychoanalytický rozbor pro "${partId}"…`);

  const { data, error } = await callEdgeFunction("karel-section-i-psychoanalysis", {
    threads: threadsText,
    currentMethods: currentSectionI,
    partId,
  });

  if (error || !data) {
    console.error(`[SectionI] AI psychoanalýza selhala:`, error);
    return currentSectionI + `\n\n⚠️ Aktualizace terapeutických metod selhala [${date}], nutno opakovat.`;
  }

  let text = currentSectionI;

  // Přidej analýzu jako komentář
  if (data.analysis) {
    text += `\n\n---\n📊 **Psychoanalytický rozbor (${date}):**\n${data.analysis}`;
  }

  // Přidej nové aktivity
  const activities: TherapeuticActivity[] = data.activities || [];
  if (activities.length) {
    text += `\n\n---\n### Nové návrhy aktivit (${date})`;

    for (const act of activities) {
      text += `\n\n#### ${act.name}`;
      text += `\n- **Cíl:** ${act.goal}`;
      if (act.steps?.length) {
        text += `\n- **Postup:**`;
        for (const step of act.steps) {
          text += `\n  ${step}`;
        }
      }
      if (act.materials) text += `\n- **Pomůcky:** ${act.materials}`;
      text += `\n- **Terapeutické zdůvodnění:** ${act.reasoning}`;
      text += `\n- **Doporučený terapeut:** ${act.therapist}`;
      text += `\n- **Časový horizont:** ${act.timeframe}`;
    }

    console.log(`[SectionI] Pro "${partId}" nalezeno ${activities.length} nových aktivit.`);
  }

  return text;
}

/* ================================================================
   SECTION J — Priority a intervence
   ================================================================ */

/**
 * Aktualizuje sekci J (Priority a intervence).
 *
 * 1. PRIORITY: parsuj 3 stávající, vyměň nejméně závažnou pokud je ve vlákně něco závažnějšího
 * 2. NÁVRH INTERVENCE: z aktualizované sekce I vyber 3 nejrelevantnější metody
 * 3. KRIZOVÉ SITUACE: přidej/anotuj/smaž podle počtu poznámek
 */
export async function updateSectionJ(
  currentSectionJ: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
  updatedSectionI: string,
): Promise<string> {
  if (!updates.length && !threads.length) return currentSectionJ;

  const date = threadDate.slice(0, 10);
  const bySubsection = groupBySubsection(updates);
  const parsed = parseSectionJ(currentSectionJ);

  // --- 1. PRIORITY ---
  if (bySubsection.priority?.length) {
    for (const u of bySubsection.priority) {
      if (u.type === "add" || u.type === "replace") {
        // Pokud máme 3+ priorit, nahradíme poslední (nejméně závažnou)
        if (parsed.priorities.length >= 3) {
          const removed = parsed.priorities.pop()!;
          parsed.priorities.push(`${u.content} *(nahrazeno ${date}, bylo: "${removed.slice(0, 40)}…")*`);
        } else {
          parsed.priorities.push(`${u.content} *(přidáno ${date})*`);
        }
      }
    }
  }

  // --- 2. NÁVRH INTERVENCE ---
  // Odstraň časově neaktuální položky (starší než 14 dní)
  parsed.interventions = parsed.interventions.filter((line) => {
    const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return true;
    const lineDate = new Date(dateMatch[1]);
    const now = new Date();
    const diffDays = (now.getTime() - lineDate.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays <= 14;
  });

  // Z sekce I vyber nové aktivity (hledáme "#### " nadpisy)
  const sectionIActivities = updatedSectionI
    .split("\n")
    .filter((l) => l.startsWith("#### "))
    .map((l) => l.replace("#### ", "").trim())
    .slice(-5); // posledních 5

  if (sectionIActivities.length) {
    const top3 = sectionIActivities.slice(0, 3);
    for (const act of top3) {
      if (!parsed.interventions.some((i) => i.includes(act))) {
        parsed.interventions.push(`- ${act} *(doporučeno ${date} na základě psychoanalýzy)*`);
      }
    }
  }

  // --- 3. KRIZOVÉ SITUACE ---
  if (bySubsection.krizove_situace?.length) {
    for (const u of bySubsection.krizove_situace) {
      if (u.type === "add") {
        parsed.crisisItems.push(`- ${u.content} *(${date})*`);
      } else if (u.type === "annotate" || u.type === "replace") {
        // Najdi existující bod a přidej poznámku
        let annotated = false;
        for (let i = 0; i < parsed.crisisItems.length; i++) {
          if (parsed.crisisItems[i].toLowerCase().includes(u.content.toLowerCase().slice(0, 20))) {
            parsed.crisisItems[i] += `\n  ⚠️ Indikace pro znovuposouzení (${date})`;
            annotated = true;

            // Pokud má 3+ poznámek, smaž
            const warningCount = (parsed.crisisItems[i].match(/⚠️ Indikace/g) || []).length;
            if (warningCount >= 3) {
              console.log(`[SectionJ] Odstraňuji krizový bod s 3+ indikacemi: ${parsed.crisisItems[i].slice(0, 50)}`);
              parsed.crisisItems.splice(i, 1);
            }
            break;
          }
        }
        if (!annotated) {
          parsed.crisisItems.push(`- ${u.content} *(${date})*`);
        }
      } else if (u.type === "delete") {
        parsed.crisisItems = parsed.crisisItems.filter(
          (item) => !item.toLowerCase().includes(u.content.toLowerCase().slice(0, 20)),
        );
      }
    }
  }

  return reassembleSectionJ(parsed);
}

/* ================================================================
   SECTION J PARSER
   ================================================================ */

interface ParsedSectionJ {
  priorities: string[];
  interventions: string[];
  crisisItems: string[];
  rest: string;
}

function parseSectionJ(raw: string): ParsedSectionJ {
  const result: ParsedSectionJ = {
    priorities: [],
    interventions: [],
    crisisItems: [],
    rest: "",
  };

  const lines = raw.split("\n");
  let currentSection: "priorities" | "interventions" | "crisis" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.replace(/^#+\s*/, "").replace(/[*_]/g, "").trim().toLowerCase();

    if (lower.includes("priorit")) {
      currentSection = "priorities";
      continue;
    } else if (lower.includes("intervenc") || lower.includes("návrh")) {
      currentSection = "interventions";
      continue;
    } else if (lower.includes("krizov") || lower.includes("krize")) {
      currentSection = "crisis";
      continue;
    }

    if (!trimmed) continue;

    switch (currentSection) {
      case "priorities":
        result.priorities.push(trimmed);
        break;
      case "interventions":
        result.interventions.push(trimmed);
        break;
      case "crisis":
        result.crisisItems.push(trimmed);
        break;
      default:
        result.rest += line + "\n";
    }
  }

  return result;
}

function reassembleSectionJ(p: ParsedSectionJ): string {
  const sections: string[] = [];
  if (p.rest.trim()) sections.push(p.rest.trim());
  sections.push(`### Priority\n${p.priorities.join("\n") || "(žádné priority)"}`);
  sections.push(`### Návrh intervence pro nejbližší dny\n${p.interventions.join("\n") || "(žádné intervence)"}`);
  sections.push(`### Krizové situace\n${p.crisisItems.join("\n") || "(žádné krizové situace)"}`);
  return sections.join("\n\n");
}
