import { MessageCircle, ClipboardList } from "lucide-react";

type MainMode = "chat" | "report";

interface MainModeToggleProps {
  currentMode: MainMode;
  onModeChange: (mode: MainMode) => void;
}

const modes = [
  { id: "chat" as const, label: "Osobní", icon: MessageCircle },
  { id: "report" as const, label: "Pracovní", icon: ClipboardList },
] as const;

const MainModeToggle = ({ currentMode, onModeChange }: MainModeToggleProps) => {
  return (
    <div className="flex justify-center">
      <div className="inline-flex bg-[hsl(var(--surface-tertiary))] rounded-lg p-1 gap-0.5">
        {modes.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onModeChange(id)}
            className={`flex items-center gap-2 px-5 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
              currentMode === id
                ? "bg-[hsl(var(--surface-primary))] text-[hsl(var(--text-primary))] shadow-soft"
                : "text-[hsl(var(--text-secondary))] hover:text-[hsl(var(--text-primary))]"
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MainModeToggle;
