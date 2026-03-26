import { Coffee, Eye, Shield, Baby, Search } from "lucide-react";
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
  hideResearch?: boolean;
}

const ModeSelector = ({ currentMode, onModeChange, hideDid, hideResearch }: ModeSelectorProps) => {
  const modes = [
    {
      id: "debrief" as const,
      label: "Debrief",
      tooltip: "Prostor pro zpracování emocí po pracovním dni",
      icon: Coffee,
      activeClasses: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 shadow-subtle",
    },
    {
      id: "supervision" as const,
      label: "Supervize",
      tooltip: "Reflexe konkrétního případu, trénink a zápis",
      icon: Eye,
      activeClasses: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 shadow-subtle",
    },
    {
      id: "safety" as const,
      label: "Bezpečnost",
      tooltip: "Postup při obavách, dokumentace a hranice",
      icon: Shield,
      activeClasses: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 shadow-subtle",
    },
    {
      id: "childcare" as const,
      label: "DID",
      tooltip: "Režim pro práci s DID systémem – terapeuti i části",
      icon: Baby,
      activeClasses: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 shadow-subtle",
    },
    {
      id: "research" as const,
      label: "Research",
      tooltip: "Karel prohledá internet – odborné články, testy, metody, trendy",
      icon: Search,
      activeClasses: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 shadow-subtle",
    },
  ].filter(m => (!hideDid || m.id !== "childcare") && (!hideResearch || m.id !== "research"));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-wrap gap-1 justify-center">
        {modes.map((modeItem) => {
          const Icon = modeItem.icon;
          const isActive = currentMode === modeItem.id;

          return (
            <Tooltip key={modeItem.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onModeChange(modeItem.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                    isActive
                      ? modeItem.activeClasses
                      : "text-[hsl(var(--text-tertiary))] hover:bg-[hsl(var(--surface-tertiary))] hover:text-[hsl(var(--text-secondary))]"
                  }`}
                >
                  <Icon size={14} />
                  {modeItem.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[12.5rem] text-center">
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
