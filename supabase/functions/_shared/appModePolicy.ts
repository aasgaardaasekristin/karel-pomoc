export type AppModeId = "karel_chat" | "did_kluci" | "hana_osobni" | "no_save";
export type SafetySeverity = "none" | "low" | "medium" | "high" | "critical";
export type SafetyCategory = "self_harm" | "suicidal_ideation" | "harm_to_others" | "child_immediate_danger" | "abuse_or_violence_current" | "medical_emergency" | "severe_dissociation_or_lost_time" | "unsafe_instruction_request" | "sexual_or_exploitative_content";

export interface RuntimePersistencePolicy {
  mode_id: AppModeId;
  save_policy: "optional_default_off" | "did_governed" | "privacy_first" | "never";
  did_relevance_policy: "none" | "did_rules" | "processed_implication_only";
  pantry_policy: "none" | "relevant_events" | "processed_did_implication_only";
  drive_policy: "none" | "audit_governed" | "no_raw_personal";
  daily_briefing_policy: "none" | "did_relevant_only" | "processed_implication_only";
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
    daily_briefing_policy: "none",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  did_kluci: {
    mode_id: "did_kluci",
    save_policy: "did_governed",
    did_relevance_policy: "did_rules",
    pantry_policy: "relevant_events",
    drive_policy: "audit_governed",
    daily_briefing_policy: "did_relevant_only",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  hana_osobni: {
    mode_id: "hana_osobni",
    save_policy: "privacy_first",
    did_relevance_policy: "processed_implication_only",
    pantry_policy: "processed_did_implication_only",
    drive_policy: "no_raw_personal",
    daily_briefing_policy: "processed_implication_only",
    safety_policy: "detect_all_modes_minimal_audit",
  },
  no_save: {
    mode_id: "no_save",
    save_policy: "never",
    did_relevance_policy: "none",
    pantry_policy: "none",
    drive_policy: "none",
    daily_briefing_policy: "none",
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

const safetyPatterns: Array<{ signal: string; category: SafetyCategory; severity: SafetySeverity; current?: boolean; pattern: RegExp }> = [
  { signal: "unsafe_instruction_request", category: "unsafe_instruction_request", severity: "critical", current: true, pattern: /jak (se )?(zab[i\u00ed]t|otravit|p[o\u0159]ed[a\u00e1]vkovat|ubl[i\u00ed][z\u017e]it|vyrobit zbra[n\u0148])|n[a\u00e1]vod.*(sebevra|ubl[i\u00ed][z\u017e]|zbra[n\u0148])/i },
  { signal: "suicidal_ideation", category: "suicidal_ideation", severity: "critical", current: true, pattern: /sebevra\w*|suicid|zab[i\u00ed]t se|nechci [z\u017e][i\u00ed]t|ukon[c\u010d]it [z\u017e]ivot/i },
  { signal: "self_harm", category: "self_harm", severity: "critical", current: true, pattern: /sebepo\w*|\u0159ez[a\u00e1]t se|rezat se|ubl[i\u00ed][z\u017e]it si|ublizit si/i },
  { signal: "harm_to_others", category: "harm_to_others", severity: "critical", current: true, pattern: /ubl[i\u00ed][z\u017e]it (mu|j[i\u00ed]|jim|n[e\u011b]komu)|zabiju|napadnu|chci mu ubl/i },
  { signal: "child_immediate_danger", category: "child_immediate_danger", severity: "critical", current: true, pattern: /d[i\u00ed]t[e\u011b].*(nebezpe[c\u010d][i\u00ed]|ohro[z\u017e]en|akutn|pr[a\u00e1]v[e\u011b].*(bij|t[y\u00fd]r|zneu[z\u017e]))|bezprost[r\u0159]edn[\u00edi].*nebezpe[c\u010d][i\u00ed]/i },
  { signal: "abuse_or_violence_current", category: "abuse_or_violence_current", severity: "high", current: true, pattern: /(te[d\u010f]|pr[a\u00e1]v[e\u011b]|aktu[a\u00e1]ln[e\u011b]).*(zneu[z\u017e]|n[a\u00e1]sil|bij|tyr[a\u00e1]n|napad)/i },
  { signal: "medical_emergency", category: "medical_emergency", severity: "critical", current: true, pattern: /nem[u\u016f][z\u017e]u d[y\u00fd]chat|bolest na hrudi|bezv[e\u011b]dom[i\u00ed]|p[o\u0159]ed[a\u00e1]vkov[a\u00e1]n[i\u00ed]|krv[a\u00e1]c[i\u00ed]m/i },
  { signal: "severe_dissociation_or_lost_time", category: "severe_dissociation_or_lost_time", severity: "high", current: true, pattern: /nev[i\u00ed]m kde jsem|ztratil[ao]? jsem [c\u010d]as|probral[ao]? jsem se.*nev[i\u00ed]m|nejsem v realit[e\u011b]/i },
  { signal: "sexual_or_exploitative_content", category: "sexual_or_exploitative_content", severity: "high", current: true, pattern: /(d[i\u00ed]t[e\u011b]|nezletil).*sex|sexu[a\u00e1]ln[i\u00ed].*(zneu[z\u017e]|n[a\u00e1]tlak|vyko[r\u0159]is)/i },
  { signal: "therapeutic_trauma_context", category: "abuse_or_violence_current", severity: "low", current: false, pattern: /flashback|trauma|minul[e\u011b].*(zneu[z\u017e]|n[a\u00e1]sil)|boj[i\u00ed] se us[i\u00ed]n[a\u00e1]n[i\u00ed]/i },
];

const rank: Record<SafetySeverity, number> = { none: -1, low: 0, medium: 1, high: 2, critical: 3 };

export function detectSafetyMention(text: string): { matched: boolean; safety_detected: boolean; severity: SafetySeverity; category: SafetyCategory | null; current_risk: boolean; historical_or_contextual: boolean; user_role_context: "therapist" | "child" | "adult_user" | "unknown"; allowed_to_continue: boolean; required_response_style: "normal" | "supportive_check" | "safety_response" | "emergency_guidance" | "refuse_unsafe_instruction"; persistence_exception_allowed: boolean; signals: string[] } {
  const signals: string[] = [];
  let severity: SafetySeverity = "none";
  let category: SafetyCategory | null = null;
  let currentRisk = false;
  for (const item of safetyPatterns) {
    if (item.pattern.test(text || "")) {
      signals.push(item.signal);
      if (item.current) currentRisk = true;
      if (rank[item.severity] > rank[severity]) {
        severity = item.severity;
        category = item.category;
      }
    }
  }
  const userRole = /terapeut|terapeutka|klient|pozorov[a\u00e1]n[i\u00ed]|sezen[i\u00ed]|karta|Hanka|K[a\u00e1][t\u0165]a/i.test(text || "") ? "therapist" : (text || "").trim() ? "adult_user" : "unknown";
  const unsafe = category === "unsafe_instruction_request";
  const acute = currentRisk && (severity === "high" || severity === "critical");
  return { matched: signals.length > 0, safety_detected: signals.length > 0, severity, category, current_risk: currentRisk, historical_or_contextual: signals.length > 0 && !currentRisk, user_role_context: userRole, allowed_to_continue: !unsafe, required_response_style: unsafe ? "refuse_unsafe_instruction" : acute ? (severity === "critical" ? "emergency_guidance" : "safety_response") : signals.length > 0 ? "supportive_check" : "normal", persistence_exception_allowed: acute || unsafe, signals };
}

export function redactedSafetyExcerpt(text: string): string | null {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
