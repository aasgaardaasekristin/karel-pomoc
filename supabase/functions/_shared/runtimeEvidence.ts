/**
 * runtimeEvidence.ts — Phase 4C
 *
 * Pure helper for runtime evidence extraction from did_threads rows.
 * Single responsibility: rows in → evidence out.
 *
 * NO DB queries. NO side effects. NO logging of raw content.
 */

import type { TherapistActivitySnippet } from "./therapistCircumstanceProfiler.ts";

// ── Types ──

export type DidThreadLite = {
  id: string;
  sub_mode: string | null;
  part_name?: string | null;
  last_activity_at?: string | null;
  messages?: unknown;
};

export type ChatMsgLite = {
  role?: string;
  author?: string;
  content?: string;
  timestamp?: string;
};

export type MentionEvidence = {
  mentionedAt: string | null;
  matchedNeedle: string | null;
  threadId: string | null;
};

// ── Thread Splitting ──

export function splitRecentThreads(rows: DidThreadLite[]): {
  castRows: DidThreadLite[];
  therapistRows: DidThreadLite[];
} {
  const castRows = rows.filter((row) => row.sub_mode === "cast");
  const therapistRows = rows.filter(
    (row) => row.sub_mode === "mamka" || row.sub_mode === "kata",
  );
  return { castRows, therapistRows };
}

// ── Text Normalization ──

export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Needle Matching ──

export function buildNeedles(targetPart: string, aliases: string[] = []): string[] {
  return Array.from(
    new Set([targetPart, ...aliases].map((x) => x.trim()).filter(Boolean)),
  );
}

export function messageMentionsNeedle(content: string, needle: string): boolean {
  const normalizedContent = normalizeText(content);
  const normalizedNeedle = normalizeText(needle);
  const rx = new RegExp(`(^|\\W)${escapeRegExp(normalizedNeedle)}($|\\W)`, "i");
  return rx.test(normalizedContent);
}

export function messageMentionsAnyNeedle(
  content: string,
  needles: string[],
): { matched: boolean; matchedNeedle: string | null } {
  for (const needle of needles) {
    if (messageMentionsNeedle(content, needle)) {
      return { matched: true, matchedNeedle: needle };
    }
  }
  return { matched: false, matchedNeedle: null };
}

// ── Therapist Activity Snippets ──

function isAssistantRole(role: string): boolean {
  const r = role.toLowerCase();
  return r.includes("assistant") || r.includes("karel");
}

export function extractTherapistActivitySnippets(
  rows: DidThreadLite[],
): TherapistActivitySnippet[] {
  const snippets: TherapistActivitySnippet[] = [];
  for (const row of rows) {
    const therapist: "hanka" | "kata" | null =
      row.sub_mode === "kata" ? "kata" :
      row.sub_mode === "mamka" ? "hanka" : null;
    if (!therapist) continue;

    const msgs = Array.isArray(row.messages) ? (row.messages as ChatMsgLite[]) : [];
    for (const msg of msgs.slice(-8)) {
      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      if (!content) continue;
      const role = `${msg.role ?? msg.author ?? ""}`;
      if (isAssistantRole(role)) continue;

      snippets.push({
        therapist,
        threadId: row.id,
        timestamp:
          typeof msg.timestamp === "string"
            ? msg.timestamp
            : (row.last_activity_at ?? new Date().toISOString()),
        summaryText: content.slice(0, 1200),
      });
    }
  }
  return snippets;
}

// ── Mention Evidence ──

export function findLastTherapistMentionEvidence(
  rows: DidThreadLite[],
  targetPart: string,
  aliases: string[] = [],
): MentionEvidence {
  const needles = buildNeedles(targetPart, aliases);
  let best: MentionEvidence = {
    mentionedAt: null,
    matchedNeedle: null,
    threadId: null,
  };

  for (const row of rows) {
    const msgs = Array.isArray(row.messages) ? (row.messages as ChatMsgLite[]) : [];
    for (const msg of msgs) {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content) continue;
      const role = `${msg.role ?? msg.author ?? ""}`;
      if (isAssistantRole(role)) continue;

      const mention = messageMentionsAnyNeedle(content, needles);
      if (!mention.matched) continue;

      // Message-level timestamp; fallback to thread only if message has none
      const ts =
        typeof msg.timestamp === "string"
          ? msg.timestamp
          : (typeof row.last_activity_at === "string" ? row.last_activity_at : null);
      if (!ts) continue;

      if (!best.mentionedAt || new Date(ts).getTime() > new Date(best.mentionedAt).getTime()) {
        best = {
          mentionedAt: ts,
          matchedNeedle: mention.matchedNeedle,
          threadId: row.id,
        };
      }
    }
  }

  return best;
}
