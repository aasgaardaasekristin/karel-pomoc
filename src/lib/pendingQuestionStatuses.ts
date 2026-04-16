/**
 * Shared definition of "open" pending question statuses.
 * Used by PendingQuestionsPanel and useOperationalInboxCounts to keep
 * the panel header, badges and ops snapshot perfectly in sync.
 */
export const OPEN_QUESTION_STATUSES = ["pending", "sent", "open"] as const;
export type OpenQuestionStatus = (typeof OPEN_QUESTION_STATUSES)[number];

/**
 * Event name fired on `window` after a pending question has been
 * successfully answered (or otherwise mutated). Listeners — like the
 * shared ops counts hook — should re-fetch immediately so dashboards
 * and badges stay consistent without waiting for the 30s polling tick.
 */
export const PENDING_QUESTIONS_CHANGED_EVENT = "did:pending-questions-changed";

export function emitPendingQuestionsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PENDING_QUESTIONS_CHANGED_EVENT));
  }
}
