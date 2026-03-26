import {
  Wind, Moon, TreePine, Waves, Heart, Flame,
  Layers, CloudRain, Baby, Briefcase, Activity, Eye, Sparkles, BrainCircuit, CloudFog,
} from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";

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
  gradient: string;
  iconColor: string;
}

const scenarios: ScenarioOption[] = [
  { id: "panic", label: "Dýchání", hint: "Zklidni dech, zklidni mysl", icon: Wind, gradient: "from-sky-500/10 to-blue-500/10", iconColor: "text-sky-600 dark:text-sky-400" },
  { id: "overwhelm", label: "Uzemnění", hint: "Vrať se do přítomného okamžiku", icon: TreePine, gradient: "from-green-500/10 to-emerald-500/10", iconColor: "text-green-600 dark:text-green-400" },
  { id: "sadness", label: "Bezpečné místo", hint: "Najdi si bezpečné místo v mysli", icon: Waves, gradient: "from-cyan-500/10 to-teal-500/10", iconColor: "text-cyan-600 dark:text-cyan-400" },
  { id: "insomnia", label: "Usínání", hint: "Uvolni napětí a nech se unášet", icon: Moon, gradient: "from-indigo-500/10 to-violet-500/10", iconColor: "text-indigo-600 dark:text-indigo-400" },
  { id: "relationship", label: "Útěcha", hint: "Vlídná slova, když to bolí", icon: Heart, gradient: "from-pink-500/10 to-rose-500/10", iconColor: "text-pink-600 dark:text-pink-400" },
  { id: "threat", label: "Krize", hint: "Okamžitá podpora v tísni", icon: Flame, gradient: "from-orange-500/10 to-amber-500/10", iconColor: "text-orange-600 dark:text-orange-400" },
];

const extraScenarios: { id: CalmScenario; label: string; hint: string; icon: React.ElementType }[] = [
  { id: "child_anxiety", label: "Úzkost u dítěte", hint: "Když vidíš, že tvé dítě trpí", icon: Baby },
  { id: "work_stress", label: "Pracovní stres", hint: "Když drtí práce nebo škola", icon: Briefcase },
  { id: "somatic", label: "Tělesná úzkost", hint: "Bušení, závratě, napětí", icon: Activity },
  { id: "shame", label: "Stud / vina", hint: "Když tě sžírá stud nebo vina", icon: Eye },
  { id: "rumination", label: "Ruminace", hint: "Myšlenky se točí dokola", icon: BrainCircuit },
  { id: "dissociation", label: "Odpojení", hint: "Cítím se mimo sebe", icon: CloudFog },
  { id: "other", label: "Něco jiného", hint: "Cokoliv, co teď prožíváš", icon: Sparkles },
];

interface ScenarioSelectorProps {
  onSelect: (scenario: CalmScenario) => void;
}

const ScenarioSelector = ({ onSelect }: ScenarioSelectorProps) => {
  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      <div className="text-center mb-8 animate-fade-in">
        <h2 className="text-xl font-bold text-[hsl(var(--text-primary))]">
          Co teď prožíváš?
        </h2>
        <p className="text-sm text-[hsl(var(--text-secondary))] mt-1.5">
          Vyber, co je ti nejblíž. Společně to zkusíme zklidnit.
        </p>
      </div>

      {/* Primary 6 scenarios - 2x3 grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        {scenarios.map(({ id, label, hint, icon: Icon, gradient, iconColor }, index) => (
          <KarelCard
            key={id}
            variant="interactive"
            padding="none"
            className="animate-fade-in overflow-hidden"
            style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
            onClick={() => onSelect(id)}
          >
            <div className={`flex flex-col items-center text-center p-4 bg-gradient-to-br ${gradient}`}>
              <div className="w-10 h-10 rounded-xl bg-white/80 dark:bg-white/10 flex items-center justify-center mb-2.5">
                <Icon size={20} className={iconColor} />
              </div>
              <span className="text-sm font-semibold text-[hsl(var(--text-primary))]">{label}</span>
              <span className="text-[10px] text-[hsl(var(--text-tertiary))] mt-0.5 line-clamp-2">{hint}</span>
            </div>
          </KarelCard>
        ))}
      </div>

      {/* Extra scenarios - compact list */}
      <div className="space-y-1.5">
        {extraScenarios.map(({ id, label, hint, icon: Icon }, index) => (
          <KarelCard
            key={id}
            variant="interactive"
            padding="none"
            className="animate-fade-in"
            style={{ animationDelay: `${(6 + index) * 60}ms`, animationFillMode: "both" }}
            onClick={() => onSelect(id)}
          >
            <div className="flex items-center gap-3 px-3 py-2.5">
              <Icon size={16} className="text-[hsl(var(--text-tertiary))] shrink-0" />
              <div className="min-w-0">
                <span className="text-sm font-medium text-[hsl(var(--text-primary))]">{label}</span>
                <span className="text-xs text-[hsl(var(--text-tertiary))] ml-2">{hint}</span>
              </div>
            </div>
          </KarelCard>
        ))}
      </div>
    </div>
  );
};

export default ScenarioSelector;
