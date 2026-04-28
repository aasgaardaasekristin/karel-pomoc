export type AppModeId = "karel_chat" | "did_kluci" | "hana_osobni" | "no_save";
export type SavePolicy = "optional_default_off" | "did_governed" | "privacy_first" | "never";
export type DidRelevancePolicy = "none" | "did_rules" | "processed_implication_only";
export type PantryPolicy = "none" | "relevant_events" | "processed_did_implication_only";
export type DrivePolicy = "none" | "audit_governed" | "no_raw_personal";
export type SafetyPolicy = "detect_all_modes_minimal_audit";

export interface AppModePolicy {
  mode_id: AppModeId;
  label: string;
  description: string;
  save_policy: SavePolicy;
  did_relevance_policy: DidRelevancePolicy;
  pantry_policy: PantryPolicy;
  drive_policy: DrivePolicy;
  safety_policy: SafetyPolicy;
}

export const APP_MODE_POLICIES: Record<AppModeId, AppModePolicy> = {
  karel_chat: {
    mode_id: "karel_chat",
    label: "Karel chat",
    description: "Běžný osobní/asistenční chat bez automatického DID writebacku.",
    save_policy: "optional_default_off",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  did_kluci: {
    mode_id: "did_kluci",
    label: "DID / Kluci",
    description: "Terapeutický DID režim s kartami, přehledem, sezeními a řízenou ingestion.",
    save_policy: "did_governed",
    did_relevance_policy: "did_rules",
    pantry_policy: "relevant_events",
    drive_policy: "audit_governed",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  hana_osobni: {
    mode_id: "hana_osobni",
    label: "Hana osobní",
    description: "Soukromý prostor Haničky; raw osobní obsah se neposílá do Drive.",
    save_policy: "privacy_first",
    did_relevance_policy: "processed_implication_only",
    pantry_policy: "processed_did_implication_only",
    drive_policy: "no_raw_personal",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  no_save: {
    mode_id: "no_save",
    label: "Bez ukládání",
    description: "Dočasný režim bez běžné paměti, Pantry B, Drive a briefing vstupů.",
    save_policy: "never",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
  },
};

export const getModePolicy = (modeId: AppModeId, noSave = false): AppModePolicy => {
  if (noSave) return APP_MODE_POLICIES.no_save;
  return APP_MODE_POLICIES[modeId];
};

export const getAppModeForHub = (hubSection: string | null | undefined): AppModeId => {
  if (hubSection === "did") return "did_kluci";
  if (hubSection === "hana") return "hana_osobni";
  return "karel_chat";
};
