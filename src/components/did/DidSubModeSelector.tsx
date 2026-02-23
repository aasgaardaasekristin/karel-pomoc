import { Heart, MessageCircle, ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DidSubMode = "mamka" | "cast" | "form" | "freetext" | "general";

interface DidSubModeSelectorProps {
  onSelect: (subMode: DidSubMode) => void;
  onBack?: () => void;
}

const DidSubModeSelector = ({ onSelect, onBack }: DidSubModeSelectorProps) => {
  const options = [
    {
      id: "mamka" as const,
      icon: Heart,
      label: "Mamka (terapeut)",
      description: "Mluví mamka – Karel se zeptá na situaci, požádá o výňatek z NotebookLM a strukturovaně odpoví.",
    },
    {
      id: "cast" as const,
      icon: MessageCircle,
      label: "Část mluví s Karlem",
      description: "Mluví dítě / část – Karel přizpůsobí jazyk věku, udrží bezpečný tón a vygeneruje handover pro mamku.",
    },
    {
      id: "general" as const,
      icon: BookOpen,
      label: "Obecná porada o DID",
      description: "Konzultace o metodách, strategiích a přístupech k práci s DID systémem.",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
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
              className="w-full flex items-start gap-4 p-4 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left"
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
