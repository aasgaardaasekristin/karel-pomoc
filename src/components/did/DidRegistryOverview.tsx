import { useState, useEffect, useMemo } from "react";
import { Users, ChevronDown, ChevronUp, Activity, Shield, Zap, Heart, Brain, AlertTriangle, Moon, CheckCircle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";

interface RegistryPart {
  id: string;
  part_name: string;
  display_name: string;
  status: string;
  cluster: string | null;
  role_in_system: string | null;
  age_estimate: string | null;
  last_seen_at: string | null;
  last_emotional_state: string | null;
  last_emotional_intensity: number | null;
  health_score: number | null;
  total_episodes: number | null;
  total_threads: number | null;
  known_triggers: string[] | null;
  known_strengths: string[] | null;
  drive_folder_label: string | null;
}

interface Props {
  refreshTrigger: number;
  onSelectPart?: (partName: string) => void;
}

const STATUS_ICON = {
  active: { icon: CheckCircle, color: "text-green-500", bg: "bg-green-500/10", label: "Aktivní" },
  sleeping: { icon: Moon, color: "text-muted-foreground", bg: "bg-muted/30", label: "Spí" },
  warning: { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-500/10", label: "Varování" },
} as const;

const EMOTION_COLORS: Record<string, string> = {
  EMO_KLIDNA: "text-green-500",
  STABILNI: "text-green-500",
  EMO_SMUTNA: "text-blue-400",
  EMO_UPLAKANA: "text-blue-500",
  EMO_NASTVANA: "text-red-500",
  EMO_UZKOSTNA: "text-yellow-500",
  EMO_VYDESENA: "text-orange-500",
  EMO_ZMATENA: "text-purple-400",
};

const formatTimeAgo = (isoStr: string | null) => {
  if (!isoStr) return "nikdy";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "právě teď";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
};

const DidRegistryOverview = ({ refreshTrigger, onSelectPart }: Props) => {
  const [parts, setParts] = useState<RegistryPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [expandedPart, setExpandedPart] = useState<string | null>(null);

  useEffect(() => {
    loadRegistry();
  }, [refreshTrigger]);

  const loadRegistry = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("did_part_registry")
        .select("*")
        .order("last_seen_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      setParts((data as RegistryPart[]) || []);
    } catch (e) {
      console.error("Failed to load registry:", e);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    const active = parts.filter(p => p.status === "active").length;
    const sleeping = parts.filter(p => p.status === "sleeping").length;
    const warning = parts.filter(p => p.status === "warning").length;
    const avgHealth = parts.length > 0
      ? Math.round(parts.reduce((s, p) => s + (p.health_score || 0), 0) / parts.length)
      : 0;
    return { active, sleeping, warning, avgHealth, total: parts.length };
  }, [parts]);

  const sorted = useMemo(() => {
    const order: Record<string, number> = { active: 0, warning: 1, sleeping: 2 };
    return [...parts].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
  }, [parts]);

  // Group by cluster
  const clusters = useMemo(() => {
    const map = new Map<string, RegistryPart[]>();
    for (const p of sorted) {
      const key = p.cluster || "Nezařazeno";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [sorted]);

  if (loading && parts.length === 0) return null;
  if (parts.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 sm:p-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between"
      >
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-primary" />
          Registr částí
          <span className="text-[10px] text-muted-foreground ml-1">
            ({stats.total} částí • {stats.active} aktivních • Ø zdraví {stats.avgHealth}%)
          </span>
        </h4>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Cluster groups */}
          {Array.from(clusters.entries()).map(([cluster, clusterParts]) => (
            <div key={cluster}>
              {clusters.size > 1 && (
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                  <Brain className="w-2.5 h-2.5" />
                  {cluster}
                </p>
              )}
              <div className="space-y-1">
                {clusterParts.map(part => {
                  const statusCfg = STATUS_ICON[part.status as keyof typeof STATUS_ICON] || STATUS_ICON.sleeping;
                  const StatusIcon = statusCfg.icon;
                  const isExpanded = expandedPart === part.id;
                  const emotionColor = EMOTION_COLORS[part.last_emotional_state || ""] || "text-muted-foreground";

                  return (
                    <div key={part.id} className={`rounded-md border border-border/50 ${statusCfg.bg} transition-colors`}>
                      <button
                        onClick={() => setExpandedPart(isExpanded ? null : part.id)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
                      >
                        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${statusCfg.color}`} />
                        <span className="text-xs font-medium text-foreground flex-1 truncate">
                          {part.display_name || part.part_name}
                        </span>
                        {part.age_estimate && (
                          <span className="text-[9px] text-muted-foreground">{part.age_estimate}</span>
                        )}
                        {part.last_emotional_state && part.last_emotional_state !== "STABILNI" && (
                          <Heart className={`w-3 h-3 ${emotionColor}`} />
                        )}
                        {/* Health bar */}
                        <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              (part.health_score || 0) >= 80 ? "bg-green-500" :
                              (part.health_score || 0) >= 50 ? "bg-yellow-500" : "bg-red-500"
                            }`}
                            style={{ width: `${part.health_score || 0}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" />
                          {formatTimeAgo(part.last_seen_at)}
                        </span>
                        {isExpanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                      </button>

                      {isExpanded && (
                        <div className="px-2.5 pb-2 space-y-1.5 border-t border-border/30 pt-1.5">
                          {part.role_in_system && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Shield className="w-2.5 h-2.5 text-primary" />
                              <span className="font-medium">Role:</span> {part.role_in_system}
                            </p>
                          )}
                          {part.last_emotional_state && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Heart className={`w-2.5 h-2.5 ${emotionColor}`} />
                              <span className="font-medium">Emoce:</span> {part.last_emotional_state}
                              {part.last_emotional_intensity != null && (
                                <span className="ml-1">({part.last_emotional_intensity}/10)</span>
                              )}
                            </p>
                          )}
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span><Activity className="w-2.5 h-2.5 inline mr-0.5" />{part.total_episodes || 0} epizod</span>
                            <span>{part.total_threads || 0} vláken</span>
                            <span>Zdraví: {part.health_score || 0}%</span>
                            {part.drive_folder_label && (
                              <Badge variant="outline" className="text-[8px] h-3.5 px-1">{part.drive_folder_label}</Badge>
                            )}
                          </div>
                          {part.known_triggers && part.known_triggers.length > 0 && (
                            <div>
                              <p className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                                <Zap className="w-2.5 h-2.5 text-yellow-500" /> Triggery
                              </p>
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {part.known_triggers.slice(0, 5).map(t => (
                                  <Badge key={t} variant="secondary" className="text-[8px] h-4 px-1">{t}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {part.known_strengths && part.known_strengths.length > 0 && (
                            <div>
                              <p className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                                <Shield className="w-2.5 h-2.5 text-green-500" /> Silné stránky
                              </p>
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {part.known_strengths.slice(0, 5).map(s => (
                                  <Badge key={s} variant="outline" className="text-[8px] h-4 px-1 text-green-600 border-green-300">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {onSelectPart && (
                            <button
                              onClick={() => onSelectPart(part.part_name)}
                              className="text-[10px] text-primary hover:underline mt-1"
                            >
                              Otevřít vlákno →
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DidRegistryOverview;
