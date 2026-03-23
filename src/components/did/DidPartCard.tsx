import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  Loader2, Play, Shield, Heart, Zap, Target, BookOpen, Lightbulb,
  Eye, Calendar, User, CheckCircle2, Circle, ArrowLeft, Sparkles,
  Activity, MessageSquare, Star, AlertTriangle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import RichMarkdown from "@/components/ui/RichMarkdown";

interface Props {
  partName: string;
  therapistName: string;
  onStartLiveSession: () => void;
  onContextLoaded?: (context: string) => void;
  onBack?: () => void;
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
}

interface SessionRecord {
  id: string;
  date: string;
  therapist: string;
  type: string;
  analysis: string;
  methods: string[];
  karelNotes: string;
  therapistFeedback: string;
  goals: { short: string[]; mid: string[]; long: string[] };
}

interface SummaryData {
  summary: Record<string, string>;
  rawSummary: string;
  registry: RegistryData | null;
  sessions: SessionRecord[];
  tasks: any[];
  threadCount: number;
}

const formatDate = (d: string | null) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("cs-CZ", { day: "numeric", month: "short", year: "numeric" });
};

const DidPartCard = ({ partName, therapistName, onStartLiveSession, onContextLoaded, onBack }: Props) => {
  const [data, setData] = useState<SummaryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-part-summary`,
        { method: "POST", headers, body: JSON.stringify({ partName }) }
      );
      if (!res.ok) {
        if (res.status === 429) { setError("Příliš mnoho požadavků, zkuste za chvíli."); return; }
        throw new Error(`HTTP ${res.status}`);
      }
      const result = await res.json();
      if (result.error) { setError(result.error); return; }
      setData(result);
      if (result.rawSummary) onContextLoaded?.(result.rawSummary);
    } catch (e: any) {
      console.error("DidPartCard load error:", e);
      setError(e.message || "Chyba při načítání");
    } finally {
      setIsLoading(false);
    }
  }, [partName]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <div>
            <p className="text-[13px] font-medium text-foreground">Karel připravuje klinickou kartu</p>
            <p className="text-[11px] text-muted-foreground mt-1">Analyzuji sezení, epizody, úkoly a kartotéku…</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-sm">
          <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
          <p className="text-[13px] text-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={loadSummary} className="text-[12px]">Zkusit znovu</Button>
        </div>
      </div>
    );
  }

  const reg = data?.registry;
  const summary = data?.summary || {};
  const sessions = data?.sessions || [];
  const tasks = data?.tasks || [];
  const displayName = reg?.display_name || partName;

  const statusLabel = reg?.status === "active" ? "Aktivní" : reg?.status === "warning" ? "Varování" : "Spí";
  const statusColor = reg?.status === "active" ? "text-emerald-600" : reg?.status === "warning" ? "text-amber-500" : "text-muted-foreground";

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-5">

        {/* Back button */}
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="text-[11px] text-muted-foreground/70 hover:text-foreground -ml-2">
            <ArrowLeft className="w-3 h-3 mr-1" /> Zpět na výběr
          </Button>
        )}

        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-xl bg-primary/8 flex items-center justify-center mx-auto">
            <span className="text-xl">🧩</span>
          </div>
          <h2 className="text-lg font-serif font-semibold text-foreground tracking-tight">{displayName}</h2>
          <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
            {reg?.age_estimate && <span>{reg.age_estimate}</span>}
            {reg?.role_in_system && <span>• {reg.role_in_system}</span>}
            <span className={`font-medium ${statusColor}`}>{statusLabel}</span>
            {reg?.cluster && <Badge variant="outline" className="text-[10px] h-4 px-1.5">{reg.cluster}</Badge>}
          </div>
          {reg && (
            <div className="flex items-center justify-center gap-4 text-[11px] text-muted-foreground/70 mt-1">
              <span className="flex items-center gap-1"><Heart className="w-3 h-3 text-pink-400" />{reg.last_emotional_state || "—"}{reg.last_emotional_intensity != null && ` (${reg.last_emotional_intensity}/10)`}</span>
              <span className="flex items-center gap-1"><Activity className="w-3 h-3" />{reg.total_episodes || 0} epizod</span>
              <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{data?.threadCount || 0} vláken</span>
            </div>
          )}
        </div>

        {/* Karel's Summary - THE KEY SECTION */}
        {summary["KARLOVO_SHRNUTÍ"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-primary/80 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" /> Karlovo shrnutí
            </h3>
            <div className="text-[13px] text-foreground/90 leading-relaxed">
              <RichMarkdown>{summary["KARLOVO_SHRNUTÍ"]}</RichMarkdown>
            </div>
          </div>
        )}

        {/* Last contact / session state */}
        {summary["POSLEDNI_KONTAKT"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Calendar className="w-3 h-3 text-primary/70" /> Poslední kontakt
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed">
              <RichMarkdown compact>{summary["POSLEDNI_KONTAKT"]}</RichMarkdown>
            </div>
          </div>
        )}

        {/* Therapeutic profile */}
        {summary["TERAPEUTICKÝ_PROFIL"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Eye className="w-3 h-3" /> Terapeutický profil
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed">
              <RichMarkdown compact>{summary["TERAPEUTICKÝ_PROFIL"]}</RichMarkdown>
            </div>
          </div>
        )}

        {/* Goals */}
        {summary["CÍLE"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Target className="w-3 h-3 text-primary" /> Cíle
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed">
              <RichMarkdown compact>{summary["CÍLE"]}</RichMarkdown>
            </div>
          </div>
        )}

        {/* Methods & approaches used */}
        {summary["METODY_A_PRISTUPY"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <BookOpen className="w-3 h-3 text-emerald-500" /> Metody a přístupy
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed">
              <RichMarkdown compact>{summary["METODY_A_PRISTUPY"]}</RichMarkdown>
            </div>
          </div>
        )}

        {/* Proposed new methods */}
        {summary["NAVRZENE_METODY"] && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Lightbulb className="w-3 h-3 text-amber-500" /> Navržené nové metody
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed prose prose-sm max-w-none">
              <ReactMarkdown>{summary["NAVRZENE_METODY"]}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Session history */}
        {sessions.length > 0 && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Calendar className="w-3 h-3" /> Historie sezení
            </h3>
            <Accordion type="single" collapsible value={expandedSession || ""} onValueChange={(v) => setExpandedSession(v || null)}>
              {sessions.map(s => (
                <AccordionItem key={s.id} value={s.id} className="border-b-0">
                  <AccordionTrigger className="py-2 text-[12px] hover:no-underline">
                    <div className="flex items-center gap-2 text-left">
                      <span className="font-medium text-foreground">{formatDate(s.date)}</span>
                      <span className="text-muted-foreground">•</span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <User className="w-3 h-3" /> {s.therapist}
                      </span>
                      {s.methods.length > 0 && (
                        <Badge variant="secondary" className="text-[9px] h-4 px-1">{s.methods.length} metod</Badge>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="text-[12px] space-y-2 pl-1">
                    {s.analysis && (
                      <div>
                        <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider mb-0.5">Karlova analýza</p>
                        <p className="text-foreground/85 leading-relaxed whitespace-pre-wrap">{s.analysis}</p>
                      </div>
                    )}
                    {s.karelNotes && (
                      <div>
                        <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider mb-0.5">Poznámky</p>
                        <p className="text-foreground/80 whitespace-pre-wrap">{s.karelNotes}</p>
                      </div>
                    )}
                    {s.therapistFeedback && (
                      <div>
                        <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider mb-0.5">Hodnocení terapeuta</p>
                        <p className="text-foreground/80 whitespace-pre-wrap">{s.therapistFeedback}</p>
                      </div>
                    )}
                    {s.methods.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {s.methods.map((m, i) => (
                          <Badge key={i} variant="outline" className="text-[10px] h-4 px-1.5">{m}</Badge>
                        ))}
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        )}

        {/* Active tasks */}
        {tasks.length > 0 && (
          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3 text-primary" /> Aktivní úkoly
            </h3>
            <div className="space-y-1">
              {tasks.slice(0, 8).map((t: any, i: number) => {
                const isHanka = therapistName === "Hanka" || therapistName === "Hanička";
                const status = isHanka ? t.status_hanka : t.status_kata;
                const done = status === "done" || status === "confirmed";
                return (
                  <div key={i} className={`flex items-start gap-2 text-[12px] px-2 py-1.5 rounded-lg ${done ? "bg-primary/5" : "bg-muted/20"}`}>
                    {done ? <CheckCircle2 className="w-3 h-3 text-primary mt-0.5 shrink-0" /> : <Circle className="w-3 h-3 text-muted-foreground/50 mt-0.5 shrink-0" />}
                    <span className={`flex-1 ${done ? "text-muted-foreground line-through" : "text-foreground/85"}`}>{t.task}</span>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0">{t.assigned_to}</span>
                    {t.priority === "high" && <Badge variant="destructive" className="text-[8px] h-3.5 px-1">!</Badge>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Karel's observations */}
        {summary["KARLOVY_POZNATKY"] && (
          <div className="bg-card border border-primary/10 rounded-xl p-4 space-y-2 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
            <h3 className="text-[11px] font-semibold text-primary/80 uppercase tracking-wider flex items-center gap-1.5">
              <Star className="w-3 h-3 text-primary" /> Karlovy poznatky
            </h3>
            <div className="text-[12px] text-foreground/85 leading-relaxed prose prose-sm max-w-none">
              <ReactMarkdown>{summary["KARLOVY_POZNATKY"]}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Triggers & Strengths compact */}
        {reg && ((reg.known_triggers?.length || 0) > 0 || (reg.known_strengths?.length || 0) > 0) && (
          <div className="flex gap-3">
            {reg.known_triggers && reg.known_triggers.length > 0 && (
              <div className="flex-1 bg-card border border-border/60 rounded-xl p-3 space-y-1.5">
                <h4 className="text-[10px] text-muted-foreground/70 uppercase tracking-wider flex items-center gap-1">
                  <Zap className="w-3 h-3 text-amber-400" /> Triggery
                </h4>
                <div className="flex flex-wrap gap-1">
                  {reg.known_triggers.map(t => (
                    <Badge key={t} variant="secondary" className="text-[10px] h-4 px-1.5">{t}</Badge>
                  ))}
                </div>
              </div>
            )}
            {reg.known_strengths && reg.known_strengths.length > 0 && (
              <div className="flex-1 bg-card border border-border/60 rounded-xl p-3 space-y-1.5">
                <h4 className="text-[10px] text-muted-foreground/70 uppercase tracking-wider flex items-center gap-1">
                  <Shield className="w-3 h-3 text-emerald-500" /> Silné stránky
                </h4>
                <div className="flex flex-wrap gap-1">
                  {reg.known_strengths.map(s => (
                    <Badge key={s} variant="outline" className="text-[10px] h-4 px-1.5 text-emerald-600 border-emerald-200">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Start session button */}
        <div className="pt-2">
          <Button
            size="lg"
            onClick={onStartLiveSession}
            className="w-full h-12 text-[14px] gap-2.5 rounded-xl shadow-sm"
          >
            <Play className="w-4 h-4" />
            Zahájit sezení s {displayName}
          </Button>
          <p className="text-[11px] text-muted-foreground/70 text-center mt-2">
            Karel bude v reálném čase radit, analyzovat a vést sezení na míru.
          </p>
        </div>
      </div>
    </ScrollArea>
  );
};

export default DidPartCard;
