import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ListChecks, Loader2, Check } from "lucide-react";
import { toast } from "sonner";

interface TaskSuggestion {
  task: string;
  assignee: "hanka" | "kata" | "both";
  category: "today" | "tomorrow" | "longterm";
}

/**
 * Parse [TASK_SUGGEST:...] tags from Karel's chat response.
 * Format: [TASK_SUGGEST:assignee:category]Task text[/TASK_SUGGEST]
 * Example: [TASK_SUGGEST:hanka:today]Zavolat škole ohledně IVP[/TASK_SUGGEST]
 */
export function parseTaskSuggestions(content: string): { cleanContent: string; suggestions: TaskSuggestion[] } {
  const suggestions: TaskSuggestion[] = [];
  const regex = /\[TASK_SUGGEST:(\w+):(\w+)\](.*?)\[\/TASK_SUGGEST\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const assignee = match[1] as "hanka" | "kata" | "both";
    const category = match[2] as "today" | "tomorrow" | "longterm";
    const task = match[3].trim();
    if (task && ["hanka", "kata", "both"].includes(assignee) && ["today", "tomorrow", "longterm"].includes(category)) {
      suggestions.push({ task, assignee, category });
    }
  }

  const cleanContent = content.replace(/\[TASK_SUGGEST:\w+:\w+\].*?\[\/TASK_SUGGEST\]/g, "").trim();
  return { cleanContent, suggestions };
}

export const TaskSuggestInline = ({ suggestions, onTaskAdded }: { suggestions: TaskSuggestion[]; onTaskAdded?: () => void }) => {
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState<number | null>(null);

  const handleSave = async (suggestion: TaskSuggestion, idx: number) => {
    if (!["hanka", "kata", "both"].includes(suggestion.assignee)) {
      toast.error("Neplatný řešitel úkolu");
      return;
    }
    setSaving(idx);

    // Dedup check
    const normalized = suggestion.task.toLowerCase().replace(/\s+/g, " ").trim();
    const { data: existing } = await supabase
      .from("did_therapist_tasks")
      .select("id")
      .neq("status", "done")
      .ilike("task", `%${normalized.slice(0, 30)}%`)
      .limit(1);

    if (existing && existing.length > 0) {
      toast.info("Podobný úkol už existuje na nástěnce");
      setSavedIds(prev => new Set(prev).add(idx));
      setSaving(null);
      return;
    }

    const { error } = await supabase.from("did_therapist_tasks").insert({
      task: suggestion.task,
      detail_instruction: suggestion.task,
      assigned_to: suggestion.assignee,
      category: suggestion.category,
      status: "pending",
      status_hanka: "not_started",
      status_kata: "not_started",
      source_agreement: "Chat s Karlem",
      priority: suggestion.category === "today" ? "high" : suggestion.category === "tomorrow" ? "normal" : "low",
    });

    if (error) {
      toast.error("Nepodařilo se uložit úkol");
    } else {
      toast.success("Úkol přidán na nástěnku");
      setSavedIds(prev => new Set(prev).add(idx));
      onTaskAdded?.();
    }
    setSaving(null);
  };

  if (suggestions.length === 0) return null;

  const categoryLabel = (c: string) => c === "today" ? "Dnes" : c === "tomorrow" ? "Zítra" : "Dlouhodobé";
  const assigneeLabel = (a: string) => a === "hanka" ? "H" : a === "kata" ? "K" : "H+K";

  return (
    <div className="mt-2 space-y-1.5 border-t border-border/30 pt-2">
      <p className="text-[9px] text-muted-foreground flex items-center gap-1">
        <ListChecks className="w-3 h-3" /> Karel navrhuje zapsat úkol:
      </p>
      {suggestions.map((s, idx) => (
        <div key={idx} className="flex items-center gap-1.5 p-1.5 rounded-md border border-primary/20 bg-primary/5">
          <span className="text-[10px] text-foreground flex-1">{s.task}</span>
          <span className="text-[8px] text-muted-foreground shrink-0">{assigneeLabel(s.assignee)} · {categoryLabel(s.category)}</span>
          <Button
            size="sm"
            variant={savedIds.has(idx) ? "ghost" : "default"}
            onClick={() => handleSave(s, idx)}
            disabled={savedIds.has(idx) || saving === idx}
            className="h-5 text-[8px] px-2 min-w-0"
          >
            {saving === idx ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : savedIds.has(idx) ? <Check className="w-2.5 h-2.5 text-green-500" /> : "Zapsat"}
          </Button>
        </div>
      ))}
    </div>
  );
};
