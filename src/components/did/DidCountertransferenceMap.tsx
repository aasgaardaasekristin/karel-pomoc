import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Heart, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

interface Bond {
  id: string;
  therapist: string;
  part_name: string;
  bond_type: string;
  bond_description: string | null;
  therapeutic_implication: string | null;
  intensity: number;
  last_observed_at: string | null;
}

const BOND_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  mateřský: { bg: "bg-pink-500/15", text: "text-pink-600 dark:text-pink-400", border: "border-pink-500/30" },
  nostalgický: { bg: "bg-amber-500/15", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/30" },
  protektivní: { bg: "bg-blue-500/15", text: "text-blue-600 dark:text-blue-400", border: "border-blue-500/30" },
  empatický: { bg: "bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/30" },
  ochranitelský: { bg: "bg-violet-500/15", text: "text-violet-600 dark:text-violet-400", border: "border-violet-500/30" },
  neutrální: { bg: "bg-muted/50", text: "text-muted-foreground", border: "border-border" },
  obdivný: { bg: "bg-yellow-500/15", text: "text-yellow-600 dark:text-yellow-400", border: "border-yellow-500/30" },
  úzkostný: { bg: "bg-red-500/15", text: "text-red-600 dark:text-red-400", border: "border-red-500/30" },
  mentorský: { bg: "bg-cyan-500/15", text: "text-cyan-600 dark:text-cyan-400", border: "border-cyan-500/30" },
};

const getColorForBond = (bondType: string) => {
  const key = Object.keys(BOND_COLORS).find(k => bondType.toLowerCase().includes(k));
  return key ? BOND_COLORS[key] : BOND_COLORS.neutrální;
};

const intensityDots = (intensity: number) => {
  return Array.from({ length: 5 }, (_, i) => (
    <span key={i} className={`inline-block w-1.5 h-1.5 rounded-full ${i < intensity ? "bg-primary" : "bg-muted"}`} />
  ));
};

const DidCountertransferenceMap = ({ refreshTrigger = 0 }: { refreshTrigger?: number }) => {
  const [bonds, setBonds] = useState<Bond[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);

  useEffect(() => { loadBonds(); }, []);
  useEffect(() => { if (refreshTrigger > 0) loadBonds(); }, [refreshTrigger]);

  const loadBonds = async () => {
    const { data } = await supabase
      .from("did_countertransference_bonds")
      .select("*")
      .order("intensity", { ascending: false });
    if (data) setBonds(data as Bond[]);
    setLoading(false);
  };

  const handleExtract = async () => {
    setExtracting(true);
    toast.info("Karel analyzuje citové vazby terapeutek...");
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-context-prime`,
        { method: "POST", headers, body: JSON.stringify({ forceRefresh: true, extractBonds: true }) }
      );
      if (resp.ok) {
        toast.success("Countertransference mapa aktualizována.");
        loadBonds();
      } else {
        toast.error("Nepodařilo se extrahovat vazby.");
      }
    } catch {
      toast.error("Chyba při analýze vazeb.");
    } finally {
      setExtracting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hankaB = bonds.filter(b => b.therapist.toLowerCase().includes("hank"));
  const kataB = bonds.filter(b => b.therapist.toLowerCase().includes("kát") || b.therapist.toLowerCase().includes("kat"));

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Heart className="w-3.5 h-3.5 text-pink-500" />
          Countertransference mapa
        </h4>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExtract}
          disabled={extracting}
          className="h-6 text-[10px] px-2"
        >
          {extracting ? (
            <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Analyzuji...</>
          ) : (
            <><RefreshCw className="w-3 h-3 mr-1" /> Aktualizovat</>
          )}
        </Button>
      </div>

      {bonds.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          Zatím žádné zaznamenané vazby. Klikni „Aktualizovat" pro analýzu.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Hanka column */}
          <div>
            <p className="text-[10px] font-semibold text-foreground mb-2 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-pink-500 inline-block" />
              Hanka
            </p>
            <div className="space-y-1.5">
              {hankaB.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">Žádné vazby</p>
              ) : hankaB.map(b => <BondCard key={b.id} bond={b} />)}
            </div>
          </div>

          {/* Káťa column */}
          <div>
            <p className="text-[10px] font-semibold text-foreground mb-2 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-cyan-500 inline-block" />
              Káťa
            </p>
            <div className="space-y-1.5">
              {kataB.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">Žádné vazby</p>
              ) : kataB.map(b => <BondCard key={b.id} bond={b} />)}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      {bonds.length > 0 && (
        <div className="pt-2 border-t border-border/50">
          <p className="text-[9px] text-muted-foreground mb-1">Typy vazeb:</p>
          <div className="flex flex-wrap gap-1">
            {[...new Set(bonds.map(b => b.bond_type))].map(type => {
              const c = getColorForBond(type);
              return (
                <Badge key={type} variant="outline" className={`text-[8px] px-1.5 py-0 ${c.bg} ${c.text} ${c.border}`}>
                  {type}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const BondCard = ({ bond }: { bond: Bond }) => {
  const c = getColorForBond(bond.bond_type);
  return (
    <div className={`rounded-md border p-2 ${c.bg} ${c.border}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-medium ${c.text}`}>{bond.part_name}</span>
        <div className="flex items-center gap-0.5">{intensityDots(bond.intensity)}</div>
      </div>
      <Badge variant="outline" className={`text-[8px] px-1 py-0 mt-0.5 ${c.text} ${c.border}`}>
        {bond.bond_type}
      </Badge>
      {bond.bond_description && (
        <p className="text-[9px] text-muted-foreground mt-1 leading-relaxed">{bond.bond_description}</p>
      )}
      {bond.therapeutic_implication && (
        <p className="text-[9px] text-foreground/70 mt-0.5 italic">⚠ {bond.therapeutic_implication}</p>
      )}
    </div>
  );
};

export default DidCountertransferenceMap;
