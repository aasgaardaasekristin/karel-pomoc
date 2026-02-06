import {
  Wind, Moon, Layers, CloudRain, Heart, ShieldAlert,
  Baby, Briefcase, Activity, Eye, Sparkles,
} from "lucide-react";

export type CalmScenario =
  | "panic" | "insomnia" | "overwhelm" | "sadness"
  | "relationship" | "threat" | "child_anxiety"
  | "work_stress" | "somatic" | "shame" | "other";

interface ScenarioOption {
  id: CalmScenario;
  label: string;
  icon: React.ElementType;
}

const scenarios: ScenarioOption[] = [
  { id: "panic", label: "Panika / silná úzkost", icon: Wind },
  { id: "insomnia", label: "Nemohu usnout", icon: Moon },
  { id: "overwhelm", label: "Je toho na mě moc", icon: Layers },
  { id: "sadness", label: "Smutek / prázdno", icon: CloudRain },
  { id: "relationship", label: "Vztahové napětí", icon: Heart },
  { id: "threat", label: "Cítím se doma ohroženě", icon: ShieldAlert },
  { id: "child_anxiety", label: "Úzkost u dítěte / rodičovská bezmoc", icon: Baby },
  { id: "work_stress", label: "Pracovní / studijní stres", icon: Briefcase },
  { id: "somatic", label: "Tělesná úzkost (bušení, závratě)", icon: Activity },
  { id: "shame", label: "Stud / vina", icon: Eye },
  { id: "other", label: "Něco jiného", icon: Sparkles },
];

interface ScenarioSelectorProps {
  onSelect: (scenario: CalmScenario) => void;
}

const ScenarioSelector = ({ onSelect }: ScenarioSelectorProps) => {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-2">
        Co teď prožíváš?
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-8">
        Vyber, co je ti nejblíž. Společně to zkusíme zklidnit.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {scenarios.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className="flex items-center gap-3 px-4 py-3.5 rounded-xl border border-border bg-card hover:bg-secondary/60 transition-all duration-200 text-left group"
          >
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
              <Icon className="w-4.5 h-4.5 text-primary" />
            </div>
            <span className="text-sm font-medium text-foreground">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ScenarioSelector;
