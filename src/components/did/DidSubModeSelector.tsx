import { Heart, MessageCircle, ArrowLeft, BookOpen, User, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DidSubMode = "mamka" | "cast" | "kata" | "general" | "research";

interface DidSubModeSelectorProps {
  onSelect: (subMode: DidSubMode) => void;
  onBack?: () => void;
}

const DidSubModeSelector = ({ onSelect, onBack }: DidSubModeSelectorProps) => {
  const options = [
    {
      id: "cast" as const,
      icon: MessageCircle,
      label: "Část mluví s Karlem",
      description: "Každá část má vlastní vlákno s 24h pamětí. Karel přizpůsobí jazyk a věk.",
      accent: "border-l-4 border-l-primary",
    },
    {
      id: "mamka" as const,
      icon: Heart,
      label: "Mamka mluví s Karlem",
      description: "Supervize, analýza, plánování – Karel načte kartotéku a pracuje jako tandem-terapeut.",
      accent: "border-l-4 border-l-pink-500",
    },
    {
      id: "kata" as const,
      icon: User,
      label: "Káťa mluví s Karlem",
      description: "Konzultace pro Káťu – jak reagovat, jak oslovit části, jak podporovat systém.",
      accent: "border-l-4 border-l-blue-500",
    },
    {
      id: "general" as const,
      icon: BookOpen,
      label: "Obecná porada o DID",
      description: "Konzultace o metodách, strategiích a přístupech k práci s DID systémem.",
      accent: "border-l-4 border-l-amber-500",
    },
    {
      id: "research" as const,
      icon: Search,
      label: "Odborné zdroje",
      description: "Karel prohledá Perplexity a najde aktuální terapeutické metody a výzkumy.",
      accent: "border-l-4 border-l-emerald-500",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {onBack && (
        <div className="flex justify-center mb-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Zpět na výběr režimu
          </Button>
        </div>
      )}
      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-8">
        Kdo teď mluví?
      </h2>
      <div className="space-y-3">
        {options.map((opt) => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.id}
              onClick={() => onSelect(opt.id)}
              className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left ${opt.accent}`}
            >
              <Icon className="w-5 h-5 mt-0.5 text-primary shrink-0" />
              <div>
                <div className="font-medium text-foreground">{opt.label}</div>
                <div className="text-sm text-muted-foreground mt-0.5">{opt.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DidSubModeSelector;
