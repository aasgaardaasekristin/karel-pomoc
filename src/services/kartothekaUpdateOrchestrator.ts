/**
 * Kartotheka Update Orchestrator
 *
 * Hlavní orchestrátor procesu aktualizace kartotéky DID částí.
 * Spouští se manuálně (tlačítko) nebo automaticky (cron 6:00).
 *
 * Kroky:
 *  1. Sběr nezpracovaných vláken (did_threads, sub_mode="cast")
 *  2. Vytvoření záznamů v thread_processing_log + seskupení po částech
 *  3. Zpracování po částech (analýza → applyCardUpdates → saveCardToDrive)
 *  4. Aktualizace Centra (dashboard, operativní plán)
 */

import { supabase } from "@/integrations/supabase/client";
import {
  analyzeThreadsForPart,
  type Thread,
  type CardContent,
  type SectionKey,
} from "@/services/threadAnalyzer";
import {
  applyCardUpdates,
  saveCardToDrive,
  type OperativePlanEntry,
} from "@/services/cardUpdateApplicator";

/* ================================================================
   TYPY
   ================================================================ */

export interface UnprocessedThread {
  id: string;
  part_name: string;
  messages: unknown;
  last_activity_at: string;
  thread_label: string | null;
}

export interface ProcessingStatus {
  total_threads: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  last_run_at: string | null;
}

/* ================================================================
   POMOCNÉ FUNKCE
   ================================================================ */

/**
 * Vrátí datum posledního úspěšného zpracování,
 * nebo null (= zpracovat posledních 24 h).
 */
async function getLastCompletedAt(processingType: string): Promise<string | null> {
  const { data } = await supabase
    .from("thread_processing_log")
    .select("processed_at")
    .eq("processing_type", processingType)
    .eq("status", "completed")
    .order("processed_at", { ascending: false })
    .limit(1);

  return data?.[0]?.processed_at ?? null;
}

/**
 * Parsuje surový text karty z Drive do CardContent (sekce A-M).
 */
function parseCardFromDriveText(rawText: string): CardContent {
  const card: CardContent = {};
  const sectionKeys: SectionKey[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

  // Hledáme nadpisy ve formátu "# A –" nebo "# B –" atd.
  for (let i = 0; i < sectionKeys.length; i++) {
    const key = sectionKeys[i];
    const regex = new RegExp(`#\\s*${key}\\s*[–—-]`, "i");
    const startIdx = rawText.search(regex);
    if (startIdx === -1) continue;

    // Najdi konec sekce (začátek další sekce nebo konec textu)
    const afterHeader = rawText.indexOf("\n", startIdx);
    if (afterHeader === -1) continue;

    let endIdx = rawText.length;
    for (let j = i + 1; j < sectionKeys.length; j++) {
      const nextRegex = new RegExp(`#\\s*${sectionKeys[j]}\\s*[–—-]`, "i");
      const nextIdx = rawText.search(nextRegex);
      if (nextIdx !== -1 && nextIdx > startIdx) {
        endIdx = nextIdx;
        break;
      }
    }

    card[key] = rawText.slice(afterHeader + 1, endIdx).trim();
  }

  return card;
}

/**
 * Zjistí, které části byly aktivní za posledních 24h.
 */
async function getActivePartsLast24h(): Promise<string[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("did_threads")
    .select("part_name")
    .eq("sub_mode", "cast")
    .gte("last_activity_at", cutoff);

  if (!data) return [];
  return [...new Set(data.map((t) => t.part_name))];
}

/* ================================================================
   EXPORTOVANÉ FUNKCE
   ================================================================ */

/**
 * Načte vlákna, která ještě nebyla zpracována pro aktualizaci kartotéky.
 */
/** Blacklist — terapeutky a AI nesmí být zpracovány jako DID části */
const THERAPIST_BLACKLIST = [
  "hanka", "hanička", "hanicka", "hana", "hani",
  "káťa", "kata", "kateřina", "katerina",
  "karel",
];

function isTherapistName(name: string): boolean {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return THERAPIST_BLACKLIST.some((t) => normalized === t || normalized.includes(t));
}

export async function getUnprocessedThreads(): Promise<UnprocessedThread[]> {
  const lastCompleted = await getLastCompletedAt("kartoteka_update");
  const cutoff = lastCompleted ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: threads, error } = await supabase
    .from("did_threads")
    .select("id, part_name, messages, last_activity_at, thread_label")
    .eq("sub_mode", "cast")
    .gte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: true });

  if (error) {
    console.error("[Kartotheka] Chyba při načítání vláken:", error.message);
    return [];
  }

  if (!threads?.length) {
    console.log("[Kartotheka] Žádná nová vlákna od", cutoff);
    return [];
  }

  // Safeguard: odfiltruj terapeutky i kdyby sub_mode byl špatně
  const safeThreads = threads.filter((t) => {
    if (isTherapistName(t.part_name)) {
      console.warn(`[Kartotheka] ⚠️ PŘESKOČENO vlákno "${t.part_name}" — jméno terapeutky/AI, ne DID část.`);
      return false;
    }
    return true;
  });

  // Odfiltruj již zpracovaná vlákna
  const threadIds = safeThreads.map((t) => t.id);
  if (threadIds.length === 0) return [];

  const { data: processed } = await supabase
    .from("thread_processing_log")
    .select("thread_id")
    .in("thread_id", threadIds)
    .eq("status", "completed")
    .eq("processing_type", "kartoteka_update");

  const processedSet = new Set((processed ?? []).map((p) => p.thread_id));
  return safeThreads.filter((t) => !processedSet.has(t.id));
}

/**
 * Vrátí přehled stavu zpracování.
 */
