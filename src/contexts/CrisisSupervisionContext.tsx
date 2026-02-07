import React, { createContext, useContext, useState, ReactNode } from "react";
import type { CrisisImprint, CrisisBrief } from "@/types/crisisImprint";

interface CrisisSupervisionContextType {
  pendingImprints: CrisisImprint[];
  addImprint: (imprint: CrisisImprint) => void;
  clearImprints: () => void;
  crisisBrief: CrisisBrief | null;
  setCrisisBrief: React.Dispatch<React.SetStateAction<CrisisBrief | null>>;
  isBriefLoading: boolean;
  setIsBriefLoading: React.Dispatch<React.SetStateAction<boolean>>;
}

const CrisisSupervisionContext = createContext<CrisisSupervisionContextType | undefined>(undefined);

export const CrisisSupervisionProvider = ({ children }: { children: ReactNode }) => {
  const [pendingImprints, setPendingImprints] = useState<CrisisImprint[]>([]);
  const [crisisBrief, setCrisisBrief] = useState<CrisisBrief | null>(null);
  const [isBriefLoading, setIsBriefLoading] = useState(false);

  const addImprint = (imprint: CrisisImprint) => {
    setPendingImprints((prev) => [...prev, imprint]);
    console.log("CRISIS_IMPRINT_CREATED", { id: imprint.id, scenario: imprint.scenario, riskScore: imprint.riskScore });
  };

  const clearImprints = () => {
    setPendingImprints([]);
    setCrisisBrief(null);
  };

  return (
    <CrisisSupervisionContext.Provider value={{
      pendingImprints,
      addImprint,
      clearImprints,
      crisisBrief,
      setCrisisBrief,
      isBriefLoading,
      setIsBriefLoading,
    }}>
      {children}
    </CrisisSupervisionContext.Provider>
  );
};

export const useCrisisSupervision = () => {
  const context = useContext(CrisisSupervisionContext);
  if (!context) {
    throw new Error("useCrisisSupervision must be used within CrisisSupervisionProvider");
  }
  return context;
};
