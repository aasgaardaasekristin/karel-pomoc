import { useState, useEffect } from "react";
import { FileText, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface RecentSession {
  id: string;
  part_name: string;
  therapist: string;
  session_date: string;
  session_type: string;
  ai_analysis: string | null;
  handoff_note: string | null;
}

const DidColleagueSessionsSection = ({ refreshTrigger }: { refreshTrigger: number }) => {
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, [refreshTrigger]);

  const loadSessions = async () => {
    const { data } = await supabase
      .from("did_part_sessions")
      .select("id, part_name, therapist, session_date, session_type, ai_analysis, handoff_note")
      .order("created_at", { ascending: false })
      .limit(5);
    setSessions((data as RecentSession[]) || []);
  };

  if (sessions.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border/30">
      <h5 className="text-[10px] font-medium text-muted-foreground mb-2 flex items-center gap-1">
        <FileText className="w-3 h-3" />
        Poslední sezení
      </h5>
      <div className="space-y-1.5">
        {sessions.map(s => {
          const isExpanded = expandedId === s.id;
          const preview = s.ai_analysis?.slice(0, 120) || "Bez analýzy";
          const hasHandoff = s.handoff_note && s.handoff_note.trim().length > 0;

          return (
            <div key={s.id} className="rounded-md border border-border/40 bg-background/30 overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : s.id)}
                className="w-full flex items-center gap-2 p-2 text-left hover:bg-accent/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-foreground">{s.part_name}</span>
                    <Badge variant="outline" className="text-[7px] h-3.5 px-1">
                      {s.therapist}
                    </Badge>
                    <span className="text-[8px] text-muted-foreground ml-auto shrink-0">{s.session_date}</span>
                  </div>
                  {!isExpanded && (
                    <p className="text-[9px] text-muted-foreground truncate mt-0.5">{preview}…</p>
                  )}
                </div>
                {isExpanded ? (
                  <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                )}
              </button>
              {isExpanded && (
                <div className="px-2 pb-2 space-y-2">
                  {hasHandoff && (
                    <div className="rounded bg-primary/5 border border-primary/15 p-2">
                      <div className="flex items-center gap-1 mb-1">
                        <MessageSquare className="w-2.5 h-2.5 text-primary" />
                        <span className="text-[9px] font-medium text-primary">Předání pro kolegyni</span>
                      </div>
                      <p className="text-[10px] text-foreground whitespace-pre-wrap">{s.handoff_note}</p>
                    </div>
                  )}
                  {s.ai_analysis && (
                    <div className="text-[10px] text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {s.ai_analysis}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DidColleagueSessionsSection;
