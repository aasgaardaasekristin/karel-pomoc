/**
 * operationalBuilders.ts — Pure view-model builders for Phase 6 surfaces
 * No DB queries. No side effects. Just data transformations.
 */

import type { WriteQueueItemView } from "./governedWriteDecoder";
import { extractQualityLabels } from "./governedWriteDecoder";

// ── Session Packet ──

export type SessionPacket = {
  whatChanged: WriteQueueItemView[];
  urgentNow: WriteQueueItemView[];
  watchItems: WriteQueueItemView[];
  activeTasks: Array<{ id: string; task: string; assigned_to: string; status: string; priority: string | null; category: string | null }>;
  openQuestions: WriteQueueItemView[];
};

export function buildSessionPacket(input: {
  recentWrites: WriteQueueItemView[];
  tasks: Array<{ id: string; task: string; assigned_to: string; status: string; priority: string | null; category: string | null }>;
}): SessionPacket {
  const { recentWrites, tasks } = input;

  const whatChanged = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "NOVÉ" || l === "AKTUALIZACE");
  }).slice(0, 8);

  const urgentNow = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "AKUTNÍ") || w.priority === "high";
  }).slice(0, 6);

  const openQuestions = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l =>
      l === "VYŽADUJE OVĚŘENÍ" || l === "NEOVĚŘENO" || l === "KONFLIKT"
    );
  }).slice(0, 6);

  return {
    whatChanged,
    urgentNow,
    watchItems: [],
    activeTasks: tasks.slice(0, 10),
    openQuestions,
  };
}

// ── Handoff ──

export type HandoffSection = {
  title: string;
  items: string[];
  tone: "neutral" | "warning" | "critical";
};

export function buildHandoff(input: {
  recentWrites: WriteQueueItemView[];
  tasks: Array<{ task: string; priority: string | null; status: string }>;
}): HandoffSection[] {
  const { recentWrites, tasks } = input;
  const sections: HandoffSection[] = [];

  // 1. Dnes / nejbližší 3 dny
  const urgent = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "AKUTNÍ" || l === "NOVÉ");
  });
  if (urgent.length > 0) {
    sections.push({
      title: "Dnes / nejbližší 3 dny",
      items: urgent.slice(0, 5).map(w => w.payloadPreview),
      tone: "neutral",
    });
  }

  // 2. Pozor / rizika
  const risks = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "KONFLIKT" || l === "VYŽADUJE OVĚŘENÍ");
  });
  if (risks.length > 0) {
    sections.push({
      title: "Pozor / rizika",
      items: risks.slice(0, 5).map(w => w.payloadPreview),
      tone: "warning",
    });
  }

  // 3. Co se změnilo
  const updates = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "AKTUALIZACE");
  });
  if (updates.length > 0) {
    sections.push({
      title: "Co se změnilo",
      items: updates.slice(0, 5).map(w => w.payloadPreview),
      tone: "neutral",
    });
  }

  // 4. Aktivní úkoly
  const activeTasks = tasks.filter(t => t.status !== "done" && t.status !== "archived");
  if (activeTasks.length > 0) {
    sections.push({
      title: "Aktivní úkoly",
      items: activeTasks.slice(0, 5).map(t => `${t.priority === "urgent" ? "🔴 " : ""}${t.task}`),
      tone: activeTasks.some(t => t.priority === "urgent") ? "critical" : "neutral",
    });
  }

  return sections;
}

// ── Recovery ──

export type RecoveryItem = {
  level: "info" | "warning" | "critical";
  title: string;
  reason: string;
};

export function buildRecoveryItems(input: {
  openQuestions: WriteQueueItemView[];
  tasks: Array<{ task: string; status: string; priority: string | null }>;
  staleParts: Array<{ name: string; lastSeen: string | null }>;
  pendingWriteCount: number;
}): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  // Stale parts
  for (const part of input.staleParts) {
    const daysSince = part.lastSeen
      ? Math.floor((Date.now() - new Date(part.lastSeen).getTime()) / 86400000)
      : 999;
    if (daysSince > 7) {
      items.push({
        level: daysSince > 14 ? "critical" : "warning",
        title: `Slábnoucí kontinuita: ${part.name}`,
        reason: `Poslední aktivita před ${daysSince} dny.`,
      });
    }
  }

  // Accumulating open questions
  if (input.openQuestions.length >= 3) {
    items.push({
      level: "warning",
      title: "Hromadí se neověřené otázky",
      reason: `${input.openQuestions.length} neověřených nebo konfliktních signálů ve frontě.`,
    });
  }

  // Write queue backlog
  if (input.pendingWriteCount > 10) {
    items.push({
      level: input.pendingWriteCount > 25 ? "critical" : "warning",
      title: "Fronta zápisů narůstá",
      reason: `${input.pendingWriteCount} zápisů čeká na zpracování.`,
    });
  }

  // Blocked tasks
  const blockedTasks = input.tasks.filter(t =>
    t.status === "blocked" || (t.priority === "urgent" && t.status !== "done")
  );
  if (blockedTasks.length > 0) {
    items.push({
      level: "critical",
      title: `${blockedTasks.length} urgentních/blokovaných úkolů`,
      reason: "Je potřeba znovu projít přiřazení nebo načasování.",
    });
  }

  return items;
}
