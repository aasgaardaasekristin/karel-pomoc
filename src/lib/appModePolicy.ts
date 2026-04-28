export type AppModeId = "karel_chat" | "did_kluci" | "hana_osobni" | "no_save";
export type SavePolicy = "optional_default_off" | "did_governed" | "privacy_first" | "never";
export type DidRelevancePolicy = "none" | "did_rules" | "processed_implication_only";
export type PantryPolicy = "none" | "relevant_events" | "processed_did_implication_only";
export type DrivePolicy = "none" | "audit_governed" | "no_raw_personal";
export type DailyBriefingPolicy = "none" | "did_relevant_only" | "processed_implication_only";
export type SafetyPolicy = "detect_all_modes_minimal_audit";
export type StarterWritePolicy = "no_write" | "did_relevance_classifier" | "pantry_allowed" | "private_only";

export interface StarterQuestion {
  id: string;
  mode_id: Exclude<AppModeId, "no_save">;
  label: string;
  prompt: string;
  description?: string;
  default_no_save?: boolean;
  intended_write_policy: StarterWritePolicy;
  safety_sensitive?: boolean;
}

export interface AppModePolicy {
  mode_id: AppModeId;
  label: string;
  description: string;
  default_save_policy: SavePolicy;
  save_policy: SavePolicy;
  did_relevance_policy: DidRelevancePolicy;
  pantry_policy: PantryPolicy;
  drive_policy: DrivePolicy;
  daily_briefing_policy: DailyBriefingPolicy;
  safety_policy: SafetyPolicy;
  starter_questions: StarterQuestion[];
  allowed_surfaces: string[];
  disallowed_writebacks: string[];
}

const COMMON_NO_DID_WRITEBACKS = ["did_threads", "karel_pantry_b_entries", "did_event_ingestion_log", "did_pantry_packages", "did_pending_drive_writes", "karel_daily_briefing", "part_card_auto_create"];

