/**
 * operationalBuilders.ts — Pure view-model builders for Phase 6 surfaces
 * No DB queries. No side effects. Just data transformations.
 */

import type { WriteQueueItemView } from "./governedWriteDecoder";
import { extractQualityLabels } from "./governedWriteDecoder";

// ── Direct Activity Signal ──

export type DirectActivitySignal = {
  entityName: string;
  lastDirectThreadDate: string | null;
  recentDirectThreadCount: number;
  stale: boolean;
};

export function toDirectActivitySignals(rows: Array<{
  part_name: string;
  last_seen_at: string | null;
}>): DirectActivitySignal[] {
  return rows.map((row) => {
    const ts = row.last_seen_at;
    const ageDays = ts
      ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
      : 999;
    return {
      entityName: row.part_name,
      lastDirectThreadDate: ts,
      recentDirectThreadCount: ts && ageDays <= 7 ? 1 : 0,
      stale: !ts || ageDays > 7,
    };
  });
}

// ── Session Packet ──

export type SessionPacket = {
  whatChanged: WriteQueueItemView[];
  urgentNow: WriteQueueItemView[];
  watchItems: WatchItem[];
  activeTasks: Array<{ id: string; task: string; assigned_to: string; status: string; priority: string | null; category: string | null }>;
  openQuestions: WriteQueueItemView[];
};

export type WatchItem = {
  id: string;
  title: string;
  reason: string;
  source: "write" | "continuity" | "task";
  labels: string[];
};

export function buildSessionPacket(input: {
  recentWrites: WriteQueueItemView[];
  tasks: Array<{ id: string; task: string; assigned_to: string; status: string; priority: string | null; category: string | null }>;
  directActivitySignals?: DirectActivitySignal[];
}): SessionPacket {
  const { recentWrites, tasks, directActivitySignals = [] } = input;

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

  // Build watchItems from multiple sources
  const watchItems: WatchItem[] = [];

  // 1. Writes needing attention
  recentWrites.forEach(w => {
    const labels = extractQualityLabels(w.payloadFull);
    const watchLabels = labels.filter(l =>
      l === "VYŽADUJE OVĚŘENÍ" || l === "NEOVĚŘENO" ||
      l === "KONFLIKT" || l === "NÍZKÁ JISTOTA"
    );
    if (watchLabels.length > 0) {
      watchItems.push({
        id: `w-${w.id}`,
        title: w.payloadPreview.split("\n")[0]?.slice(0, 80) || w.targetDocument,
        reason: `${watchLabels.join(", ")} — ${w.targetDocument}`,
        source: "write",
        labels: watchLabels,
      });
    }
  });

  // 2. Stale continuity signals
  directActivitySignals.forEach(s => {
    if (s.stale || s.recentDirectThreadCount === 0) {
      watchItems.push({
        id: `c-${s.entityName}`,
        title: `Kontinuita slábne: ${s.entityName}`,
        reason: s.lastDirectThreadDate
          ? `Poslední přímá aktivita: ${new Date(s.lastDirectThreadDate).toLocaleDateString("cs-CZ")}`
          : "Žádná zaznamenaná přímá aktivita",
        source: "continuity",
        labels: ["STALE"],
      });
    }
  });

  // 3. Blocked/urgent tasks without resolution
  tasks.forEach(t => {
    if (t.status === "blocked" || (t.priority === "urgent" && t.status !== "done")) {
      watchItems.push({
        id: `t-${t.id}`,
        title: t.task.slice(0, 80),
        reason: t.status === "blocked" ? "Úkol je blokovaný" : "Urgentní úkol bez vyřešení",
        source: "task",
        labels: [t.status === "blocked" ? "BLOKOVÁNO" : "URGENTNÍ"],
      });
    }
  });

  return {
    whatChanged,
    urgentNow,
    watchItems: watchItems.slice(0, 8),
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
  directActivitySignals?: DirectActivitySignal[];
}): HandoffSection[] {
  const { recentWrites, tasks, directActivitySignals = [] } = input;
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
    return labels.some(l => l === "KONFLIKT");
  });
  const staleParts = directActivitySignals.filter(s => s.stale);
  const riskItems = [
    ...risks.slice(0, 3).map(w => w.payloadPreview),
    ...staleParts.slice(0, 2).map(s =>
      `⚠️ Slábnoucí kontinuita: ${s.entityName} — ${s.lastDirectThreadDate ? `poslední aktivita ${new Date(s.lastDirectThreadDate).toLocaleDateString("cs-CZ")}` : "žádná zaznamenaná aktivita"}`
    ),
  ];
  if (riskItems.length > 0) {
    sections.push({
      title: "Pozor / rizika",
      items: riskItems.slice(0, 5),
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

  // 4. Otevřené otázky
  const openQuestions = recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l =>
      l === "VYŽADUJE OVĚŘENÍ" || l === "NEOVĚŘENO" || l === "KONFLIKT"
    );
  });
  if (openQuestions.length > 0) {
    sections.push({
      title: "Otevřené otázky",
      items: openQuestions.slice(0, 5).map(w => w.payloadPreview),
      tone: "warning",
    });
  }

  // 5. Aktivní úkoly
  const activeTasks = tasks.filter(t => t.status !== "done" && t.status !== "archived");
  if (activeTasks.length > 0) {
    sections.push({
      title: "Aktivní úkoly",
      items: activeTasks.slice(0, 5).map(t => `${t.priority === "urgent" ? "🔴 " : ""}${t.task}`),
      tone: activeTasks.some(t => t.priority === "urgent") ? "critical" : "neutral",
    });
  }

  // 6. Co nepřehlédnout při dalším kontaktu
  const nextContactItems: string[] = [];
  // Acute + recent updates worth revisiting
  recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "AKUTNÍ" || l === "AKTUALIZACE");
  }).slice(0, 3).forEach(w => {
    nextContactItems.push(w.payloadPreview);
  });
  // Stale continuity
  staleParts.slice(0, 3).forEach(s => {
    nextContactItems.push(
      `Zkontrolovat kontinuitu: ${s.entityName}`
    );
  });
  // Verification-needed items
  recentWrites.filter(w => {
    const labels = extractQualityLabels(w.payloadFull);
    return labels.some(l => l === "VYŽADUJE OVĚŘENÍ");
  }).slice(0, 2).forEach(w => {
    nextContactItems.push(`Ověřit: ${w.payloadPreview.split("\n")[0]?.slice(0, 60)}`);
  });

  if (nextContactItems.length > 0) {
    sections.push({
      title: "Co nepřehlédnout při dalším kontaktu",
      items: nextContactItems.slice(0, 5),
      tone: "neutral",
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
