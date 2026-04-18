import { Feather, MessageCircle, ArrowLeft, BookOpen, Flower2, Search } from "lucide-react";
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
    },
    {
      // "mamka" is a legacy routing token; user-facing label is "Hanička"
      // (canonical), see src/lib/therapistIdentity.ts.
      id: "mamka" as const,
      icon: Feather,
      label: "Hanička mluví s Karlem",
      description: "Supervize, analýza, plánování – Karel načte kartotéku a pracuje jako tandem-terapeut.",
    },
    {
      id: "kata" as const,
      icon: Flower2,
      label: "Káťa mluví s Karlem",
      description: "Konzultace pro Káťu – jak reagovat, jak oslovit části, jak podporovat systém.",
    },
    {
      id: "general" as const,
      icon: BookOpen,
      label: "Obecná porada o DID",
      description: "Konzultace o metodách, strategiích a přístupech k práci s DID systémem.",
    },
    {
      id: "research" as const,
      icon: Search,
      label: "Odborné zdroje",
      description: "Karel prohledá Perplexity a najde aktuální terapeutické metody a výzkumy.",
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
        {options.map((opt, index) => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.id}
              onClick={() => onSelect(opt.id)}
              className="w-full flex items-start gap-4 p-4 rounded-2xl transition-all duration-200 text-left animate-fade-in"
              style={{
                animationDelay: `${index * 60}ms`,
                animationFillMode: "both",
                background: "rgba(0, 0, 0, 0.1)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.2)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.22)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.1)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.12)";
              }}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                style={{
                  background: "rgba(255, 255, 255, 0.12)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                }}
              >
                <Icon className="w-5 h-5" style={{ color: "rgba(255, 255, 255, 0.8)" }} />
              </div>
              <div>
                <div className="font-medium" style={{ color: "rgba(255, 255, 255, 0.95)", textShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>{opt.label}</div>
                <div className="text-sm mt-0.5" style={{ color: "rgba(255, 255, 255, 0.7)", textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}>{opt.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DidSubModeSelector;
