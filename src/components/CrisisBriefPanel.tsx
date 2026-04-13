import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ChevronRight, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { DbCrisisBrief } from "./crisis/types";
import CrisisSupervisionPanel from "./crisis/CrisisSupervisionPanel";

interface CrisisBriefPanelProps {
  /** Optional external refresh signal — when changed, forces re-fetch */
  refreshSignal?: number;
}

const CrisisBriefPanel: React.FC<CrisisBriefPanelProps> = ({ refreshSignal }) => {
  const [briefs, setBriefs] = useState<DbCrisisBrief[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastIdsRef = useRef<string>("");

  const loadBriefs = useCallback(async () => {
    const { data, error } = await supabase
      .from("crisis_briefs")
      .select("*")
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(10);

    if (!error && data) {
      const ids = data.map((d: any) => d.id).join(",");
      if (ids !== lastIdsRef.current) {
        lastIdsRef.current = ids;
        setBriefs(data as unknown as DbCrisisBrief[]);
      }
    }
    setLoading(false);
  }, []);

  // Initial load + react to external refresh signal
  useEffect(() => {
    loadBriefs();
  }, [loadBriefs, refreshSignal]);

  // Single polling interval — aligned with main crisis layer's ~30s cadence
  // This is the ONLY polling source for brief notifications.
  useEffect(() => {
    const interval = setInterval(loadBriefs, 30000);
    return () => clearInterval(interval);
  }, [loadBriefs]);

  const markAsRead = async (id: string) => {
    await supabase.from("crisis_briefs").update({ is_read: true }).eq("id", id);
    setBriefs(prev => prev.filter(b => b.id !== id));
    setExpandedId(null);
  };

  const dismissAll = async () => {
    for (const b of briefs) {
      await supabase.from("crisis_briefs").update({ is_read: true }).eq("id", b.id);
    }
    setBriefs([]);
    setExpandedId(null);
  };

  if (loading || briefs.length === 0) return null;

  const expanded = briefs.find(b => b.id === expandedId);

  // Full supervision panel
  if (expanded) {
    return (
      <CrisisSupervisionPanel
        brief={expanded}
        onMarkRead={markAsRead}
        onClose={() => setExpandedId(null)}
      />
    );
  }

  // Notification banner
  return (
    <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-destructive shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {briefs.length === 1
                ? "Krizový supervizní brief čeká na přečtení"
                : `${briefs.length} krizové briefy čekají na přečtení`}
            </p>
            <p className="text-xs text-muted-foreground">
              Nejnovější: {briefs[0].scenario} (risk: {briefs[0].risk_score}) – {new Date(briefs[0].created_at).toLocaleString("cs-CZ")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {briefs.length > 1 && (
            <Button variant="outline" size="sm" onClick={dismissAll} className="text-xs">
              <Check className="w-3 h-3 mr-1" />
              Vše přečteno
            </Button>
          )}
          <Button size="sm" onClick={() => setExpandedId(briefs[0].id)} className="text-xs">
            <ChevronRight className="w-3 h-3 mr-1" />
            Zobrazit brief
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CrisisBriefPanel;
