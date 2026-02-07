export interface CrisisImprint {
  id: string;
  timestamp: string;
  scenario: string;
  riskScore: number;
  signals: {
    hopelessness: boolean;
    regulationFailure: boolean;
    helpRefusal: boolean;
    selfHarm: boolean;
    domesticThreat: boolean;
    narrowedFuture: boolean;
  };
  regulationAttempts: number;
  regulationSuccessful: boolean;
  therapistBridgeTriggered: boolean;
  therapistBridgeMethod: "email" | "sms" | null;
  timeDynamics: {
    sessionDurationMs: number;
    messageCount: number;
    riskEscalationPattern: string; // e.g. "rapid" | "gradual" | "stable"
  };
  note: string;
}

export interface CrisisBrief {
  riskOverview: string;
  recommendedContact: string;
  suggestedOpeningLines: string[];
  riskFormulations: string[];
  nextSteps: string[];
  imprint: CrisisImprint;
}
