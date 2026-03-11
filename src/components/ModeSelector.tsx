import { Brain, Shield, Heart, Baby, Search } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare" | "research";

interface ModeSelectorProps {
  currentMode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
  hideDid?: boolean;
}

const ModeSelector = ({ currentMode, onModeChange, hideDid }: ModeSelectorProps) => {
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
      label: "DID",
      sublabel: "DID",
      tooltip: "Režim pro práci s DID systémem – terapeuti i části",
      icon: Baby,
      className: "mode-button-childcare",
    },
    {
      id: "research" as const,
      label: "Profesní zdroje",
      sublabel: "research",
      tooltip: "Karel prohledá internet – odborné články, testy, metody, trendy v psychologii",
      icon: Search,
      className: "mode-button-supervision",
    },
  ].filter(m => !hideDid || m.id !== "childcare");

  return (
    <TooltipProvider delayDuration={300}>
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-1.5 sm:gap-2 justify-center">
        {modes.map((modeItem) => {
          const Icon = modeItem.icon;
          const isActive = currentMode === modeItem.id;

          return (
            <Tooltip key={modeItem.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onModeChange(modeItem.id)}
                  className={`mode-button flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 text-xs sm:text-sm ${
                    isActive
                      ? modeItem.className
                      : "bg-secondary text-secondary-foreground border-border hover:bg-secondary/80"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
                  <span className="hidden sm:inline">
                    {modeItem.label}
                    <span className="text-xs opacity-80 ml-1">({modeItem.sublabel})</span>
                  </span>
                  <span className="sm:hidden leading-tight">
                    {modeItem.sublabel}
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
