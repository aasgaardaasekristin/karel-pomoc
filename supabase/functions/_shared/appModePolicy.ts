export type AppModeId = "karel_chat" | "did_kluci" | "hana_osobni" | "no_save";
export type SafetySeverity = "low" | "medium" | "high" | "critical";

export interface RuntimePersistencePolicy {
  mode_id: AppModeId;
  save_policy: "optional_default_off" | "did_governed" | "privacy_first" | "never";
  did_relevance_policy: "none" | "did_rules" | "processed_implication_only";
  pantry_policy: "none" | "relevant_events" | "processed_did_implication_only";
  drive_policy: "none" | "audit_governed" | "no_raw_personal";
  safety_policy: "detect_all_modes_minimal_audit";
  no_save: boolean;
}

const basePolicies: Record<AppModeId, Omit<RuntimePersistencePolicy, "no_save">> = {
  karel_chat: {
    mode_id: "karel_chat",
    save_policy: "optional_default_off",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  did_kluci: {
    mode_id: "did_kluci",
    save_policy: "did_governed",
    did_relevance_policy: "did_rules",
    pantry_policy: "relevant_events",
    drive_policy: "audit_governed",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  hana_osobni: {
    mode_id: "hana_osobni",
    save_policy: "privacy_first",
    did_relevance_policy: "processed_implication_only",
    pantry_policy: "processed_did_implication_only",
    drive_policy: "no_raw_personal",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  no_save: {
    mode_id: "no_save",
    save_policy: "never",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
  },
};

export function resolvePersistencePolicy(input: { mode_id?: string; no_save?: boolean; didSubMode?: string | null; mode?: string | null }): RuntimePersistencePolicy {
  const requested = input.mode_id === "did_kluci" || input.mode_id === "hana_osobni" || input.mode_id === "karel_chat"
    ? input.mode_id
    : input.mode === "childcare"
      ? "did_kluci"
      : input.didSubMode === "general"
        ? "hana_osobni"
        : "karel_chat";
  const noSave = input.no_save === true;
  return { ...(noSave ? basePolicies.no_save : basePolicies[requested]), no_save: noSave };
}

const safetyPatterns: Array<{ signal: string; severity: SafetySeverity; pattern: RegExp }> = [
  { signal: "sebeposkozeni", severity: "critical", pattern: /sebepo\w*|\u0159ez[a\u00e1]t se|rezat se|ubl[i\u00ed][z\u017e]it si|ublizit si/i },
  { signal: "sebevrazda", severity: "critical", pattern: /sebevra\w*|suicid|zab[i\u00ed]t se|nechci [z\u017e][i\u00ed]t|ukon[c\u010d]it [z\u017e]ivot/i },
  { signal: "ublizeni_druhym", severity: "critical", pattern: /ubl[i\u00ed][z\u017e]it (mu|j[i\u00ed]|jim|n[e\u011b]komu)|zabiju|napadnu|chci mu ubl/i },
  { signal: "dite_v_nebezpeci", severity: "critical", pattern: /d[i\u00ed]t[e\u011b].*(nebezpe[c\u010d][i\u00ed]|ohro[z\u017e]en|akutn)|bezprost[r\u0159]edn[\u00edi].*nebezpe[c\u010d][i\u00ed]/i },
  { signal: "akutni_krize", severity: "high", pattern: /akutn[i\u00ed] krize|krizov[a\u00e1] situace|kolaps|nezvl[a\u00e1]d[a\u00e1]m to|jsem v nebezpe[c\u010d][i\u00ed]/i },
  { signal: "zneuziti_nasili_trauma", severity: "high", pattern: /zneu[z\u017e]|n[a\u00e1]sil|nasili|zn[a\u00e1]sil|tyr[a\u00e1]n|trauma|napaden/i },
];

const rank: Record<SafetySeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function detectSafetyMention(text: string): { matched: boolean; severity: SafetySeverity; signals: string[] } {
  const signals: string[] = [];
  let severity: SafetySeverity = "low";
  for (const item of safetyPatterns) {
    if (item.pattern.test(text || "")) {
      signals.push(item.signal);
      if (rank[item.severity] > rank[severity]) severity = item.severity;
    }
  }
  return { matched: signals.length > 0, severity, signals };
}

export function redactedSafetyExcerpt(text: string): string | null {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
