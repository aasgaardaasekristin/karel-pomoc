import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, Shield, Heart, Zap, Clock, CheckCircle2, Circle, Activity, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";

interface Props {
  partName: string;
  therapistName: string;
  onStartLiveSession: () => void;
  onContextLoaded?: (context: string) => void;
}

interface RegistryData {
  display_name: string;
  status: string;
  age_estimate: string | null;
  role_in_system: string | null;
  cluster: string | null;
  last_seen_at: string | null;
  last_emotional_state: string | null;
  last_emotional_intensity: number | null;
  health_score: number | null;
  total_episodes: number | null;
  total_threads: number | null;
  known_triggers: string[] | null;
  known_strengths: string[] | null;
  language: string | null;
  notes: string | null;
  drive_folder_label: string | null;
}

interface ThreadSummary {
  id: string;
  sub_mode: string;
  last_activity_at: string;
  messageCount: number;
}

interface TaskItem {
  id: string;
  task: string;
  assigned_to: string;
  status_hanka: string;
  status_kata: string;
  priority: string | null;
  due_date: string | null;
}

const formatTimeAgo = (isoStr: string | null) => {
  if (!isoStr) return "nikdy";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "právě teď";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
};

const DidPartCard = ({ partName, therapistName, onStartLiveSession, onContextLoaded }: Props) => {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [driveCardContent, setDriveCardContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Parallel: registry, threads, tasks, drive card
      const [regRes, threadRes, taskRes] = await Promise.all([
        supabase.from("did_part_registry").select("*").eq("part_name", partName).maybeSingle(),
        supabase.from("did_threads").select("id, sub_mode, last_activity_at, messages").eq("part_name", partName).order("last_activity_at", { ascending: false }).limit(5),
        supabase.from("did_therapist_tasks").select("id, task, assigned_to, status_hanka, status_kata, priority, due_date").neq("status", "done").order("created_at", { ascending: false }).limit(20),
      ]);

      if (regRes.data) setRegistry(regRes.data as unknown as RegistryData);

      if (threadRes.data) {
        setThreads(threadRes.data.map(t => ({
          id: t.id,
          sub_mode: t.sub_mode,
          last_activity_at: t.last_activity_at,
          messageCount: Array.isArray(t.messages) ? t.messages.length : 0,
        })));
      }

      // Filter tasks mentioning this part name
      const partLower = partName.toLowerCase();
      const relevantTasks = (taskRes.data || []).filter((t: any) =>
        t.task.toLowerCase().includes(partLower)
      );
      setTasks(relevantTasks.slice(0, 8) as TaskItem[]);

      // Load Drive card in background
      try {
        const headers = await getAuthHeaders();
        const driveRes = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
          { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${partName.replace(/\s+/g, "_")}`] }) }
        );
        if (driveRes.ok) {
          const data = await driveRes.json();
          const docs = data.documents || {};
          const content = Object.values(docs).filter(v => typeof v === "string" && !(v as string).startsWith("[Dokument")).join("\n\n");
          if (content) {
            setDriveCardContent(content);
            onContextLoaded?.(content);
          }
        }
      } catch {}
    } catch (e) {
      console.error("DidPartCard load error:", e);
    } finally {
      setIsLoading(false);
    }
  }, [partName]);

  useEffect(() => { loadData(); }, [loadData]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <div>
            <p className="text-sm font-medium text-foreground">Karel analyzuje kartu části</p>
            <p className="text-xs text-muted-foreground mt-1">Načítám registr, historii a kartotéku…</p>
          </div>
        </div>
      </div>
    );
  }

  const displayName = registry?.display_name || partName;
  const healthScore = registry?.health_score || 0;

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12 space-y-6">
        {/* Part header */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <span className="text-2xl">🧩</span>
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-serif font-semibold text-foreground">{displayName}</h2>
            <div className="flex items-center justify-center gap-3 mt-1 text-sm text-muted-foreground">
              {registry?.age_estimate && <span>{registry.age_estimate}</span>}
              {registry?.role_in_system && <span>• {registry.role_in_system}</span>}
              {registry?.cluster && <Badge variant="outline" className="text-[10px] h-5">{registry.cluster}</Badge>}
            </div>
          </div>
        </div>

        {/* Status strip */}
        {registry && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stav</h3>
              <Badge variant={registry.status === "active" ? "default" : "secondary"} className="text-[10px]">
                {registry.status === "active" ? "Aktivní" : registry.status === "warning" ? "Varování" : "Spí"}
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <Heart className="w-3 h-3 text-pink-500" />
                <span className="text-muted-foreground">Emoce:</span>
                <span className="font-medium">{registry.last_emotional_state || "—"}</span>
                {registry.last_emotional_intensity != null && <span className="text-muted-foreground">({registry.last_emotional_intensity}/10)</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <Activity className="w-3 h-3 text-primary" />
                <span className="text-muted-foreground">Epizody:</span>
                <span className="font-medium">{registry.total_episodes || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-muted-foreground">Kontakt:</span>
                <span className="font-medium">{formatTimeAgo(registry.last_seen_at)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <FileText className="w-3 h-3 text-muted-foreground" />
                <span className="text-muted-foreground">Zdraví:</span>
                <span className="font-medium">{healthScore}%</span>
              </div>
            </div>
          </div>
        )}

        {/* Triggers & Strengths */}
        {registry && ((registry.known_triggers?.length || 0) > 0 || (registry.known_strengths?.length || 0) > 0) && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            {registry.known_triggers && registry.known_triggers.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1.5">
                  <Zap className="w-3 h-3 text-yellow-500" /> Triggery
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {registry.known_triggers.map(t => (
                    <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                  ))}
                </div>
              </div>
            )}
            {registry.known_strengths && registry.known_strengths.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1.5">
                  <Shield className="w-3 h-3 text-green-500" /> Silné stránky
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {registry.known_strengths.map(s => (
                    <Badge key={s} variant="outline" className="text-[10px] text-green-600 border-green-300">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent threads */}
        {threads.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Poslední vlákna</h3>
            <div className="space-y-1.5">
              {threads.map(t => (
                <div key={t.id} className="flex items-center justify-between text-xs px-2 py-1.5 bg-muted/30 rounded-lg">
                  <span className="text-foreground font-medium">{t.sub_mode === "cast" ? "Rozhovor" : t.sub_mode === "mamka" ? "Hanka" : t.sub_mode === "kata" ? "Káťa" : t.sub_mode}</span>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>{t.messageCount} zpráv</span>
                    <span>{formatTimeAgo(t.last_activity_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tasks for this part */}
        {tasks.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Úkoly pro {partName}</h3>
            <div className="space-y-1.5">
              {tasks.map(t => {
                const isHanka = therapistName === "Hanka";
                const status = isHanka ? t.status_hanka : t.status_kata;
                const done = status === "done" || status === "confirmed";
                return (
                  <div key={t.id} className={`flex items-start gap-2 text-xs px-2 py-1.5 rounded-lg ${done ? "bg-primary/5" : "bg-muted/30"}`}>
                    {done ? <CheckCircle2 className="w-3 h-3 text-primary mt-0.5 shrink-0" /> : <Circle className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />}
                    <span className={`flex-1 ${done ? "text-muted-foreground line-through" : "text-foreground"}`}>{t.task}</span>
                    {t.priority === "high" && <Badge variant="destructive" className="text-[8px] h-4 px-1">!</Badge>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Notes from registry */}
        {registry?.notes && registry.notes.trim() && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Poznámky</h3>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{registry.notes}</p>
          </div>
        )}

        {/* Drive card excerpt */}
        {driveCardContent && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Kartotéka (Drive)</h3>
            <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
              {driveCardContent.slice(0, 1500)}{driveCardContent.length > 1500 ? "…" : ""}
            </p>
          </div>
        )}

        {/* Start button */}
        <div className="pt-2">
          <Button
            size="lg"
            onClick={onStartLiveSession}
            className="w-full h-14 text-base gap-3 rounded-xl shadow-sm"
          >
            <Play className="w-5 h-5" />
            Zahájit sezení s {displayName}
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Karel bude v reálném čase radit během sezení s touto částí.
          </p>
        </div>
      </div>
    </ScrollArea>
  );
};

export default DidPartCard;
