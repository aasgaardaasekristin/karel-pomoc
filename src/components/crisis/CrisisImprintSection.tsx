import { AlertTriangle, TrendingUp, StickyNote } from "lucide-react";
import RichMarkdown from "@/components/ui/RichMarkdown";
import type { DbCrisisBrief } from "./types";

const signalLabels: Record<string, string> = {
  hopelessness: "Beznaděj",
  regulationFailure: "Selhání regulace",
  helpRefusal: "Odmítání pomoci",
  selfHarm: "Sebepoškozování (nepřímo)",
  domesticThreat: "Ohrožení doma",
  narrowedFuture: "Zúžení budoucnosti / prázdnota",
};

const CrisisImprintSection = ({ brief }: { brief: DbCrisisBrief }) => {
  const signals = brief.signals || {};
  const activeSignals = Object.entries(signals).filter(([, v]) => v === true);
  const dynamics = brief.time_dynamics || {};
  const pattern = (dynamics as Record<string, string>).riskEscalationPattern;

  const riskLabel = brief.risk_score >= 12 ? "kritické" : brief.risk_score >= 9 ? "vysoké" : "zvýšené";

  return (
    <div className="space-y-4 text-foreground/90">
      {/* Scenario & Score */}
      <div className="flex flex-wrap gap-3">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted text-xs font-medium">
          Scénář: {brief.scenario}
        </span>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-destructive/10 text-destructive text-xs font-medium">
          <AlertTriangle className="w-3 h-3" />
          RiskScore: {brief.risk_score} ({riskLabel})
        </span>
      </div>

      {/* Key signals */}
      {activeSignals.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Klíčové signály:</p>
          <div className="flex flex-wrap gap-2">
            {activeSignals.map(([key]) => (
              <span key={key} className="inline-flex items-center px-2.5 py-1 rounded-md bg-destructive/10 text-destructive text-xs">
                {signalLabels[key] || key}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Risk overview from AI */}
      {brief.risk_overview && (
        <div className="p-3 rounded-lg bg-muted/50 border border-border">
          <RichMarkdown>{brief.risk_overview}</RichMarkdown>
        </div>
      )}

      {/* Dynamics */}
      {pattern && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <TrendingUp className="w-3.5 h-3.5" />
          Dynamika: {pattern === "rapid" ? "rychlé zhoršování" : pattern === "gradual" ? "postupné zhoršování" : "stabilní distres"}{" "}
          {dynamics.messageCount && `(${dynamics.messageCount} zpráv)`}
        </div>
      )}

      {/* Note */}
      {brief.note && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <StickyNote className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <p>{brief.note}</p>
        </div>
      )}
    </div>
  );
};

export default CrisisImprintSection;
