import { Users, Smile, ChevronRight } from "lucide-react";

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
  },
  {
    key: "kluci",
    title: "Kluci",
    description: "Části systému – rozhovor s Karlem, vlastní vlákna",
    icon: Smile,
  },
] as const;

const DidEntryScreen = ({ onSelectTerapeut, onSelectKluci, onBack }: Props) => {
  const handlers: Record<string, () => void> = {
    terapeut: onSelectTerapeut,
    kluci: onSelectKluci,
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">

      {/* Title */}
      <div className="text-center mb-8 animate-fade-in">
        <h2 className="text-2xl font-serif font-medium text-white/95 tracking-wide" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.4)" }}>
          DID systém
        </h2>
        <p className="text-sm font-light text-white/70 mt-1.5 tracking-wide" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.3)" }}>
          Kdo dnes mluví?
        </p>
      </div>

      {/* Cards — glass morphism */}
      <div className="w-full max-w-sm space-y-3">
        {entries.map((entry, index) => {
          const Icon = entry.icon;
          return (
            <div
              key={entry.key}
              className="rounded-2xl cursor-pointer transition-all duration-200 animate-fade-in group"
              style={{
                animationDelay: `${index * 80}ms`,
                animationFillMode: "both",
                background: "rgba(0, 0, 0, 0.15)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.25)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.25)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.15)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.15)";
              }}
              onClick={handlers[entry.key]}
            >
              <div className="flex items-center gap-4 p-5">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: "rgba(255, 255, 255, 0.15)",
                    backdropFilter: "blur(8px)",
                    WebkitBackdropFilter: "blur(8px)",
                  }}
                >
                  <Icon size={22} style={{ color: "rgba(255, 255, 255, 0.85)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <span
                    className="text-lg font-semibold text-white"
                    style={{ textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}
                  >
                    {entry.title}
                  </span>
                  <p
                    className="text-sm text-white/80 mt-0.5"
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.4)" }}
                  >
                    {entry.description}
                  </p>
                </div>
                <ChevronRight size={18} style={{ color: "rgba(255, 255, 255, 0.5)" }} className="shrink-0" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DidEntryScreen;
