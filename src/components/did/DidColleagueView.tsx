import { useState, useEffect } from "react";
import { Users, ChevronDown, ChevronUp, TrendingUp, Trophy, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import DidColleagueSessionsSection from "./DidColleagueSessionsSection";
import { supabase } from "@/integrations/supabase/client";

interface TaskSummary {
  total: number;
  done: number;
  inProgress: number;
  notStarted: number;
  avgAgeDays: number;
  streak: number;
  style: string;
}

const STYLE_LABELS: Record<string, string> = {
  praise: "🌟 Pochvaly",
  deadline: "⏰ Termíny",
  instruction: "📋 Instrukce",
  balanced: "⚖️ Vyvážený",
};

const DidColleagueView = ({ refreshTrigger }: { refreshTrigger: number }) => {
  const [expanded, setExpanded] = useState(false);
  const [hanka, setHanka] = useState<TaskSummary | null>(null);
  const [kata, setKata] = useState<TaskSummary | null>(null);

  useEffect(() => { load(); }, [refreshTrigger]);

  const load = async () => {
    const { data: tasks } = await supabase
      .from("did_therapist_tasks")
      .select("assigned_to, status_hanka, status_kata, created_at, status")
      .neq("status", "done");

    const { data: profiles } = await supabase
      .from("did_motivation_profiles")
      .select("therapist, streak_current, preferred_style");

    if (!tasks) return;
    const now = Date.now();

    const buildSummary = (who: "hanka" | "kata"): TaskSummary => {
      const relevant = tasks.filter(t => t.assigned_to === who || t.assigned_to === "both");
      const statusField = who === "hanka" ? "status_hanka" : "status_kata";
      const done = relevant.filter(t => t[statusField] === "done").length;
      const inProgress = relevant.filter(t => t[statusField] === "in_progress").length;
      const notStarted = relevant.filter(t => t[statusField] === "not_started").length;
      const ages = relevant.map(t => (now - new Date(t.created_at).getTime()) / (24 * 60 * 60 * 1000));
      const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
      const profile = profiles?.find(p => p.therapist === (who === "hanka" ? "Hanka" : "Káťa"));
      return {
        total: relevant.length,
        done,
        inProgress,
        notStarted,
        avgAgeDays: avgAge,
        streak: profile?.streak_current || 0,
        style: profile?.preferred_style || "balanced",
      };
    };

    setHanka(buildSummary("hanka"));
    setKata(buildSummary("kata"));
  };

  const renderBar = (s: TaskSummary) => {
    const total = Math.max(1, s.done + s.inProgress + s.notStarted);
    const doneW = Math.round((s.done / total) * 100);
    const progW = Math.round((s.inProgress / total) * 100);
    return (
      <div className="flex h-1.5 rounded-full overflow-hidden bg-muted/50 w-full">
        {doneW > 0 && <div className="bg-green-500 transition-all" style={{ width: `${doneW}%` }} />}
        {progW > 0 && <div className="bg-orange-400 transition-all" style={{ width: `${progW}%` }} />}
        <div className="bg-destructive/40 flex-1" />
      </div>
    );
  };

  const renderPerson = (name: string, s: TaskSummary | null) => {
    if (!s) return null;
    return (
      <div className="rounded-md border border-border/50 p-2 bg-background/50">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-medium text-foreground">{name}</span>
          <div className="flex items-center gap-1.5">
            {s.streak > 0 && (
              <Badge variant="secondary" className="text-[8px] h-4 px-1 gap-0.5">
                <Trophy className="w-2.5 h-2.5" />{s.streak}🔥
              </Badge>
            )}
            <span className="text-[8px] text-muted-foreground">{STYLE_LABELS[s.style]}</span>
          </div>
        </div>
        {renderBar(s)}
        <div className="flex items-center gap-2 mt-1.5 text-[9px] text-muted-foreground">
          <span className="text-green-600">✓ {s.done}</span>
          <span className="text-orange-500">◐ {s.inProgress}</span>
          <span className="text-destructive">○ {s.notStarted}</span>
          <span className="ml-auto flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />⌀ {s.avgAgeDays}d</span>
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 sm:p-4">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full text-left">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-primary" />
          Co dělá kolegyně
          {hanka && kata && (
            <Badge variant="secondary" className="text-[8px] h-4 px-1.5 ml-1">
              H: {hanka.done}/{hanka.total} · K: {kata.done}/{kata.total}
            </Badge>
          )}
        </h4>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {renderPerson("Hanka", hanka)}
          {renderPerson("Káťa", kata)}
          {hanka && kata && (hanka.done + kata.done) > 0 && (
            <div className="text-[9px] text-muted-foreground text-center pt-1 border-t border-border/30">
              <TrendingUp className="w-3 h-3 inline mr-0.5" />
              Celkem splněno: {hanka.done + kata.done} z {hanka.total + kata.total} úkolů
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DidColleagueView;
