import { useState, useEffect, useMemo } from "react";
import { Users, ChevronDown, ChevronUp, Activity, Shield, Zap, Heart, Brain, AlertTriangle, Moon, CheckCircle, Clock, Search } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelBadge } from "@/components/ui/KarelBadge";
import { KarelInput } from "@/components/ui/KarelInput";
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

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; label: string; variant: "success" | "default" | "warning" | "error" | "info" }> = {
  active: { icon: CheckCircle, label: "Aktivní", variant: "success" },
  sleeping: { icon: Moon, label: "Spí", variant: "default" },
  emerging: { icon: Zap, label: "Vynořující", variant: "info" },
  integrated: { icon: Heart, label: "Integrovaná", variant: "accent" as any },
  warning: { icon: AlertTriangle, label: "Varování", variant: "warning" },
};

const FILTERS = ["all", "active", "sleeping", "emerging", "integrated"] as const;
type FilterKey = (typeof FILTERS)[number];
const FILTER_LABELS: Record<FilterKey, string> = {
  all: "Všechny",
  active: "Aktivní",
  sleeping: "Spící",
  emerging: "Vynořující",
  integrated: "Integrovaná",
};

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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

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

  const filtered = useMemo(() => {
    let result = [...parts];
    
    // Status filter
    if (filter !== "all") {
      result = result.filter(p => p.status === filter);
    }
    
    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.part_name.toLowerCase().includes(q) ||
        p.display_name.toLowerCase().includes(q) ||
        (p.role_in_system || "").toLowerCase().includes(q)
      );
    }

    // Sort by status priority
    const order: Record<string, number> = { active: 0, warning: 1, emerging: 2, sleeping: 3, integrated: 4 };
    return result.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  }, [parts, filter, search]);

  if (loading && parts.length === 0) return null;
  if (parts.length === 0) return null;

  return (
    <div className="rounded-lg border border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-secondary))] p-3 sm:p-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between"
      >
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--text-tertiary))] flex items-center gap-1.5">
          <Users size={14} className="text-[hsl(var(--accent-primary))]" />
          Registr částí
          <span className="text-[10px] font-normal normal-case ml-1">
            ({stats.total} částí · {stats.active} aktivních · Ø {stats.avgHealth}%)
          </span>
        </h4>
        {expanded ? <ChevronUp size={14} className="text-[hsl(var(--text-disabled))]" /> : <ChevronDown size={14} className="text-[hsl(var(--text-disabled))]" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Search */}
          <KarelInput
            placeholder="Hledat část…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search size={14} />}
          />

          {/* Filter chips */}
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                  filter === f
                    ? "bg-[hsl(var(--accent-light))] text-[hsl(var(--accent-dark))] shadow-subtle"
                    : "text-[hsl(var(--text-tertiary))] hover:bg-[hsl(var(--surface-tertiary))]"
                }`}
              >
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>

          {/* Parts grid */}
          <div className="space-y-1.5">
            {filtered.map(part => {
              const cfg = STATUS_CONFIG[part.status] || STATUS_CONFIG.sleeping;
              const isExpanded = expandedPart === part.id;
              const emotionColor = EMOTION_COLORS[part.last_emotional_state || ""] || "text-[hsl(var(--text-disabled))]";

              return (
                <KarelCard
                  key={part.id}
                  variant="interactive"
                  padding="none"
                  className="overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedPart(isExpanded ? null : part.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                  >
                    {/* Emoji avatar */}
                    <div className="w-10 h-10 rounded-full bg-[hsl(var(--accent-light))] flex items-center justify-center shrink-0 text-lg">
                      {part.display_name?.charAt(0) || "?"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[hsl(var(--text-primary))] truncate">
                          {part.display_name || part.part_name}
                        </span>
                        {part.age_estimate && (
                          <span className="text-[10px] text-[hsl(var(--text-disabled))]">{part.age_estimate}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <KarelBadge variant={cfg.variant} size="sm" dot>
                          {cfg.label}
                        </KarelBadge>
                        <span className="text-[10px] text-[hsl(var(--text-disabled))] flex items-center gap-0.5">
                          <Clock size={10} />
                          {formatTimeAgo(part.last_seen_at)}
                        </span>
                      </div>
                    </div>
                    {/* Health bar */}
                    <div className="w-12 shrink-0">
                      <div className="w-full h-1.5 rounded-full bg-[hsl(var(--surface-tertiary))] overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            (part.health_score || 0) >= 80 ? "bg-green-500" :
                            (part.health_score || 0) >= 50 ? "bg-yellow-500" : "bg-red-500"
                          }`}
                          style={{ width: `${part.health_score || 0}%` }}
                        />
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp size={12} className="text-[hsl(var(--text-disabled))]" /> : <ChevronDown size={12} className="text-[hsl(var(--text-disabled))]" />}
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-1.5 border-t border-[hsl(var(--border-subtle))] pt-2 ml-[52px]">
                      {part.role_in_system && (
                        <p className="text-[10px] text-[hsl(var(--text-secondary))] flex items-center gap-1">
                          <Shield size={10} className="text-[hsl(var(--accent-primary))]" />
                          <span className="font-medium">Role:</span> {part.role_in_system}
                        </p>
                      )}
                      {part.last_emotional_state && (
                        <p className="text-[10px] text-[hsl(var(--text-secondary))] flex items-center gap-1">
                          <Heart size={10} className={emotionColor} />
                          <span className="font-medium">Emoce:</span> {part.last_emotional_state}
                          {part.last_emotional_intensity != null && (
                            <span className="ml-1">({part.last_emotional_intensity}/10)</span>
                          )}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-[10px] text-[hsl(var(--text-tertiary))]">
                        <span><Activity size={10} className="inline mr-0.5" />{part.total_episodes || 0} epizod</span>
                        <span>{part.total_threads || 0} vláken</span>
                        <span>Zdraví: {part.health_score || 0}%</span>
                        {part.drive_folder_label && (
                          <KarelBadge variant="default" size="sm">{part.drive_folder_label}</KarelBadge>
                        )}
                      </div>
                      {part.known_triggers && part.known_triggers.length > 0 && (
                        <div>
                          <p className="text-[10px] font-medium text-[hsl(var(--text-tertiary))] flex items-center gap-1">
                            <Zap size={10} className="text-yellow-500" /> Triggery
                          </p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {part.known_triggers.slice(0, 5).map(t => (
                              <KarelBadge key={t} variant="warning" size="sm">{t}</KarelBadge>
                            ))}
                          </div>
                        </div>
                      )}
                      {part.known_strengths && part.known_strengths.length > 0 && (
                        <div>
                          <p className="text-[10px] font-medium text-[hsl(var(--text-tertiary))] flex items-center gap-1">
                            <Shield size={10} className="text-green-500" /> Silné stránky
                          </p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {part.known_strengths.slice(0, 5).map(s => (
                              <KarelBadge key={s} variant="success" size="sm">{s}</KarelBadge>
                            ))}
                          </div>
                        </div>
                      )}
                      {onSelectPart && (
                        <button
                          onClick={() => onSelectPart(part.part_name)}
                          className="text-[10px] text-[hsl(var(--accent-primary))] hover:underline mt-1"
                        >
                          Otevřít vlákno →
                        </button>
                      )}
                    </div>
                  )}
                </KarelCard>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default DidRegistryOverview;
