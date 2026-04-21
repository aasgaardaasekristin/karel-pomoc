import { useState } from "react";
import { Brain, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import ErrorBoundary from "@/components/ErrorBoundary";
import DidDailyBriefingPanel from "./DidDailyBriefingPanel";

interface Props {
  refreshTrigger?: number;
  onOpenDeliberation?: (id: string) => void;
  variant?: "standalone" | "embedded";
}

const KarelOverviewPanel = ({
  refreshTrigger = 0,
  onOpenDeliberation,
  variant = "standalone",
}: Props) => {
  const [internalRefresh, setInternalRefresh] = useState(0);
  const isEmbedded = variant === "embedded";

  const content = (
    <div className={isEmbedded ? "space-y-4" : "relative z-10 mx-auto max-w-[900px] space-y-4 px-4 py-6"}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Brain className="h-4 w-4 text-primary" />
          <span className="font-serif tracking-wide">Karlův přehled</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-3 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setInternalRefresh((n) => n + 1)}
        >
          <RefreshCw className="h-3 w-3" /> Obnovit
        </Button>
      </div>

      <div className="jung-hero-section rounded-2xl p-4">
        <ErrorBoundary fallbackTitle="Karlův přehled selhal">
          <DidDailyBriefingPanel
            refreshTrigger={refreshTrigger + internalRefresh}
            onOpenDeliberation={onOpenDeliberation}
          />
        </ErrorBoundary>
      </div>
    </div>
  );

  if (isEmbedded) return content;

  return <div className="min-h-screen" data-no-swipe-back="true">{content}</div>;
};

export default KarelOverviewPanel;
