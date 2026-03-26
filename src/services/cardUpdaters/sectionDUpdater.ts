/**
 * Section D Updater — "Terapeutická doporučení"
 *
 * Karel zde ukládá doporučení pro terapii dané části.
 * Vrací aktualizovaný text sekce D + pole OperativePlanEntry pro operativní plán.
 */

import type { SectionUpdate, Thread } from "@/services/threadAnalyzer";
import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   TYPY
   ================================================================ */

export interface OperativePlanEntry {
  partId: string;
  partName: string;
  activity: string;
  therapist: string;
  urgency: "dnes" | "zitra" | "tento_tyden" | "do_14_dni";
  reason: string;
  sourceDate: string;
  createdAt: string;
}

interface NewTechnique {
  name: string;
  goal: string;
  problem: string;
  reasoning: string;
  therapist: string;
  urgency: string;
}

interface SectionDResult {
  updatedRecommendations: string;
  newTechniques: NewTechnique[];
}

/* ================================================================
   HELPERS
   ================================================================ */

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

function normalizeUrgency(raw: string): OperativePlanEntry["urgency"] {
  const lower = (raw || "").toLowerCase().replace(/\s+/g, "_");
  if (lower.includes("dnes")) return "dnes";
  if (lower.includes("zitra") || lower.includes("zítra")) return "zitra";
  if (lower.includes("14") || lower.includes("dvou")) return "do_14_dni";
  return "tento_tyden";
}

/* ================================================================
   AI VOLÁNÍ S RETRY
   ================================================================ */

async function callSectionDTherapy(
  body: Record<string, unknown>,
  maxRetries = 3,
): Promise<{ data: SectionDResult | null; error: string | null }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.functions.invoke("karel-section-d-therapy", { body });

      if (error) {
        console.warn(`[SectionD] AI attempt ${attempt}/${maxRetries} failed:`, error);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return { data: null, error: String(error) };
      }

      return { data: data as SectionDResult, error: null };
    } catch (err) {
      console.warn(`[SectionD] AI attempt ${attempt}/${maxRetries} exception:`, err);
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
   HLAVNÍ FUNKCE
   ================================================================ */

export async function updateSectionD(
  currentSectionD: string,
  updates: SectionUpdate[],
  threads: Thread[],
  threadDate: string,
  partId: string,
): Promise<{ updatedText: string; operativePlanEntries: OperativePlanEntry[] }> {
  const emptyResult = { updatedText: currentSectionD, operativePlanEntries: [] as OperativePlanEntry[] };

  if (!threads.length) {
    console.log("[SectionD] Žádná vlákna k analýze.");
    return emptyResult;
  }

  const partName = threads[0]?.part_name ?? partId;
  const date = threadDate.slice(0, 10);
  const threadsText = serializeThreads(threads);

  console.log(`[SectionD] Analyzuji doporučení pro "${partName}"…`);

  const { data, error } = await callSectionDTherapy({
    currentRecommendations: currentSectionD,
    threads: threadsText,
    partId,
    partName,
  });

  if (error || !data) {
    console.error(`[SectionD] Edge funkce selhala:`, error);
    return emptyResult;
  }

  // Aktualizuj text sekce D
  let updatedText = data.updatedRecommendations || currentSectionD;

  // Vytvoř OperativePlanEntry pro každou novou techniku
  const operativePlanEntries: OperativePlanEntry[] = [];
  const now = new Date().toISOString();

  if (data.newTechniques?.length) {
    for (const tech of data.newTechniques) {
      // Přidej techniku do textu sekce D pokud tam ještě není
      if (!updatedText.includes(tech.name)) {
        updatedText += `\n\n#### ${tech.name}\n- **Cíl:** ${tech.goal}\n- **Pro problém:** ${tech.problem}\n- **Proč funguje:** ${tech.reasoning}\n- **Doporučený terapeut:** ${tech.therapist}\n- **Urgence:** ${tech.urgency}\n- *Přidáno: ${date}*`;
      }

      operativePlanEntries.push({
        partId,
        partName,
        activity: `${tech.name}: ${tech.goal}`,
        therapist: tech.therapist || "Hanka",
        urgency: normalizeUrgency(tech.urgency),
        reason: `${tech.problem} — ${tech.reasoning}`,
        sourceDate: date,
        createdAt: now,
      });
    }

    console.log(`[SectionD] Pro "${partName}" nalezeno ${data.newTechniques.length} nových technik → ${operativePlanEntries.length} OP entries.`);
  } else {
    console.log(`[SectionD] Pro "${partName}" žádné nové techniky.`);
  }

  return { updatedText, operativePlanEntries };
}
