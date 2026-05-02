import { useRef } from "react";
import ErrorBoundary from "@/components/ErrorBoundary";
import DidDailyBriefingPanel from "./DidDailyBriefingPanel";
import { useVisibleClinicalTextAudit } from "@/lib/visibleClinicalTextGuard";

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
 *
 * P1 (2026-05-02):
 *  - Tento wrapper je SINGLE ROOT pro Briefing render path (loading,
 *    !briefing, normální). Proto sem patří `data-visible-clinical-panel`
 *    + `useVisibleClinicalTextAudit("briefing", …)` — všechny vnořené
 *    Karel-generované texty (opening_monologue, last_3_days, proposed_*,
 *    visible section headings) se auditují po každém commitu.
 *  - DidDailyBriefingPanel si dál drží vlastní `cleanVisibleClinicalText`
 *    a `ensureKarelOpeningVoice` — ten cleaner je primární prevence,
 *    audit zde je catch-all pojistka pro vše, co cleanerem propadne.
 */
const KarelOverviewPanel = ({
  refreshTrigger = 0,
  onOpenDeliberation,
  variant = "standalone",
}: Props) => {
  const isEmbedded = variant === "embedded";
  const auditRootRef = useRef<HTMLDivElement>(null);

  useVisibleClinicalTextAudit("briefing", auditRootRef, {
    failInTest: false,
    logInProduction: true,
  });

  const content = (
    <div
      ref={auditRootRef}
      data-visible-clinical-panel="briefing"
      className={isEmbedded ? "space-y-4" : "relative z-10 mx-auto max-w-[900px] space-y-4 px-4 py-6"}
    >
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
