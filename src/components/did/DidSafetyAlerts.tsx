import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const SEVERITY_ICONS: Record<string, string> = {
  critical: "🚨", high: "⚠️", medium: "🟡", low: "ℹ️",
};
const STATUS_LABELS: Record<string, string> = {
  new: "🔴 Nový", acknowledged: "🟡 Potvrzený", resolved: "🟢 Vyřešený", false_positive: "⚪ Falešný",
};
const ALERT_TYPE_LABELS: Record<string, string> = {
  suicidal_ideation: "Suicidální myšlenky", self_harm: "Sebepoškozování",
  dissociative_crisis: "Disociativní krize", severe_distress: "Těžká úzkost",
  aggressive_outburst: "Agresivní výbuch", reality_loss: "Ztráta reality",
  substance_mention: "Zmínka o substancích", abuse_disclosure: "Odhalení násilí",
  runaway_intent: "Úmysl utéct", other_risk: "Jiné riziko",
};

interface SafetyAlert {
  id: string;
  part_name: string | null;
  alert_type: string;
  severity: string;
  status: string;
  description: string | null;
  message_content: string | null;
  recommended_action: string | null;
  resolution_note: string | null;
  notification_sent: boolean;
  created_at: string;
  acknowledged_by: string | null;
}

const DidSafetyAlerts = () => {
  const [alerts, setAlerts] = useState<SafetyAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("new");

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    let query = (supabase as any)
      .from("safety_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (filterStatus !== "__all__") {
      query = query.eq("status", filterStatus);
    }
    const { data } = await query;
    setAlerts(data || []);
    setLoading(false);
  }, [filterStatus]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  const acknowledgeAlert = async (id: string) => {
    await (supabase as any).from("safety_alerts").update({
      status: "acknowledged", acknowledged_by: "hanka", acknowledged_at: new Date().toISOString(),
    }).eq("id", id);
    loadAlerts();
    toast.success("Alert potvrzen");
  };

  const resolveAlert = async (id: string, note: string) => {
    await (supabase as any).from("safety_alerts").update({
      status: "resolved", resolution_note: note || "Vyřešeno", resolved_at: new Date().toISOString(),
    }).eq("id", id);
    loadAlerts();
    toast.success("Alert vyřešen");
  };

  const markFalsePositive = async (id: string) => {
    await (supabase as any).from("safety_alerts").update({
      status: "false_positive", resolution_note: "Falešný poplach", resolved_at: new Date().toISOString(),
    }).eq("id", id);
    loadAlerts();
    toast.info("Označeno jako falešný poplach");
  };

  const newCount = alerts.filter(a => a.status === "new").length;
  const ackCount = alerts.filter(a => a.status === "acknowledged").length;
  const resolvedCount = alerts.filter(a => a.status === "resolved").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-7 text-xs w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">🔴 Nové</SelectItem>
            <SelectItem value="acknowledged">🟡 Potvrzené</SelectItem>
            <SelectItem value="resolved">🟢 Vyřešené</SelectItem>
            <SelectItem value="false_positive">⚪ Falešné</SelectItem>
            <SelectItem value="__all__">Všechny</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={loadAlerts}>🔄</Button>
      </div>

      <div className="flex gap-3 text-xs text-muted-foreground">
        <span className={newCount > 0 ? "text-red-500 font-bold" : ""}>🔴 {newCount} nových</span>
        <span>🟡 {ackCount} potvrzených</span>
        <span>🟢 {resolvedCount} vyřešených</span>
      </div>

      {loading && <p className="text-xs text-muted-foreground text-center py-4">Načítám...</p>}

      {!loading && alerts.map(alert => (
        <div key={alert.id} className={`border rounded-lg p-3 space-y-2 ${
          alert.severity === "critical" ? "border-red-500 bg-red-50/50 dark:bg-red-950/20" :
          alert.severity === "high" ? "border-amber-500 bg-amber-50/50 dark:bg-amber-950/20" :
          "border-border"
        }`}>
          <div className="flex justify-between items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs flex-wrap">
                <Badge variant={alert.severity === "critical" ? "destructive" : "outline"} className="text-[9px] h-4">
                  {SEVERITY_ICONS[alert.severity]} {alert.severity.toUpperCase()}
                </Badge>
                <span className="font-medium">{ALERT_TYPE_LABELS[alert.alert_type] || alert.alert_type}</span>
                <span className="text-muted-foreground">— {alert.part_name || "?"}</span>
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                <span>{new Date(alert.created_at).toLocaleString("cs")}</span>
                {alert.notification_sent && <span className="text-blue-500">📧 odesláno</span>}
              </div>
            </div>
            <Badge variant="outline" className="text-[9px] h-4 shrink-0">
              {STATUS_LABELS[alert.status] || alert.status}
            </Badge>
          </div>

          {alert.message_content && (
            <p className="text-xs italic text-muted-foreground bg-muted/50 rounded p-2 line-clamp-3">
              "{alert.message_content.slice(0, 200)}{alert.message_content.length > 200 ? "..." : ""}"
            </p>
          )}

          {alert.description && (
            <p className="text-xs text-muted-foreground">{alert.description}</p>
          )}

          {alert.recommended_action && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">💡 {alert.recommended_action}</p>
          )}

          {alert.resolution_note && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">✅ {alert.resolution_note}</p>
          )}

          <div className="flex gap-1 flex-wrap">
            {alert.status === "new" && (
              <>
                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => acknowledgeAlert(alert.id)}>👁️ Potvrdit</Button>
                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => resolveAlert(alert.id, "")}>✅ Vyřešit</Button>
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => markFalsePositive(alert.id)}>⚪ Falešný</Button>
              </>
            )}
            {alert.status === "acknowledged" && (
              <>
                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => {
                  const note = prompt("Poznámka k vyřešení:");
                  if (note !== null) resolveAlert(alert.id, note);
                }}>✅ Vyřešit</Button>
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => markFalsePositive(alert.id)}>⚪ Falešný</Button>
              </>
            )}
          </div>
        </div>
      ))}

      {!loading && alerts.length === 0 && (
        <div className="text-center py-6">
          <p className="text-2xl mb-1">🛡️</p>
          <p className="text-xs text-muted-foreground">
            {filterStatus === "new" ? "Žádné nové bezpečnostní alerty. Vše OK." : "Žádné alerty pro vybraný filtr."}
          </p>
        </div>
      )}
    </div>
  );
};

export default DidSafetyAlerts;
