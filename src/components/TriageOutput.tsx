import { AlertTriangle, HelpCircle, ClipboardList, ArrowRight } from "lucide-react";

interface TriageData {
  followUpQuestions: Array<{ q: string; why: string }>;
  criticalDataToCollect: Array<{ item: string; why: string }>;
  contraindicationFlags: Array<{ flag: string; why: string }>;
  recommendedNextSteps: string[];
}

interface TriageOutputProps {
  data: TriageData;
}

const TriageOutput = ({ data }: TriageOutputProps) => {
  return (
    <div className="space-y-4 bg-card rounded-xl border border-border p-6">
      <h3 className="text-lg font-serif font-semibold text-foreground">Triage analýza</h3>

      {/* Critical Data to Collect */}
      {data.criticalDataToCollect.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-primary font-medium">
            <ClipboardList className="w-4 h-4" />
            <span>Co zjistit příště (důležité)</span>
          </div>
          <ul className="space-y-2 pl-6">
            {data.criticalDataToCollect.map((item, idx) => (
              <li key={idx} className="text-sm">
                <span className="font-medium">{item.item}</span>
                <span className="text-muted-foreground ml-2">— {item.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Follow Up Questions */}
      {data.followUpQuestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-accent font-medium">
            <HelpCircle className="w-4 h-4" />
            <span>Doplňující otázky</span>
          </div>
          <ul className="space-y-2 pl-6">
            {data.followUpQuestions.map((item, idx) => (
              <li key={idx} className="text-sm">
                <span className="font-medium">{item.q}</span>
                <span className="text-muted-foreground ml-2">— {item.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Contraindication Flags */}
      {data.contraindicationFlags.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-destructive font-medium">
            <AlertTriangle className="w-4 h-4" />
            <span>Pozor / kontraindikace</span>
          </div>
          <ul className="space-y-2 pl-6">
            {data.contraindicationFlags.map((item, idx) => (
              <li key={idx} className="text-sm">
                <span className="font-medium">{item.flag}</span>
                <span className="text-muted-foreground ml-2">— {item.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommended Next Steps */}
      {data.recommendedNextSteps.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-primary font-medium">
            <ArrowRight className="w-4 h-4" />
            <span>Doporučený další krok</span>
          </div>
          <ul className="space-y-1 pl-6">
            {data.recommendedNextSteps.map((step, idx) => (
              <li key={idx} className="text-sm font-medium">{step}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default TriageOutput;
