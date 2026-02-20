import { Brain, Shield, Heart, Baby } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare";

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
      tooltip: "Prostor pro zpracování emocí po pracovním dni",
      icon: Heart,
      className: "mode-button-debrief",
    },
    {
      id: "supervision" as const,
      label: "Supervizní reflexe",
      sublabel: "případu",
      tooltip: "Reflexe konkrétního případu, trénink a zápis",
      icon: Brain,
      className: "mode-button-supervision",
    },
    {
      id: "safety" as const,
      label: "Bezpečnost a hranice",
      sublabel: "rizika",
      tooltip: "Postup při obavách, dokumentace a hranice",
      icon: Shield,
      className: "mode-button-safety",
    },
    {
      id: "childcare" as const,
      label: "Péče o dítě",
      sublabel: "DID",
      tooltip: "Podpora při péči o dítě s disociativní poruchou",
      icon: Baby,
      className: "mode-button-childcare",
    },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-wrap gap-2 justify-center">
        {modes.map((modeItem) => {
          const Icon = modeItem.icon;
          const isActive = currentMode === modeItem.id;

          return (
            <Tooltip key={modeItem.id}>
              <TooltipTrigger asChild>
                <button
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
                  <span className="sm:hidden text-xs leading-tight text-center">
                    {modeItem.label}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px] text-center">
                <p className="text-xs">{modeItem.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
};

export default ModeSelector;
