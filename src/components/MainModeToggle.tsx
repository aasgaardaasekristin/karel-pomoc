import { MessageSquare, FileText } from "lucide-react";

type MainMode = "chat" | "report";

interface MainModeToggleProps {
  currentMode: MainMode;
  onModeChange: (mode: MainMode) => void;
}

const MainModeToggle = ({ currentMode, onModeChange }: MainModeToggleProps) => {
  return (
    <div className="flex justify-center">
      <div className="inline-flex bg-secondary rounded-xl p-1 gap-1">
        <button
          onClick={() => onModeChange("chat")}
          className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
            currentMode === "chat"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/80"
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span className="hidden sm:inline">OSOBNÍ</span>
          <span className="sm:hidden">Osobní</span>
        </button>
        <button
          onClick={() => onModeChange("report")}
          className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
            currentMode === "report"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/80"
          }`}
        >
          <FileText className="w-4 h-4" />
          <span className="hidden sm:inline">Režim B – Report</span>
          <span className="sm:hidden">Report</span>
        </button>
      </div>
    </div>
  );
};

export default MainModeToggle;
