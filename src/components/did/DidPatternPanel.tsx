import { useState, useEffect } from "react";
import { Brain, AlertTriangle, TrendingUp, Loader2, Info, Eye, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAuthHeaders } from "@/lib/auth";

interface Pattern {
  type: string;
  description: string;
  parts_involved: string[];
  severity: "info" | "watch" | "concern";
}

interface Alert {
  message: string;
  severity: "info" | "warning" | "critical";
  parts: string[];
}

interface PatternData {
  patterns: Pattern[];
  alerts: Alert[];
  positive_trends: string[];
  summary: string;
}

const SEVERITY_STYLES = {
  info: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-600", icon: Info },
  watch: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-600", icon: Eye },
  concern: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-600", icon: ShieldAlert },
  warning: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-600", icon: AlertTriangle },
  critical: { bg: "bg-red-500/10", border: "border-red-500/40", text: "text-red-600", icon: ShieldAlert },
};

const TYPE_LABELS: Record<string, string> = {
  recurring_theme: "Opakující se téma",
  emotional_pattern: "Emoční vzorec",
  behavioral_pattern: "Behaviorální vzorec",
  communication_pattern: "Komunikační vzorec",
};

const DidPatternPanel = () => {
  const [data, setData] = useState<PatternData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPatterns = async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-patterns`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!response.ok) throw new Error("Nepodařilo se analyzovat vzorce");
      const result = await response.json();
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neznámá chyba");
    } finally {
      setLoading(false);
    }
  };

  if (!data && !loading) {
    return (
      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={fetchPatterns}
          className="h-8 text-xs gap-1.5 w-full"
        >
          <Brain className="w-3.5 h-3.5" />
          Analyzovat vzorce systému (30 dní)
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mt-4 flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
        <Loader2 className="w-4 h-4 animate-spin" />
        Analyzuji vzorce za posledních 30 dní...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        {error}
        <Button variant="ghost" size="sm" onClick={fetchPatterns} className="ml-2 h-6 text-[0.625rem]">
          Zkusit znovu
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="mt-4 space-y-3">
      {/* Summary */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
          <Brain className="w-4 h-4 text-primary" />
          Analýza vzorců
        </div>
        <p className="text-xs text-muted-foreground">{data.summary}</p>
      </div>

      {/* Alerts */}
      {data.alerts && data.alerts.length > 0 && (
        <div className="space-y-1.5">
          {data.alerts.map((alert, i) => {
            const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info;
            const Icon = style.icon;
            return (
              <div key={i} className={`rounded-lg border ${style.border} ${style.bg} p-2.5`}>
                <div className={`flex items-center gap-2 text-xs font-medium ${style.text}`}>
                  <Icon className="w-3.5 h-3.5" />
                  {alert.message}
                </div>
                {alert.parts.length > 0 && (
                  <p className="text-[0.625rem] text-muted-foreground mt-1 ml-5">
                    Části: {alert.parts.join(", ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Patterns */}
      {data.patterns && data.patterns.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-[0.625rem] font-medium text-muted-foreground uppercase tracking-wider">
            Detekované vzorce
          </h4>
          {data.patterns.map((pattern, i) => {
            const style = SEVERITY_STYLES[pattern.severity] || SEVERITY_STYLES.info;
            return (
              <div key={i} className={`rounded-lg border ${style.border} ${style.bg} p-2.5`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[0.625rem] font-medium ${style.text} bg-background/50 px-1.5 py-0.5 rounded`}>
                    {TYPE_LABELS[pattern.type] || pattern.type}
                  </span>
                  {pattern.parts_involved.length > 0 && (
                    <span className="text-[0.625rem] text-muted-foreground">
                      {pattern.parts_involved.join(", ")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-foreground">{pattern.description}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Positive trends */}
      {data.positive_trends && data.positive_trends.length > 0 && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-green-600 mb-1">
            <TrendingUp className="w-3.5 h-3.5" />
            Pozitivní trendy
          </div>
          <ul className="text-xs text-muted-foreground space-y-0.5 ml-5 list-disc">
            {data.positive_trends.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={fetchPatterns} className="h-7 text-[0.625rem] w-full">
        <Brain className="w-3 h-3 mr-1" />
        Aktualizovat analýzu
      </Button>
    </div>
  );
};

export default DidPatternPanel;
