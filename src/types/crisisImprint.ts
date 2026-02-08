export interface DiagnosticProfile {
  cognitiveProfile: {
    concentration: "high" | "medium" | "low" | "unknown";
    flexibility: "high" | "medium" | "low" | "unknown";
    thinkingStyle: "symbolic" | "concrete" | "mixed" | "unknown";
    responseSpeed: "fast" | "normal" | "slow" | "unknown";
    responseLength: "short" | "normal" | "long" | "unknown";
  };
  emotionalSignals: {
    frustrationReaction: "adaptive" | "avoidant" | "escalating" | "unknown";
    cooperationLevel: "active" | "passive" | "resistant" | "unknown";
    stateChange: "improving" | "stable" | "worsening" | "unknown";
    aggressiveImpulses: "none" | "mild" | "moderate" | "severe" | "unknown";
  };
  projectionContent: string[];
  activityEngagement: {
    activitiesOffered: string[];
    activitiesAccepted: string[];
    activitiesRejected: string[];
  };
  diagnosticHypothesis: string;
}

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
    riskEscalationPattern: string;
  };
  diagnosticProfile?: DiagnosticProfile;
  conversationExcerpts?: string[];
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
