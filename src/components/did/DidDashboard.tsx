import { useState, useEffect } from "react";
import { Clock, AlertTriangle, CheckCircle, Moon, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface PartActivity {
  name: string;
  lastSeen: string | null;
  status: "active" | "sleeping" | "warning";
}

interface Props {
  onManualUpdate: () => void;
  isUpdating: boolean;
}

const DidDashboard = ({ onManualUpdate, isUpdating }: Props) => {
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [lastCycleTime, setLastCycleTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Get all unique part names from threads
      const { data: threads } = await supabase
        .from("did_threads")
        .select("part_name, last_activity_at")
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false });

      if (threads) {
        const partMap = new Map<string, string>();
        for (const t of threads) {
          if (!partMap.has(t.part_name)) {
            partMap.set(t.part_name, t.last_activity_at);
          }
        }

        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        const oneDay = 24 * 60 * 60 * 1000;

        const partList: PartActivity[] = Array.from(partMap.entries()).map(([name, lastSeen]) => {
          const diff = now - new Date(lastSeen).getTime();
          let status: PartActivity["status"] = "sleeping";
          if (diff < oneDay) status = "active";
          else if (diff > sevenDays) status = "warning";
          return { name, lastSeen, status };
        });

        setParts(partList);
      }

      // Get last update cycle
      const { data: cycles } = await supabase
        .from("did_update_cycles")
        .select("completed_at")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1);

      if (cycles && cycles.length > 0) {
        setLastCycleTime(cycles[0].completed_at);
      }
    } finally {
      setLoading(false);
    }
  };

  const formatTimeAgo = (isoStr: string | null) => {
    if (!isoStr) return "nikdy";
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "právě teď";
    if (mins < 60) return `před ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `před ${hours} h`;
    const days = Math.floor(hours / 24);
    return `před ${days} dny`;
  };

  const statusIcon = (status: PartActivity["status"]) => {
    switch (status) {
      case "active": return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "sleeping": return <Moon className="w-4 h-4 text-muted-foreground" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    }
  };

  const statusLabel = (status: PartActivity["status"]) => {
    switch (status) {
      case "active": return "aktivní";
      case "sleeping": return "spí";
      case "warning": return "⚠️ neaktivní 7+ dní";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4">
      {/* Header with last update indicator */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Přehled systému</h3>
          <p className="text-[10px] sm:text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3" />
            Poslední aktualizace kartotéky: {formatTimeAgo(lastCycleTime)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onManualUpdate}
          disabled={isUpdating}
          className="h-8 text-xs gap-1.5"
        >
          {isUpdating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Aktualizovat nyní
        </Button>
      </div>

      {/* Parts overview */}
      {parts.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {parts.map((part) => (
            <div
              key={part.name}
              className={`rounded-lg border p-3 ${
                part.status === "warning"
                  ? "border-yellow-500/50 bg-yellow-500/5"
                  : part.status === "active"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-border bg-card/50"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {statusIcon(part.status)}
                <span className="text-sm font-medium text-foreground truncate">{part.name}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {statusLabel(part.status)} • {formatTimeAgo(part.lastSeen)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-4 text-xs text-muted-foreground text-center">
          Zatím žádné záznamy o částech. Data se naplní po prvních rozhovorech.
        </div>
      )}

      {/* Warnings */}
      {parts.filter(p => p.status === "warning").length > 0 && (
        <div className="mt-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 mb-1">
            <AlertTriangle className="w-4 h-4" />
            Upozornění na neaktivní části
          </div>
          <p className="text-xs text-muted-foreground">
            {parts.filter(p => p.status === "warning").map(p => p.name).join(", ")} – neaktivní více než 7 dní. Zvažte oslovení.
          </p>
        </div>
      )}
    </div>
  );
};

export default DidDashboard;
