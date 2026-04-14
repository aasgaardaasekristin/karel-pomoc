import { useEffect, useState, useCallback } from "react";
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

  const refreshBriefs = useCallback(async () => {
    const { data, error } = await supabase
      .from("crisis_briefs")
      .select("*")
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(10);

    if (!error) {
      setBriefs((data ?? []) as unknown as DbCrisisBrief[]);
    }

    setLoading(false);
  }, []);

  // Single refresh contract: initial load + optional external refresh from the main crisis layer.
  useEffect(() => {
    void refreshBriefs();
  }, [refreshBriefs, refreshSignal]);

  // Separate notification layer is preserved, but polling is removed to avoid drift.
  // Briefs now refresh only from the shared refresh callback: external signal + realtime DB changes.
  useEffect(() => {
    const channel = supabase
      .channel("crisis-brief-panel")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisis_briefs" },
        () => {
          void refreshBriefs();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshBriefs]);

  const markAsRead = async (id: string) => {
    await supabase.from("crisis_briefs").update({ is_read: true }).eq("id", id);
    setExpandedId(null);
    void refreshBriefs();
  };

  const dismissAll = async () => {
    if (briefs.length > 0) {
      await supabase
        .from("crisis_briefs")
        .update({ is_read: true })
        .in("id", briefs.map((brief) => brief.id));
    }

    setExpandedId(null);
    void refreshBriefs();
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
