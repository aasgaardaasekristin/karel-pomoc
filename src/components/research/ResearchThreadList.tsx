import { Clock, Search } from "lucide-react";
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
    <div className="max-w-2xl mx-auto px-3 sm:px-4 pt-2 pb-6 relative z-10 flex flex-col h-full justify-start">
      <div className="text-center mb-6 animate-fade-in">
        <h2 className="text-xl font-bold" style={{ color: '#1a5c2e' }}>Profesní zdroje</h2>
        <p className="text-sm mt-1" style={{ color: '#2d7a45' }}>
          Vlákna výzkumů a odborných rešerší
        </p>
      </div>

      {loading ? (
        <div className="text-center text-sm py-8" style={{ color: '#2d7a45' }}>Načítám vlákna…</div>
      ) : threads.length === 0 ? (
        <KarelEmptyState
          icon={<Search size={40} />}
          title="Žádné rešerše"
          description={'Klikni na „+ Nové téma" v horní liště.'}
        />
      ) : (
        <div className="space-y-1">
          {threads.map((thread, index) => (
            <div
              key={thread.id}
              className="animate-fade-in cursor-pointer transition-all hover:bg-white/10 rounded-lg px-3 py-1.5 border border-emerald-900/20 bg-white/5 backdrop-blur-sm"
              style={{ animationDelay: `${index * 40}ms`, animationFillMode: "both" }}
              onClick={() => onSelect(thread)}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium truncate" style={{ color: '#1a5c2e' }}>
                  {thread.topic}
                </span>
                <div className="flex items-center gap-2 text-xs shrink-0" style={{ color: '#3a8a55' }}>
                  <span>{thread.messages.length} zpráv</span>
                  <span className="flex items-center gap-0.5">
                    <Clock size={10} />
                    {formatTimeAgo(thread.lastActivityAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ResearchThreadList;
