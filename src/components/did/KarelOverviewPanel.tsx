import ErrorBoundary from "@/components/ErrorBoundary";
import DidDailyBriefingPanel from "./DidDailyBriefingPanel";

interface Props {
  refreshTrigger?: number;
  onOpenDeliberation?: (id: string) => void;
  variant?: "standalone" | "embedded";
}

/**
 * Final Pracovna Cleanup Verdict (2026-04-21):
 *  - Vnější header „Karlův přehled" ODSTRANĚN — duplikoval header uvnitř
 *    `DidDailyBriefingPanel` (datum + jeho vlastní „Přegenerovat").
 *  - Vnější tlačítko „Obnovit" ODSTRANĚN — uživatel nesmí vidět dva
 *    konkurenční refresh knoflíky pro tentýž briefing.
 *  - Wrapper teď jen poskytuje ErrorBoundary + jung-hero-section rám.
 *  - Briefing zůstává jediným ownerem decision layeru. Žádný další
 *    decision deck pod ním (KarelCrisisDeficits / DailyDecisionTasks
 *    už z Pracovny zmizel v předchozím passu).
 */
const KarelOverviewPanel = ({
  refreshTrigger = 0,
  onOpenDeliberation,
  variant = "standalone",
}: Props) => {
  const isEmbedded = variant === "embedded";

  const content = (
    <div className={isEmbedded ? "space-y-4" : "relative z-10 mx-auto max-w-[900px] space-y-4 px-4 py-6"}>
      <div className="jung-hero-section rounded-2xl p-4">
        <ErrorBoundary fallbackTitle="Karlův přehled selhal">
          <DidDailyBriefingPanel
            refreshTrigger={refreshTrigger}
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
