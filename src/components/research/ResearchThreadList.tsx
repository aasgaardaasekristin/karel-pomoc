import { BookOpen, Trash2, Plus, Clock, Search } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import { KarelBadge } from "@/components/ui/KarelBadge";
import { KarelEmptyState } from "@/components/ui/KarelEmptyState";
import type { ResearchThread } from "@/hooks/useResearchThreads";

interface Props {
  threads: ResearchThread[];
  onSelect: (thread: ResearchThread) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  loading?: boolean;
}

const formatTimeAgo = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "právě teď";
  if (hours < 24) return `před ${hours}h`;
  const days = Math.floor(hours / 24);
  return `před ${days}d`;
};

const ResearchThreadList = ({ threads, onSelect, onDelete, onNew, loading }: Props) => {
  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6">
      <div className="text-center mb-6 animate-fade-in">
        <h2 className="text-xl font-bold text-[hsl(var(--text-primary))]">Profesní zdroje</h2>
        <p className="text-sm text-[hsl(var(--text-secondary))] mt-1">
          Vlákna výzkumů a odborných rešerší
        </p>
      </div>

      <KarelButton onClick={onNew} variant="secondary" className="w-full mb-4" icon={<Plus size={16} />}>
        Nové téma
      </KarelButton>

      {loading ? (
        <div className="text-center text-sm text-[hsl(var(--text-tertiary))] py-8">Načítám vlákna…</div>
      ) : threads.length === 0 ? (
        <KarelEmptyState
          icon={<Search size={40} />}
          title="Žádné rešerše"
          description="Klikni na „Nové téma" a začni rešerši."
        />
      ) : (
        <div className="space-y-2">
          {threads.map((thread, index) => (
            <KarelCard
              key={thread.id}
              variant="interactive"
              padding="none"
              className="animate-fade-in group"
              style={{ animationDelay: `${index * 40}ms`, animationFillMode: "both" }}
              onClick={() => onSelect(thread)}
            >
              <div className="flex items-center gap-3 p-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                  <BookOpen size={18} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-[hsl(var(--text-primary))] truncate">{thread.topic}</div>
                  <div className="flex items-center gap-2 text-xs text-[hsl(var(--text-tertiary))] mt-0.5">
                    <KarelBadge variant={thread.createdBy === "Hana" ? "info" : "accent"} size="sm">
                      {thread.createdBy}
                    </KarelBadge>
                    <span>{thread.messages.length} zpráv</span>
                    <span className="flex items-center gap-0.5">
                      <Clock size={10} />
                      {formatTimeAgo(thread.lastActivityAt)}
                    </span>
                  </div>
                </div>
                <KarelButton
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => { e.stopPropagation(); onDelete(thread.id); }}
                  icon={<Trash2 size={14} className="text-destructive" />}
                />
              </div>
            </KarelCard>
          ))}
        </div>
      )}
    </div>
  );
};

export default ResearchThreadList;
