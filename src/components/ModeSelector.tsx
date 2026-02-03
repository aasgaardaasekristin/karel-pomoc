import { Brain, Shield, Heart } from "lucide-react";

type ConversationMode = "debrief" | "supervision" | "safety";

interface ModeSelectorProps {
  currentMode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
}

const ModeSelector = ({ currentMode, onModeChange }: ModeSelectorProps) => {
  const modes = [
    {
      id: "debrief" as const,
      label: "Debrief po sezení",
      sublabel: "psychohygiena",
      icon: Heart,
      className: "mode-button-debrief",
    },
    {
      id: "supervision" as const,
      label: "Supervizní reflexe",
      sublabel: "případu",
      icon: Brain,
      className: "mode-button-supervision",
    },
    {
      id: "safety" as const,
      label: "Bezpečnost a hranice",
      sublabel: "rizika",
      icon: Shield,
      className: "mode-button-safety",
    },
  ];

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {modes.map((modeItem) => {
        const Icon = modeItem.icon;
        const isActive = currentMode === modeItem.id;

        return (
          <button
            key={modeItem.id}
            onClick={() => onModeChange(modeItem.id)}
            className={`mode-button flex items-center gap-2 ${
              isActive
                ? modeItem.className
                : "bg-secondary text-secondary-foreground border-border hover:bg-secondary/80"
            }`}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">
              {modeItem.label}
              <span className="text-xs opacity-80 ml-1">({modeItem.sublabel})</span>
            </span>
            <span className="sm:hidden">{modeItem.label.split(" ")[0]}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ModeSelector;
