export const NO_HISTORY_REFRESH_MARKER = "NO_HISTORY_REFRESH_E2E_MARKER_2026_04_28";
export const NO_HISTORY_BACKEND_BYPASS_MARKER = "NO_HISTORY_BACKEND_BYPASS_TEST_2026_04_28";

export const NO_HISTORY_PERSISTENT_TABLES = [
  "did_threads",
  "karel_hana_conversations",
  "karel_pantry_b_entries",
  "did_event_ingestion_log",
  "did_pantry_packages",
  "did_pending_drive_writes",
] as const;

export const NO_HISTORY_RUNTIME_AUDIT_TABLE = "karel_runtime_audit_logs" as const;

export const BACKEND_BYPASS_NO_SAVE_PAYLOAD = {
  mode_id: "karel_chat",
  no_save: true,
  message: NO_HISTORY_BACKEND_BYPASS_MARKER,
} as const;

export const NO_HISTORY_ACCEPTANCE_PROOF = {
  ui_after_refresh: "žádná předchozí zpráva, input prázdný, historie prázdná nebo pouze welcome zpráva",
  browser_storage: "marker count = 0 v localStorage i sessionStorage",
  database_absence: "marker count = 0 v běžných persistentních tabulkách",
  runtime_audit: "běžný no-history marker není uložený v runtime audit logu",
} as const;