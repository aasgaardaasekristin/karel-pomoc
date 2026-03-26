import { useState, useEffect } from "react";
import { HeartPulse, Loader2, RefreshCw, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

interface HealthRecord {
  part_name: string;
  health_score: number;
  missing_sections: string[];
  stale_sections: string[];
  stub_sections: string[];
  filled_sections: number;
  total_sections: number;
  folder_label: string;
  last_checked: string;
}

interface Props {
  refreshTrigger: number;
}

const DidKartotekaHealth = ({ refreshTrigger }: Props) => {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(true);

  useEffect(() => {
    loadHealthData();
  }, [refreshTrigger]);

  const loadHealthData = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("did_kartoteka_health")
        .select("*")
        .order("health_score", { ascending: true });
      if (error) throw error;
      setRecords((data as any[]) || []);
    } catch (e) {
      console.error("Failed to load health data:", e);
    } finally {
      setLoading(false);
    }
  };

  const runAudit = async () => {
    setAuditing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-kartoteka-health`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(errText);
      }
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      await loadHealthData();
    } catch (e) {
      console.error("Audit failed:", e);
      toast.error("Audit kartotéky selhal");
    } finally {
      setAuditing(false);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-green-600 dark:text-green-400";
    if (score >= 50) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  const getScoreEmoji = (score: number) => {
    if (score >= 80) return "🟢";
    if (score >= 50) return "🟡";
    return "🔴";
  };

  const getProgressColor = (score: number) => {
    if (score >= 80) return "bg-green-500";
    if (score >= 50) return "bg-yellow-500";
    return "bg-red-500";
  };

  const activeCards = records.filter(r => r.folder_label === "AKTIVNÍ");
  const archiveCards = records.filter(r => r.folder_label === "ARCHIV");
  const avgScore = activeCards.length > 0
    ? Math.round(activeCards.reduce((sum, r) => sum + r.health_score, 0) / activeCards.length)
    : 0;
  const criticalCount = activeCards.filter(r => r.health_score < 50).length;

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 sm:p-4">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center justify-between"
      >
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <HeartPulse className="w-3.5 h-3.5 text-primary" />
          Zdraví kartotéky
          {records.length > 0 && (
            <span className="ml-1.5 text-[0.625rem] text-muted-foreground">
              {getScoreEmoji(avgScore)} Ø {avgScore}%
              {criticalCount > 0 && (
                <span className="text-red-500 ml-1">• {criticalCount} kritických</span>
              )}
            </span>
          )}
        </h4>
        {isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {!isCollapsed && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[0.625rem] text-muted-foreground">
              {records.length > 0
                ? `Poslední audit: ${new Date(records[0]?.last_checked).toLocaleString("cs-CZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                : "Zatím nebyl proveden žádný audit"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={runAudit}
              disabled={auditing}
              className="h-6 text-[0.625rem] px-2"
            >
              {auditing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              {auditing ? "Auditování..." : "Auditovat"}
            </Button>
          </div>

          {loading && records.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Načítám...
            </div>
          )}

          {/* Active cards */}
          {activeCards.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[0.625rem] font-medium text-muted-foreground uppercase tracking-wide">Aktivní karty</p>
              {activeCards.map(record => (
                <div key={record.part_name} className="rounded-md border border-border/50 bg-background/50">
                  <button
                    onClick={() => setExpandedCard(expandedCard === record.part_name ? null : record.part_name)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
                  >
                    <span className="text-[0.625rem]">{getScoreEmoji(record.health_score)}</span>
                    <span className="text-xs font-medium text-foreground flex-1 truncate">{record.part_name}</span>
                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${getProgressColor(record.health_score)}`}
                        style={{ width: `${record.health_score}%` }}
                      />
                    </div>
                    <span className={`text-[0.625rem] font-mono w-8 text-right ${getScoreColor(record.health_score)}`}>
                      {record.health_score}%
                    </span>
                    {expandedCard === record.part_name
                      ? <ChevronUp className="w-3 h-3 text-muted-foreground" />
                      : <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    }
                  </button>

                  {expandedCard === record.part_name && (
                    <div className="px-2.5 pb-2 space-y-1.5 border-t border-border/30">
                      <div className="pt-1.5 text-[0.625rem] text-muted-foreground">
                        {record.filled_sections}/{record.total_sections} sekcí vyplněno
                      </div>

                      {record.missing_sections.length > 0 && (
                        <div>
                          <p className="text-[0.625rem] font-medium text-red-500 flex items-center gap-1">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            Chybějící sekce ({record.missing_sections.length})
                          </p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {record.missing_sections.map(s => (
                              <Badge key={s} variant="destructive" className="text-[0.5rem] h-4 px-1">
                                {s.split(" – ")[0]}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {record.stub_sections.length > 0 && (
                        <div>
                          <p className="text-[0.625rem] font-medium text-yellow-600 dark:text-yellow-400">
                            Stub data ({record.stub_sections.length})
                          </p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {record.stub_sections.map(s => (
                              <Badge key={s} variant="secondary" className="text-[0.5rem] h-4 px-1">
                                {s.split(" – ")[0]}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {record.stale_sections.length > 0 && (
                        <div>
                          <p className="text-[0.625rem] font-medium text-orange-500">
                            Zastaralé ({record.stale_sections.length}) – starší 14 dní
                          </p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {record.stale_sections.map(s => (
                              <Badge key={s} variant="outline" className="text-[8px] h-4 px-1 text-orange-500 border-orange-300">
                                {s.split(" – ")[0]}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Archive summary */}
          {archiveCards.length > 0 && (
            <div className="mt-2">
              <p className="text-[0.625rem] text-muted-foreground">
                📦 {archiveCards.length} archivovaných karet (Ø {Math.round(archiveCards.reduce((s, r) => s + r.health_score, 0) / archiveCards.length)}%)
              </p>
            </div>
          )}

          {records.length === 0 && !loading && (
            <p className="text-[0.625rem] text-muted-foreground text-center py-2">
              Klikni „Auditovat" pro kontrolu integrity karet
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DidKartotekaHealth;
