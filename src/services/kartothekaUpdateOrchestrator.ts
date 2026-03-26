/**
 * Kartotheka Update Orchestrator
 *
 * Hlavní orchestrátor procesu aktualizace kartotéky DID částí.
 * Spouští se manuálně (tlačítko) nebo automaticky (cron 6:00).
 *
 * Kroky:
 *  1. Sběr nezpracovaných vláken (did_threads, sub_mode="cast")
 *  2. Vytvoření záznamů v thread_processing_log
 *  3. Zpracování po částech (analýza → card_update_queue → Drive zápis)
 *  4. Aktualizace Centra (dashboard, operativní plán)
 */

import { supabase } from "@/integrations/supabase/client";
import { analyzeThreadsForPart, type Thread, type CardContent, type SectionUpdates } from "@/services/threadAnalyzer";

/* ---------- Typy ---------- */

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

/* CardUpdateEntry odstraněn – nyní se používá SectionUpdate z threadAnalyzer */

/* ---------- Pomocné funkce ---------- */

/**
 * Vrátí datum posledního úspěšného zpracování pro daný processing_type,
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

/* ---------- Exportované funkce ---------- */

/**
 * Načte vlákna, která ještě nebyla zpracována pro aktualizaci kartotéky.
 */
export async function getUnprocessedThreads(): Promise<UnprocessedThread[]> {
  const lastCompleted = await getLastCompletedAt("kartoteka_update");

  // Výchozí cutoff: 24 h zpět
  const cutoff = lastCompleted ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Načti vlákna z režimu „cast" (DID části mluví s Karlem)
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

  // 2. Zjisti, která vlákna už byla zpracována (completed)
  const threadIds = threads.map((t) => t.id);
  const { data: processed } = await supabase
    .from("thread_processing_log")
    .select("thread_id")
    .in("thread_id", threadIds)
    .eq("status", "completed")
    .eq("processing_type", "kartoteka_update");

  const processedSet = new Set((processed ?? []).map((p) => p.thread_id));

  return threads.filter((t) => !processedSet.has(t.id));
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

  // ── KROK 2: Vytvoř záznamy v processing logu a seskup po částech ──
  const partGroups = new Map<string, UnprocessedThread[]>();

  for (const thread of unprocessed) {
    // Vlož pending záznam
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

  // ── KROK 3: Zpracování po částech ──
  for (const [partId, threads] of partGroups) {
    console.log(`[Kartotheka] Zpracovávám část "${partId}" (${threads.length} vláken)…`);

    try {
      // 3a) Označ vlákna jako „processing"
      const threadIds = threads.map((t) => t.id);
      await supabase
        .from("thread_processing_log")
        .update({ status: "processing" })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");

      // 3b) Načti aktuální kartu z Drive přes edge funkci
      let currentCard: CardContent | null = null;
      try {
        const { data: driveData } = await supabase.functions.invoke("karel-did-drive-read", {
          body: { partName: partId },
        });
        currentCard = driveData?.content ? { M: driveData.content } : null;
      } catch (driveErr) {
        console.warn(`[Kartotheka] Nelze načíst kartu z Drive pro "${partId}":`, driveErr);
      }

      // 3c) Analýza vláken
      const castThreads = threads.map((t) => ({
        ...t,
        messages: Array.isArray(t.messages) ? t.messages : [],
      })) as Thread[];

      const sectionUpdates = await analyzeThreadsForPart(partId, castThreads, currentCard);

      // Flatten SectionUpdates → pole pro card_update_queue
      const allUpdates = Object.values(sectionUpdates).flat();

      // 3d) Ulož výsledky do card_update_queue
      if (allUpdates.length > 0) {
        const rows = allUpdates.map((u) => ({
          part_id: partId,
          section: u.section,
          subsection: u.subsection,
          action: u.type,
          old_content: "",
          new_content: u.content,
          reason: u.reasoning,
          source_thread_id: threads[0]?.id ?? null,
          source_date: u.sourceDate,
          priority: u.section === "J" ? 9 : 5,
          applied: false,
        }));

        const { error: queueErr } = await supabase.from("card_update_queue").insert(rows);
        if (queueErr) {
          console.error(`[Kartotheka] Chyba při ukládání do card_update_queue:`, queueErr.message);
        }
      }

      // 3e) Aplikuj změny na kartu v Drive
      if (allUpdates.length > 0) {
        try {
          await supabase.functions.invoke("karel-did-drive-write", {
            body: {
              partName: partId,
              updates: allUpdates,
            },
          });
          console.log(`[Kartotheka] Karta "${partId}" aktualizována na Drive.`);
        } catch (writeErr) {
          console.warn(`[Kartotheka] Chyba při zápisu karty "${partId}" na Drive:`, writeErr);
        }
      }

      // 3f) Označ vlákna jako „completed"
      const now = new Date().toISOString();
      await supabase
        .from("thread_processing_log")
        .update({ status: "completed", processed_at: now })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");

      console.log(`[Kartotheka] Část "${partId}" zpracována úspěšně.`);
    } catch (err) {
      // Pokud selže zpracování jedné části, pokračuj s dalšími
      console.error(`[Kartotheka] CHYBA při zpracování části "${partId}":`, err);

      const threadIds = threads.map((t) => t.id);
      await supabase
        .from("thread_processing_log")
        .update({ status: "failed", notes: JSON.stringify({ error: String(err) }) })
        .in("thread_id", threadIds)
        .eq("processing_type", "kartoteka_update");
    }
  }

  // ── KROK 4: Aktualizace Centra ──
  console.log("[Kartotheka] Krok 4: Aktualizace Centra (placeholder)…");
  // updateCentrum() – bude implementováno později
  // Aktualizace 00_Aktualni_Dashboard a 05_PLAN/operativni_plan

  console.log("[Kartotheka] === KONEC aktualizace kartotéky ===");
}
