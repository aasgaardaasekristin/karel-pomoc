/**
 * Card Update Applicator
 *
 * Spojuje všechny section updatery do jedné funkce.
 * Sekvenčně aktualizuje sekce A → M a ukládá audit trail do card_update_queue.
 */

import { supabase } from "@/integrations/supabase/client";
import type {
  CardContent,
  SectionKey,
  SectionUpdates,
  Thread,
} from "@/services/threadAnalyzer";
import { updateSectionA } from "@/services/cardUpdaters/sectionAUpdater";
import { updateSectionB } from "@/services/cardUpdaters/sectionBUpdater";
import { updateSectionC } from "@/services/cardUpdaters/sectionCUpdater";
import { updateSectionD, type OperativePlanEntry } from "@/services/cardUpdaters/sectionDUpdater";
import { updateSectionE, updateSectionF, updateSectionG } from "@/services/cardUpdaters/sectionEFGUpdater";
import { updateSectionH, updateSectionI, updateSectionJ } from "@/services/cardUpdaters/sectionHIJUpdater";
import { updateSectionK, updateSectionL, updateSectionM } from "@/services/cardUpdaters/sectionKLMUpdater";

/* ================================================================
   TYPY
   ================================================================ */

export type { OperativePlanEntry };

interface AuditEntry {
  part_id: string;
  section: string;
  subsection: string | null;
  action: string;
  old_content: string | null;
  new_content: string | null;
  reason: string | null;
  source_thread_id: string | null;
  source_date: string | null;
}

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

