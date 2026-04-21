/**
 * CrisisDetailContext — Crisis Detail UX Repair Pass (2026-04-21).
 *
 * Single owner pro „otevřít crisis detail":
 *   - Banner (CrisisAlert) volá `openCrisisDetail(cardId)`.
 *   - Karlův přehled (KarelCrisisDeficits) volá `openCrisisDetail(cardId)`.
 *   - Obě cesty otevřou TUTÉŽ pracovní plochu — `CrisisDetailWorkspace`
 *     (right-side Sheet drawer renderovaný v App.tsx).
 *
 * Žádné event-emit hacky, žádný inline accordion, žádné dvojí mechanismy.
 *
 * `cardId` = `eventId || alertId || partName` — stejný klíč, který už produkuje
 * `useCrisisOperationalState` (viz buildDeficits a CrisisAlert mapování).
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

interface CrisisDetailContextValue {
  activeCardId: string | null;
  openCrisisDetail: (cardId: string, opts?: { initialTab?: "overview" | "closure" | "history" }) => void;
  closeCrisisDetail: () => void;
  initialTab: "overview" | "closure" | "history";
}

const CrisisDetailContext = createContext<CrisisDetailContextValue | null>(null);

export const CrisisDetailProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<CrisisDetailContextValue["initialTab"]>("overview");

  const openCrisisDetail = useCallback<CrisisDetailContextValue["openCrisisDetail"]>((cardId, opts) => {
    setInitialTab(opts?.initialTab ?? "overview");
    setActiveCardId(cardId);
  }, []);

  const closeCrisisDetail = useCallback(() => {
    setActiveCardId(null);
  }, []);

  const value = useMemo(
    () => ({ activeCardId, openCrisisDetail, closeCrisisDetail, initialTab }),
    [activeCardId, openCrisisDetail, closeCrisisDetail, initialTab],
  );

  return <CrisisDetailContext.Provider value={value}>{children}</CrisisDetailContext.Provider>;
};

export function useCrisisDetail(): CrisisDetailContextValue {
  const ctx = useContext(CrisisDetailContext);
  if (!ctx) {
    // Fallback no-op — komponenta se může vyrenderovat mimo provider (např. v testech).
    // Vracíme bezpečné no-op, aby se nestřílelo runtime exception.
    return {
      activeCardId: null,
      openCrisisDetail: () => {
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-console
          console.warn("[CrisisDetailContext] openCrisisDetail volán mimo provider — no-op.");
        }
      },
      closeCrisisDetail: () => {},
      initialTab: "overview",
    };
  }
  return ctx;
}