export const APP_MODE_POLICIES: Record<AppModeId, AppModePolicy> = {
  karel_chat: {
    mode_id: "karel_chat",
    label: "Karel chat",
    description: "Běžný chat s Karlem. Nevytváří DID zápisy ani Karlův přehled.",
    default_save_policy: "optional_default_off",
    save_policy: "optional_default_off",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    daily_briefing_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
    starter_questions: [
      { id: "karel-priority", mode_id: "karel_chat", label: "Dnešní priority", prompt: "Pomoz mi promyslet dnešní priority.", intended_write_policy: "no_write" },
      { id: "karel-plan", mode_id: "karel_chat", label: "Zpráva nebo plán", prompt: "Pomoz mi napsat zprávu nebo plán.", intended_write_policy: "no_write" },
      { id: "karel-explain", mode_id: "karel_chat", label: "Vysvětli jednoduše", prompt: "Vysvětli mi složité téma jednoduše.", intended_write_policy: "no_write" },
      { id: "karel-tasks", mode_id: "karel_chat", label: "Uspořádat úkoly", prompt: "Pomoz mi zorganizovat úkoly.", intended_write_policy: "no_write" },
      { id: "karel-private", mode_id: "karel_chat", label: "Bez historie", prompt: "Chci si s tebou něco promyslet bez historie a bez ukládání.", default_no_save: true, intended_write_policy: "private_only" },
    ],
    allowed_surfaces: ["hub", "chat"],
    disallowed_writebacks: COMMON_NO_DID_WRITEBACKS,
  },
  did_kluci: {
    mode_id: "did_kluci",
    label: "DID / Kluci",
    description: "Terapeutický režim. Relevantní vstupy mohou vstoupit do spíže, přehledu a auditní dokumentace.",
    default_save_policy: "did_governed",
    save_policy: "did_governed",
    did_relevance_policy: "did_rules",
    pantry_policy: "relevant_events",
    drive_policy: "audit_governed",
    daily_briefing_policy: "did_relevant_only",
    safety_policy: "detect_all_modes_minimal_audit",
    starter_questions: [
      { id: "did-known", mode_id: "did_kluci", label: "Co Karel ví", prompt: "Co dnes Karel ví o klucích?", intended_write_policy: "did_relevance_classifier" },
      { id: "did-overview", mode_id: "did_kluci", label: "Karlův přehled", prompt: "Jaký je dnešní Karlův přehled?", intended_write_policy: "did_relevance_classifier" },
      { id: "did-session", mode_id: "did_kluci", label: "Návrh Sezení", prompt: "Připrav návrh Sezení.", intended_write_policy: "pantry_allowed" },
      { id: "did-playroom", mode_id: "did_kluci", label: "Návrh Herny", prompt: "Připrav návrh Herny.", intended_write_policy: "pantry_allowed" },
      { id: "did-card", mode_id: "did_kluci", label: "Karta části", prompt: "Otevři kartu části.", intended_write_policy: "did_relevance_classifier" },
      { id: "did-24h", mode_id: "did_kluci", label: "Posledních 24 hodin", prompt: "Co z posledních 24 hodin je důležité?", intended_write_policy: "did_relevance_classifier" },
      { id: "did-risk", mode_id: "did_kluci", label: "Rizika", prompt: "Zkontroluj rizika a stop signály.", intended_write_policy: "did_relevance_classifier", safety_sensitive: true },
      { id: "did-observation", mode_id: "did_kluci", label: "Terapeutické pozorování", prompt: "Pomoz mi zapsat terapeutické pozorování.", intended_write_policy: "pantry_allowed" },
    ],
    allowed_surfaces: ["hub", "did_dashboard", "did_threads", "playroom", "session", "meeting", "kartoteka"],
    disallowed_writebacks: ["raw_hana_personal_to_drive", "raw_private_chat_to_evidence", "unclassified_karel_chat_to_did"],
  },
  hana_osobni: {
    mode_id: "hana_osobni",
    label: "Hana osobní",
    description: "Soukromý prostor. Raw osobní obsah nejde na Drive; terapeuticky relevantní implikace jen po klasifikaci.",
    default_save_policy: "privacy_first",
    save_policy: "privacy_first",
    did_relevance_policy: "processed_implication_only",
    pantry_policy: "processed_did_implication_only",
    drive_policy: "no_raw_personal",
    daily_briefing_policy: "processed_implication_only",
    safety_policy: "detect_all_modes_minimal_audit",
    starter_questions: [
      { id: "hana-think", mode_id: "hana_osobni", label: "Osobně promyslet", prompt: "Potřebuji si něco osobně promyslet.", intended_write_policy: "private_only" },
      { id: "hana-calm", mode_id: "hana_osobni", label: "Zklidnit myšlenky", prompt: "Pomoz mi zklidnit a uspořádat myšlenky.", intended_write_policy: "private_only" },
      { id: "hana-distinguish", mode_id: "hana_osobni", label: "Osobní vs terapeutické", prompt: "Pomoz mi rozlišit, co je osobní a co je terapeuticky důležité.", intended_write_policy: "did_relevance_classifier" },
      { id: "hana-note-private", mode_id: "hana_osobni", label: "Bez historie", prompt: "Chci napsat soukromou poznámku bez historie a bez ukládání.", default_no_save: true, intended_write_policy: "private_only" },
      { id: "hana-transfer", mode_id: "hana_osobni", label: "Co přenést", prompt: "Co z toho je vhodné přenést do terapeutického režimu?", intended_write_policy: "did_relevance_classifier" },
    ],
    allowed_surfaces: ["hub", "hana_chat", "hana_report"],
    disallowed_writebacks: ["raw_personal_to_drive", "raw_personal_to_daily_briefing", "raw_personal_to_did_threads", "part_card_auto_create"],
  },
  no_save: {
    mode_id: "no_save",
    label: "Bez ukládání",
    description: "Dočasný režim bez běžné paměti, Pantry B, Drive a briefing vstupů.",
    default_save_policy: "never",
    save_policy: "never",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    daily_briefing_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
    starter_questions: [],
    allowed_surfaces: ["chat", "hana_chat"],
    disallowed_writebacks: ["did_threads", "karel_hana_conversations", "karel_pantry_b_entries", "did_event_ingestion_log", "did_pantry_packages", "did_pending_drive_writes", "daily_briefing", "long_term_memory"],
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
