// FÁZE 3 — CANONICAL OPERATIONAL QUEUE RESOLVER
// did_plan_items = canonical Karel-generated action items.
// did_therapist_tasks = manual / legacy adjunct (deduped when plan_item_id IS NOT NULL).

export interface QueueItem {
  id: string;
  source: "plan_item" | "manual_task";
  text: string;
  assignedTo: string | null;
  priority: string | null;
  status: string;
  category: string | null;
  dueDate: string | null;
  createdAt: string | null;
  planItemId?: string | null;
  reviewAt?: string | null;
  planType?: string | null;
  section?: string | null;
}

export interface OperationalQueue {
  primary: QueueItem[];      // did_plan_items (canonical)
  adjunct: QueueItem[];      // did_therapist_tasks (manual, deduped)
  total: number;
}

/**
 * Resolve the unified operational queue.
 * Primary: did_plan_items (active). Adjunct: did_therapist_tasks where plan_item_id IS NULL.
 * Manual tasks linked via plan_item_id are skipped (deduped against canonical).
 */
export async function resolveOperationalQueue(sb: any, _pragueDate?: string): Promise<OperationalQueue> {
  const [planRes, taskRes] = await Promise.all([
    sb.from("did_plan_items")
      .select("id, plan_type, section, action_required, priority, status, review_at, created_at, source_implication_id")
      .eq("status", "active")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(80),
    sb.from("did_therapist_tasks")
      .select("id, task, assigned_to, priority, status, category, due_date, created_at, plan_item_id")
      .in("status", ["pending", "active", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(80),
  ]);

  const primary: QueueItem[] = (planRes.data || []).map((p: any) => ({
    id: p.id,
    source: "plan_item" as const,
    text: p.action_required || `${p.plan_type}/${p.section}`,
    assignedTo: null,
    priority: p.priority,
    status: p.status,
    category: p.section,
    dueDate: null,
    createdAt: p.created_at,
    planItemId: p.id,
    reviewAt: p.review_at,
    planType: p.plan_type,
    section: p.section,
  }));

  const adjunct: QueueItem[] = (taskRes.data || [])
    .filter((t: any) => !t.plan_item_id) // dedupe: skip manual tasks already linked to canonical plan_item
    .map((t: any) => ({
      id: t.id,
      source: "manual_task" as const,
      text: t.task,
      assignedTo: t.assigned_to,
      priority: t.priority,
      status: t.status,
      category: t.category,
      dueDate: t.due_date,
      createdAt: t.created_at,
      planItemId: null,
    }));

  return {
    primary,
    adjunct,
    total: primary.length + adjunct.length,
  };
}
