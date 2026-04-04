import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KarelCard } from "@/components/ui/KarelCard";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, UserRound } from "lucide-react";

interface TherapistProfile {
  id: string;
  therapist_name: string;
  strengths: string[] | null;
  preferred_methods: string[] | null;
  preferred_part_types: string[] | null;
  communication_style: string | null;
  experience_areas: string[] | null;
  limitations: string[] | null;
  workload_capacity: string | null;
  raw_analysis: string | null;
  last_updated: string | null;
}

const capacityConfig: Record<string, { label: string; emoji: string; className: string }> = {
  normal: { label: "Normální", emoji: "🟢", className: "bg-green-500/20 text-green-700 dark:text-green-400" },
  high:   { label: "Vysoká",   emoji: "🔵", className: "bg-blue-500/20 text-blue-700 dark:text-blue-400" },
  low:    { label: "Snížená",  emoji: "🟡", className: "bg-amber-500/20 text-amber-700 dark:text-amber-400" },
};

const DidTherapistProfiles = () => {
  const [profiles, setProfiles] = useState<TherapistProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const sb = supabase as any;
      const { data } = await sb.from("therapist_profiles").select("*").order("therapist_name");
      setProfiles(data || []);
      setLoading(false);
    };
    load();
  }, []);

  if (loading) return null;
  if (profiles.length === 0) return null;

  return (
    <KarelCard variant="outlined" padding="md">
      <div className="flex items-center gap-2 mb-3">
        <UserRound size={16} className="text-primary" />
        <span className="text-sm font-medium">👩‍⚕️ Profily terapeutek</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {profiles.map((tp) => {
          const cap = capacityConfig[tp.workload_capacity || "normal"] || capacityConfig.normal;
          const isExpanded = expandedId === tp.id;
          const displayName = tp.therapist_name === "hanka" ? "Hanka" : tp.therapist_name === "kata" ? "Káťa" : tp.therapist_name;

          return (
            <div
              key={tp.id}
              className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-2"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{displayName}</span>
                  <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full", cap.className)}>
                    {cap.emoji} {cap.label}
                  </span>
                </div>
                {tp.last_updated && (
                  <span className="text-[9px] text-muted-foreground">
                    {new Date(tp.last_updated).toLocaleDateString("cs")}
                  </span>
                )}
              </div>

              {/* Strengths */}
              {tp.strengths && tp.strengths.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tp.strengths.map((s, i) => (
                    <Badge key={i} variant="secondary" className="text-[9px] bg-green-500/10 text-green-700 dark:text-green-400 border-0">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Methods */}
              {tp.preferred_methods && tp.preferred_methods.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tp.preferred_methods.map((m, i) => (
                    <Badge key={i} variant="secondary" className="text-[9px] bg-blue-500/10 text-blue-700 dark:text-blue-400 border-0">
                      {m}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Part types */}
              {tp.preferred_part_types && tp.preferred_part_types.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tp.preferred_part_types.map((t, i) => (
                    <Badge key={i} variant="secondary" className="text-[9px] bg-purple-500/10 text-purple-700 dark:text-purple-400 border-0">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Communication style */}
              {tp.communication_style && (
                <p className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">Styl:</span> {tp.communication_style}
                </p>
              )}

              {/* Limitations */}
              {tp.limitations && tp.limitations.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tp.limitations.map((l, i) => (
                    <Badge key={i} variant="secondary" className="text-[9px] bg-muted text-muted-foreground border-0">
                      {l}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Expandable raw analysis */}
              {tp.raw_analysis && (
                <div>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : tp.id)}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    Celkové shrnutí
                  </button>
                  {isExpanded && (
                    <p className="text-[10px] text-muted-foreground mt-1 pl-2 border-l-2 border-border">
                      {tp.raw_analysis}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </KarelCard>
  );
};

export default DidTherapistProfiles;