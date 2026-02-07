import {
  Wind, Moon, Layers, CloudRain, Heart, ShieldAlert,
  Baby, Briefcase, Activity, Eye, Sparkles, BrainCircuit, CloudFog,
} from "lucide-react";

export type CalmScenario =
  | "panic" | "insomnia" | "overwhelm" | "sadness"
  | "relationship" | "threat" | "child_anxiety"
  | "work_stress" | "somatic" | "shame"
  | "rumination" | "dissociation" | "other";

interface ScenarioOption {
  id: CalmScenario;
  label: string;
  hint: string;
  icon: React.ElementType;
}

const scenarios: ScenarioOption[] = [
  { id: "panic", label: "Panika / silná úzkost", hint: "Když tě zaplaví strach nebo úzkost", icon: Wind },
  { id: "insomnia", label: "Nemohu usnout", hint: "Když myšlenky nebo napětí nedají spát", icon: Moon },
  { id: "overwhelm", label: "Je toho na mě moc", hint: "Když nestíháš a cítíš přetížení", icon: Layers },
  { id: "sadness", label: "Smutek / prázdno", hint: "Když se cítíš prázdně nebo smutně", icon: CloudRain },
  { id: "relationship", label: "Vztahové napětí", hint: "Když bolí vztahy s blízkými", icon: Heart },
  { id: "threat", label: "Cítím se doma ohroženě", hint: "Když se necítíš v bezpečí", icon: ShieldAlert },
  { id: "child_anxiety", label: "Úzkost u dítěte / rodičovská bezmoc", hint: "Když vidíš, že tvé dítě trpí", icon: Baby },
  { id: "work_stress", label: "Pracovní / studijní stres", hint: "Když drtí práce nebo škola", icon: Briefcase },
  { id: "somatic", label: "Tělesná úzkost (bušení, závratě)", hint: "Když úzkost cítíš hlavně v těle", icon: Activity },
  { id: "shame", label: "Stud / vina (těžké pocity)", hint: "Když tě sžírá stud nebo vina", icon: Eye },
  { id: "rumination", label: "Nemohu zastavit myšlenky", hint: "Když se myšlenky točí dokola", icon: BrainCircuit },
  { id: "dissociation", label: "Cítím se odpojeně / mimo sebe", hint: "Když se cítíš mimo nebo neskutečně", icon: CloudFog },
  { id: "other", label: "Něco jiného", hint: "Cokoliv, co teď prožíváš", icon: Sparkles },
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
        {scenarios.map(({ id, label, hint, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className="flex items-center gap-3 px-4 py-3.5 rounded-xl border border-border bg-card hover:bg-secondary/60 transition-all duration-200 text-left group"
          >
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
              <Icon className="w-4.5 h-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium text-foreground block">{label}</span>
              <span className="text-xs text-muted-foreground block mt-0.5">{hint}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ScenarioSelector;
