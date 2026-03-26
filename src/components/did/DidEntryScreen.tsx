import { Users, Smile, ChevronRight } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { ArrowLeft } from "lucide-react";

interface Props {
  onSelectTerapeut: () => void;
  onSelectKluci: () => void;
  onBack: () => void;
}

const entries = [
  {
    key: "terapeut",
    title: "Terapeut",
    description: "Hanička nebo Káťa – supervize, analýza, plánování",
    icon: Users,
    iconBg: "bg-purple-100 dark:bg-purple-900/30",
    iconColor: "text-purple-600 dark:text-purple-400",
  },
  {
    key: "kluci",
    title: "Kluci",
    description: "Části systému – rozhovor s Karlem, vlastní vlákna",
    icon: Smile,
    iconBg: "bg-amber-100 dark:bg-amber-900/30",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
] as const;

const DidEntryScreen = ({ onSelectTerapeut, onSelectKluci, onBack }: Props) => {
  const handlers: Record<string, () => void> = {
    terapeut: onSelectTerapeut,
    kluci: onSelectKluci,
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
      {/* Top bar */}
      <div className="w-full max-w-sm flex items-center justify-between mb-8">
        <KarelButton variant="ghost" size="sm" onClick={onBack} icon={<ArrowLeft size={16} />}>
          Hub
        </KarelButton>
        <ThemeQuickButton />
      </div>

      {/* Title */}
      <div className="text-center mb-8 animate-fade-in">
        <h2 className="text-2xl font-bold text-[hsl(var(--text-primary))]">DID systém</h2>
        <p className="text-sm text-[hsl(var(--text-secondary))] mt-1.5">Kdo dnes mluví?</p>
      </div>

      {/* Cards */}
      <div className="w-full max-w-sm space-y-3">
        {entries.map((entry, index) => {
          const Icon = entry.icon;
          return (
            <KarelCard
              key={entry.key}
              variant="interactive"
              padding="none"
              className="animate-fade-in"
              style={{ animationDelay: `${index * 80}ms`, animationFillMode: "both" }}
              onClick={handlers[entry.key]}
            >
              <div className="flex items-center gap-4 p-5">
                <div className={`w-12 h-12 rounded-full ${entry.iconBg} flex items-center justify-center shrink-0`}>
                  <Icon size={22} className={entry.iconColor} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-lg font-semibold text-[hsl(var(--text-primary))]">{entry.title}</span>
                  <p className="text-sm text-[hsl(var(--text-secondary))] mt-0.5">{entry.description}</p>
                </div>
                <ChevronRight size={18} className="text-[hsl(var(--text-disabled))] shrink-0" />
              </div>
            </KarelCard>
          );
        })}
      </div>
    </div>
  );
};

export default DidEntryScreen;