export async function getProcessingStatus(): Promise<ProcessingStatus> {
  const { data, error } = await supabase
    .from("thread_processing_log")
    .select("status, processed_at")
    .eq("processing_type", "kartoteka_update")
    .order("processed_at", { ascending: false });

  if (error || !data) {
    return { total_threads: 0, pending: 0, processing: 0, completed: 0, failed: 0, last_run_at: null };
  }

  return {
    total_threads: data.length,
    pending: data.filter((r) => r.status === "pending").length,
    processing: data.filter((r) => r.status === "processing").length,
    completed: data.filter((r) => r.status === "completed").length,
    failed: data.filter((r) => r.status === "failed").length,
    last_run_at: data[0]?.processed_at ?? null,
  };
}

/**
 * Hlavní orchestrační funkce.
 */
export async function runKartothekaUpdate(): Promise<void> {
  console.log("[Kartotheka] === START aktualizace kartotéky ===");

  // ── KROK 1: Sběr nezpracovaných vláken ──
  const unprocessed = await getUnprocessedThreads();
  if (unprocessed.length === 0) {
    console.log("[Kartotheka] Žádná nezpracovaná vlákna. Končím.");
    return;
  }
  console.log(`[Kartotheka] Nalezeno ${unprocessed.length} nezpracovaných vláken.`);

  // ── KROK 2: Záznamy v processing logu + seskupení po částech ──
  const partGroups = new Map<string, UnprocessedThread[]>();

  for (const thread of unprocessed) {
    await supabase.from("thread_processing_log").insert({
      thread_id: thread.id,
      part_id: thread.part_name,
      processing_type: "kartoteka_update",
      status: "pending",
    });

    const existing = partGroups.get(thread.part_name) ?? [];
    existing.push(thread);
    partGroups.set(thread.part_name, existing);
  }

  console.log(`[Kartotheka] Seskupeno do ${partGroups.size} částí.`);

  // Předem zjisti aktivní části za 24h (pro sekci L)
  const allActivePartsLast24h = await getActivePartsLast24h();

  // Shromáždi OP entries ze všech částí
  const allOperativePlanEntries: OperativePlanEntry[] = [];

  // ── KROK 3: Zpracování po částech ──
  for (const [partId, threads] of partGroups) {
    console.log(`[Kartotheka] Zpracovávám část "${partId}" (${threads.length} vláken)…`);
    const threadIds = threads.map((t) => t.id);

    try {
      // 3a) Označ vlákna jako „processing"
      await supabase
        .from("thread_processing_log")
        .update({ status: "processing" })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");

      // 3b) Načti aktuální kartu z Drive
      let currentCard: CardContent = {};
      try {
        const { data: driveData } = await supabase.functions.invoke("karel-did-drive-read", {
          body: { partName: partId },
        });
        if (driveData?.content) {
          currentCard = parseCardFromDriveText(driveData.content);
        }
      } catch (driveErr) {
        console.warn(`[Kartotheka] Nelze načíst kartu z Drive pro "${partId}":`, driveErr);
      }

      // 3c) Konverze vláken na Thread[]
      const castThreads: Thread[] = threads.map((t) => ({
        id: t.id,
        part_name: t.part_name,
        messages: Array.isArray(t.messages) ? t.messages : [],
        last_activity_at: t.last_activity_at,
        thread_label: t.thread_label,
      }));

      // Datum vlákna (nejnovější)
      const threadDate = castThreads
        .map((t) => t.last_activity_at)
        .sort()
        .pop()?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

      // 3d) AI analýza vláken → roztřídění do sekcí
      const sectionUpdates = await analyzeThreadsForPart(partId, castThreads, currentCard);

      // 3e) Aplikace změn pomocí cardUpdateApplicator (sekvenčně A→M)
      const { updatedCard, operativePlanEntries } = await applyCardUpdates(
        partId,
        currentCard,
        sectionUpdates,
        castThreads,
        threadDate,
        allActivePartsLast24h,
      );

      allOperativePlanEntries.push(...operativePlanEntries);

      // 3f) Uložení aktualizované karty na Drive
      try {
        await saveCardToDrive(partId, updatedCard);
        console.log(`[Kartotheka] Karta "${partId}" uložena na Drive.`);
      } catch (writeErr) {
        console.warn(`[Kartotheka] Chyba při zápisu karty "${partId}" na Drive:`, writeErr);
      }

      // 3g) Označ vlákna jako „completed"
      const now = new Date().toISOString();
      await supabase
        .from("thread_processing_log")
        .update({ status: "completed", processed_at: now })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");

      // Označ vlákna v did_threads jako zpracovaná
      await supabase
        .from("did_threads")
        .update({ is_processed: true, processed_at: now })
        .in("id", threadIds);

      console.log(`[Kartotheka] Část "${partId}" zpracována úspěšně.`);
    } catch (err) {
      console.error(`[Kartotheka] CHYBA při zpracování části "${partId}":`, err);

      await supabase
        .from("thread_processing_log")
        .update({ status: "failed", notes: JSON.stringify({ error: String(err) }) })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");
    }
  }

  // ── KROK 4: Aktualizace Centra ──
  console.log("[Kartotheka] Krok 4: Aktualizace Centra…");
  try {
    // updateCentrum() – bude plně implementováno později
    // Prozatím logujeme OP entries
    if (allOperativePlanEntries.length > 0) {
      console.log(`[Kartotheka] ${allOperativePlanEntries.length} operativních plánových záznamů k distribuci.`);
      // TODO: Zápis do 05_PLAN/operativni_plan a 00_Aktualni_Dashboard
    }
  } catch (centrumErr) {
    console.error("[Kartotheka] Chyba při aktualizaci Centra:", centrumErr);
  }

  console.log("[Kartotheka] === KONEC aktualizace kartotéky ===");
}
