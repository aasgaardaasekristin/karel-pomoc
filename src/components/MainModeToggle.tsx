import { MessageSquare, FileText } from "lucide-react";

type MainMode = "chat" | "report";

interface MainModeToggleProps {
  currentMode: MainMode;
  onModeChange: (mode: MainMode) => void;
}

const MainModeToggle = ({ currentMode, onModeChange }: MainModeToggleProps) => {
  return (
    <div className="flex justify-center">
      <div className="inline-flex bg-muted rounded-2xl p-1 gap-0.5">
        <button
          onClick={() => onModeChange("chat")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium tracking-wide transition-all duration-200 ${
            currentMode === "chat"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          Osobní
        </button>
        <button
          onClick={() => onModeChange("report")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium tracking-wide transition-all duration-200 ${
            currentMode === "report"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileText className="w-4 h-4" />
          Pracovní
        </button>
      </div>
    </div>
  );
};

export default MainModeToggle;