export async function applyCardUpdates(
  partId: string,
  currentCard: CardContent,
  analyzedUpdates: SectionUpdates,
  threads: Thread[],
  threadDate: string,
  allActivePartsLast24h: string[],
): Promise<{ updatedCard: CardContent; operativePlanEntries: OperativePlanEntry[] }> {
  const updatedCard: CardContent = { ...currentCard };
  const auditEntries: AuditEntry[] = [];
  const operativePlanEntries: OperativePlanEntry[] = [];
  const currentDate = new Date().toISOString().slice(0, 10);
  const firstThreadId = threads[0]?.id ?? null;

  const logChange = (section: SectionKey, oldVal: string | undefined, newVal: string) => {
    if (oldVal !== newVal) {
      auditEntries.push({
        part_id: partId,
        section,
        subsection: null,
        action: "update",
        old_content: oldVal ?? null,
        new_content: newVal,
        reason: `Automatická aktualizace z vlákna ${threadDate}`,
        source_thread_id: firstThreadId,
        source_date: threadDate,
      });
      const preview = newVal.length > 80 ? newVal.slice(0, 80) + "…" : newVal;
      console.log(`[CardApplicator] Sekce ${section} změněna → ${preview}`);
    } else {
      console.log(`[CardApplicator] Sekce ${section} beze změny`);
    }
  };

  // Helper pro bezpečné volání updaterů
  const safe = async <T>(section: SectionKey, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[CardApplicator] Chyba v sekci ${section}:`, err);
      return fallback;
    }
  };

  // ── A ──
  const newA = await safe("A", () => updateSectionA(currentCard.A ?? "", analyzedUpdates.A ?? [], threadDate), currentCard.A ?? "");
  logChange("A", currentCard.A, newA);
  updatedCard.A = newA;

  // ── B ──
  const newB = await safe("B", () => updateSectionB(currentCard.B ?? "", analyzedUpdates.B ?? [], threads, threadDate), currentCard.B ?? "");
  logChange("B", currentCard.B, newB);
  updatedCard.B = newB;

  // ── C ──
  const newC = await safe("C", () => updateSectionC(currentCard.C ?? "", analyzedUpdates.C ?? [], threads, threadDate), currentCard.C ?? "");
  logChange("C", currentCard.C, newC);
  updatedCard.C = newC;

  // ── D ──
  const dResult = await safe(
    "D",
    () => updateSectionD(currentCard.D ?? "", analyzedUpdates.D ?? [], threads, threadDate, partId),
    { updatedText: currentCard.D ?? "", operativePlanEntries: [] },
  );
  logChange("D", currentCard.D, dResult.updatedText);
  updatedCard.D = dResult.updatedText;
  operativePlanEntries.push(...dResult.operativePlanEntries);

  // ── E ──
  const partName = threads[0]?.part_name ?? partId;
  const newE = await safe("E", () => updateSectionE(currentCard.E ?? "", threads, threadDate, partName), currentCard.E ?? "");
  logChange("E", currentCard.E, newE);
  updatedCard.E = newE;

  // ── F ──
  const newF = await safe("F", () => updateSectionF(currentCard.F ?? "", threads, threadDate, currentDate), currentCard.F ?? "");
  logChange("F", currentCard.F, newF);
  updatedCard.F = newF;

  // ── G ──
  const newG = await safe("G", () => updateSectionG(currentCard.G ?? "", threads, threadDate), currentCard.G ?? "");
  logChange("G", currentCard.G, newG);
  updatedCard.G = newG;

  // ── H ──
  const newH = await safe("H", () => updateSectionH(currentCard.H ?? "", analyzedUpdates.H ?? [], threads, threadDate), currentCard.H ?? "");
  logChange("H", currentCard.H, newH);
  updatedCard.H = newH;

  // ── I ──
  const newI = await safe("I", () => updateSectionI(currentCard.I ?? "", analyzedUpdates.I ?? [], threads, threadDate), currentCard.I ?? "");
  logChange("I", currentCard.I, newI);
  updatedCard.I = newI;

  // ── J (závisí na aktualizované I) ──
  const newJ = await safe("J", () => updateSectionJ(currentCard.J ?? "", analyzedUpdates.J ?? [], threads, threadDate, newI), currentCard.J ?? "");
  logChange("J", currentCard.J, newJ);
  updatedCard.J = newJ;

  // ── K ──
  const newK = await safe("K", () => updateSectionK(currentCard.K ?? "", threads, threadDate), currentCard.K ?? "");
  logChange("K", currentCard.K, newK);
  updatedCard.K = newK;

  // ── L ──
  const newL = await safe("L", () => updateSectionL(currentCard.L ?? "", threads, threadDate, allActivePartsLast24h), currentCard.L ?? "");
  logChange("L", currentCard.L, newL);
  updatedCard.L = newL;

  // ── M ──
  const newM = await safe("M", () => updateSectionM(currentCard.M ?? "", threads, threadDate), currentCard.M ?? "");
  logChange("M", currentCard.M, newM);
  updatedCard.M = newM;

  // ── Audit trail ──
  if (auditEntries.length > 0) {
    try {
      const { error } = await supabase.from("card_update_queue").insert(
        auditEntries.map((e) => ({
          part_id: e.part_id,
          section: e.section,
          subsection: e.subsection,
          action: e.action,
          old_content: e.old_content,
          new_content: e.new_content,
          reason: e.reason,
          source_thread_id: e.source_thread_id,
          source_date: e.source_date,
        })),
      );
      if (error) console.error("[CardApplicator] Audit insert error:", error);
      else console.log(`[CardApplicator] Uloženo ${auditEntries.length} audit záznamů`);
    } catch (err) {
      console.error("[CardApplicator] Audit insert exception:", err);
    }
  }

  console.log(`[CardApplicator] Hotovo pro ${partId}: ${auditEntries.length} změn, ${operativePlanEntries.length} OP entries`);
  return { updatedCard, operativePlanEntries };
}

/* ================================================================
   SAVE CARD TO DRIVE
   ================================================================ */

/**
 * Serializuje CardContent do textu a nahraje zpět do Google Drive
 * přes edge funkci karel-did-drive-write.
 */
export async function saveCardToDrive(
  partName: string,
  updatedCard: CardContent,
): Promise<void> {
  const sectionKeys: SectionKey[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

  const sections: Record<string, string> = {};
  const sectionModes: Record<string, string> = {};
  for (const key of sectionKeys) {
    sections[key] = updatedCard[key] || "";
    sectionModes[key] = "REPLACE";
  }

  try {
    const { data, error } = await supabase.functions.invoke("karel-did-card-update", {
      body: {
        partName,
        sections,
        sectionModes,
      },
    });

    if (error) {
      console.error(`[CardApplicator] Drive write error for ${partName}:`, error);
      throw error;
    }

    console.log(`[CardApplicator] Karta "${partName}" uložena na Drive:`, data);
  } catch (err) {
    console.error(`[CardApplicator] Failed to save card "${partName}" to Drive:`, err);
    throw err;
  }
}
