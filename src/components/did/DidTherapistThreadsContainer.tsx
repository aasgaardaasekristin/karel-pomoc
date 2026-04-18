import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { DidThread } from "@/hooks/useDidThreads";
import DidTherapistThreads, { type DidWorkspaceMeta } from "./DidTherapistThreads";

/**
 * Container that loads canonical workspace metadata for therapist threads.
 *
 * Source-of-truth per workspace_type:
 *  - "task"     → did_therapist_tasks.id     (assigned_to)
 *  - "question" → did_pending_questions.id   (directed_to, part_name)
 *  - "session"  → did_daily_session_plans.id (selected_part)
 *
 * If a thread has no workspace_id, or the row cannot be resolved, we simply
 * omit it from the meta map. DidTherapistThreads then degrades to title +
 * preview only — no fabricated metadata, no regex parsing of message text.
 */
interface Props {
  therapistName: string;
  threads: DidThread[];
  onSelectThread: (thread: DidThread) => void;
  onDeleteThread: (threadId: string) => void;
  onNewThread: () => void;
  onBack: () => void;
}

const formatAssignee = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "both") return "Hanička i Káťa";
  if (v === "hanka" || v === "hanička") return "Hanička";
  if (v === "kata" || v === "káťa") return "Káťa";
  return value;
};

const DidTherapistThreadsContainer = (props: Props) => {
  const [meta, setMeta] = useState<Record<string, DidWorkspaceMeta>>({});

  // Stable key set so we only refetch when the relevant workspace ids change.
  const workspaceKey = useMemo(() => {
    return props.threads
      .filter((t) => t.workspaceType && t.workspaceId)
      .map((t) => `${t.id}:${t.workspaceType}:${t.workspaceId}`)
      .sort()
      .join("|");
  }, [props.threads]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const buckets = {
        task: [] as { threadId: string; workspaceId: string }[],
        question: [] as { threadId: string; workspaceId: string }[],
        session: [] as { threadId: string; workspaceId: string }[],
      };

      for (const t of props.threads) {
        if (!t.workspaceType || !t.workspaceId) continue;
        if (t.workspaceType in buckets) {
          buckets[t.workspaceType as keyof typeof buckets].push({
            threadId: t.id,
            workspaceId: t.workspaceId,
          });
        }
      }

      const next: Record<string, DidWorkspaceMeta> = {};

      const taskIds = buckets.task.map((b) => b.workspaceId);
      const questionIds = buckets.question.map((b) => b.workspaceId);
      const sessionIds = buckets.session.map((b) => b.workspaceId);

      const [tasksRes, questionsRes, sessionsRes] = await Promise.all([
        taskIds.length
          ? supabase
              .from("did_therapist_tasks")
              .select("id, assigned_to, priority")
              .in("id", taskIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        questionIds.length
          ? supabase
              .from("did_pending_questions")
              .select("id, directed_to, part_name")
              .in("id", questionIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        sessionIds.length
          ? supabase
              .from("did_daily_session_plans")
              .select("id, selected_part")
              .in("id", sessionIds)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const taskById = new Map<string, any>(
        ((tasksRes as any).data || []).map((r: any) => [r.id, r]),
      );
      const questionById = new Map<string, any>(
        ((questionsRes as any).data || []).map((r: any) => [r.id, r]),
      );
      const sessionById = new Map<string, any>(
        ((sessionsRes as any).data || []).map((r: any) => [r.id, r]),
      );

      for (const b of buckets.task) {
        const row = taskById.get(b.workspaceId);
        if (!row) continue;
        const assignee = formatAssignee(row.assigned_to);
        const detailLine = [
          assignee ? `Pro ${assignee}` : null,
          row.priority ? `priorita: ${row.priority}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        next[b.threadId] = { assignee, detailLine: detailLine || undefined };
      }

      for (const b of buckets.question) {
        const row = questionById.get(b.workspaceId);
        if (!row) continue;
        const assignee = formatAssignee(row.directed_to);
        const partName = row.part_name || undefined;
        const detailLine = [
          assignee ? `Pro ${assignee}` : null,
          partName ? `část: ${partName}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        next[b.threadId] = { assignee, partName, detailLine: detailLine || undefined };
      }

      for (const b of buckets.session) {
        const row = sessionById.get(b.workspaceId);
        if (!row) continue;
        const partName = row.selected_part || undefined;
        const detailLine = partName ? `Sezení: ${partName}` : undefined;
        next[b.threadId] = { partName, detailLine };
      }

      if (!cancelled) setMeta(next);
    };

    load().catch((e) => console.warn("workspace meta load failed:", e));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey]);

  return <DidTherapistThreads {...props} workspaceMeta={meta} />;
};

export default DidTherapistThreadsContainer;
