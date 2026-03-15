import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, UserPlus, Loader2, CheckCircle, Moon, AlertTriangle, Clock, Heart } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface RegistryPart {
  id: string;
  part_name: string;
  display_name: string;
  status: string;
  age_estimate: string | null;
  last_seen_at: string | null;
  last_emotional_state: string | null;
  last_emotional_intensity: number | null;
  health_score: number | null;
  role_in_system: string | null;
}

interface Props {
  therapistName: string;
  knownParts: string[];
  onSelectPart: (partName: string) => void;
  onBack: () => void;
}

const STATUS_CFG: Record<string, { icon: typeof CheckCircle; color: string; bg: string }> = {
  active: { icon: CheckCircle, color: "text-green-500", bg: "bg-green-500/10" },
  sleeping: { icon: Moon, color: "text-muted-foreground", bg: "bg-muted/30" },
  warning: { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-500/10" },
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

const DidPartSelector = ({ therapistName, knownParts, onSelectPart, onBack }: Props) => {
  const [registryParts, setRegistryParts] = useState<RegistryPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [newPartName, setNewPartName] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("did_part_registry")
        .select("id, part_name, display_name, status, age_estimate, last_seen_at, last_emotional_state, last_emotional_intensity, health_score, role_in_system")
        .order("last_seen_at", { ascending: false, nullsFirst: false });
      setRegistryParts((data as RegistryPart[]) || []);
      setLoading(false);
    };
    load();
  }, []);

  const filtered = registryParts.filter(p => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return p.display_name.toLowerCase().includes(s) || p.part_name.toLowerCase().includes(s);
  });

  // Merge knownParts not in registry
  const registryNames = new Set(registryParts.map(p => p.part_name.toLowerCase()));
  const extraParts = knownParts.filter(n => !registryNames.has(n.toLowerCase()));

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-xl mx-auto px-4 py-8 sm:py-12 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-xl sm:text-2xl font-serif font-semibold text-foreground">
            Live DID sezení
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {therapistName}, vyber část se kterou teď pracuješ. Karel ti bude radit v reálném čase.
          </p>
        </div>

        {/* Search */}
        {registryParts.length > 3 && (
          <Input
            placeholder="Hledat část..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-10 text-sm"
          />
        )}

        {/* Registry parts */}
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(part => {
              const cfg = STATUS_CFG[part.status] || STATUS_CFG.sleeping;
              const StatusIcon = cfg.icon;
              return (
                <button
                  key={part.id}
                  onClick={() => onSelectPart(part.part_name)}
                  className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left group`}
                >
                  <div className={`w-10 h-10 rounded-full ${cfg.bg} flex items-center justify-center shrink-0`}>
                    <StatusIcon className={`w-4 h-4 ${cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{part.display_name || part.part_name}</span>
                      {part.age_estimate && (
                        <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">{part.age_estimate}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {part.role_in_system && <span className="truncate">{part.role_in_system}</span>}
                      <span className="flex items-center gap-0.5 shrink-0">
                        <Clock className="w-2.5 h-2.5" /> {formatTimeAgo(part.last_seen_at)}
                      </span>
                      {part.health_score != null && (
                        <span className="shrink-0">
                          {part.health_score}%
                        </span>
                      )}
                    </div>
                  </div>
                  {part.last_emotional_state && part.last_emotional_state !== "STABILNI" && (
                    <Heart className="w-4 h-4 text-yellow-500 shrink-0" />
                  )}
                </button>
              );
            })}

            {/* Extra known parts not in registry */}
            {extraParts.filter(n => !search.trim() || n.toLowerCase().includes(search.toLowerCase())).map(name => (
              <button
                key={name}
                onClick={() => onSelectPart(name)}
                className="w-full flex items-center gap-3 p-4 rounded-xl border-2 border-dashed border-border bg-card/50 hover:border-primary/50 hover:bg-card/80 transition-all text-left"
              >
                <div className="w-10 h-10 rounded-full bg-muted/30 flex items-center justify-center shrink-0">
                  <span className="text-sm font-medium text-muted-foreground">{name[0]}</span>
                </div>
                <div>
                  <span className="font-medium text-foreground">{name}</span>
                  <p className="text-xs text-muted-foreground">Není v registru</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* New part input */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-3 text-muted-foreground">nebo nová část</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Jméno nové části..."
              value={newPartName}
              onChange={e => setNewPartName(e.target.value)}
              className="h-10 text-sm flex-1"
              onKeyDown={e => {
                if (e.key === "Enter" && newPartName.trim()) {
                  onSelectPart(newPartName.trim());
                }
              }}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0"
              onClick={() => newPartName.trim() && onSelectPart(newPartName.trim())}
              disabled={!newPartName.trim()}
            >
              <UserPlus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
          ← Zpět
        </Button>
      </div>
    </ScrollArea>
  );
};

export default DidPartSelector;
