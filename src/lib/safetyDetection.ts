export type SafetySeverity = "none" | "low" | "medium" | "high" | "critical";
export type SafetyCategory =
  | "self_harm"
  | "suicidal_ideation"
  | "harm_to_others"
  | "child_immediate_danger"
  | "abuse_or_violence_current"
  | "medical_emergency"
  | "severe_dissociation_or_lost_time"
  | "unsafe_instruction_request"
  | "sexual_or_exploitative_content";
export type UserRoleContext = "therapist" | "child" | "adult_user" | "unknown";
export type RequiredResponseStyle = "normal" | "supportive_check" | "safety_response" | "emergency_guidance" | "refuse_unsafe_instruction";

export interface SafetyDetectionResult {
  matched: boolean;
  safety_detected: boolean;
  severity: SafetySeverity;
  category: SafetyCategory | null;
  signals: string[];
  current_risk: boolean;
  historical_or_contextual: boolean;
  user_role_context: UserRoleContext;
  allowed_to_continue: boolean;
  required_response_style: RequiredResponseStyle;
  persistence_exception_allowed: boolean;
}

const SAFETY_PATTERNS: Array<{ signal: string; category: SafetyCategory; severity: SafetySeverity; current?: boolean; pattern: RegExp }> = [
  { signal: "žádost o škodlivý návod", category: "unsafe_instruction_request", severity: "critical", current: true, pattern: /jak (se )?(zab[ií]t|otravit|p[oř]ed[aá]vkovat|ubl[ií][zž]it|vyrobit zbra[nň]|obej[ií]t bezpe[cč]nost)|návod.*(sebevra|ubl[ií][zž]|zbra[nň])/i },
  { signal: "sebevražedné myšlenky", category: "suicidal_ideation", severity: "critical", current: true, pattern: /sebevra\w*|suicid|zab[ií]t se|nechci [zž][ií]t|ukon[cč]it [zž]ivot/i },
  { signal: "sebepoškození", category: "self_harm", severity: "critical", current: true, pattern: /sebepo\w*|řez[aá]t se|rezat se|ubl[ií][zž]it si|ublizit si/i },
  { signal: "ublížení druhým", category: "harm_to_others", severity: "critical", current: true, pattern: /ubl[ií][zž]it (mu|j[ií]|jim|n[eě]komu)|zabiju|napadnu|chci mu ubl/i },
  { signal: "dítě v bezprostředním nebezpečí", category: "child_immediate_danger", severity: "critical", current: true, pattern: /d[ií]t[eě].*(nebezpe[cč][ií]|ohro[zž]en|akutn|pr[aá]v[eě].*(bij|t[yý]r|zneu[zž]))|bezprost[rř]edn[íi].*nebezpe[cč][ií]/i },
  { signal: "aktuální násilí nebo zneužití", category: "abuse_or_violence_current", severity: "high", current: true, pattern: /(te[dď]|pr[aá]v[eě]|aktu[aá]ln[eě]).*(zneu[zž]|n[aá]sil|bij|tyr[aá]n|napad)/i },
  { signal: "zdravotní urgentní stav", category: "medical_emergency", severity: "critical", current: true, pattern: /nem[uů][zž]u d[yý]chat|bolest na hrudi|bezv[eě]dom[ií]|p[oř]ed[aá]vkov[aá]n[ií]|krv[aá]c[ií]m/i },
  { signal: "těžká disociace nebo ztráta času", category: "severe_dissociation_or_lost_time", severity: "high", current: true, pattern: /nev[ií]m kde jsem|ztratil[ao]? jsem [cč]as|probral[ao]? jsem se.*nev[ií]m|nejsem v realit[eě]/i },
  { signal: "sexuální nebo exploatační obsah", category: "sexual_or_exploitative_content", severity: "high", current: true, pattern: /(d[ií]t[eě]|nezletil).*sex|sexu[aá]ln[ií].*(zneu[zž]|n[aá]tlak|vyko[rř]is)/i },
  { signal: "terapeutický kontext traumatu", category: "abuse_or_violence_current", severity: "low", current: false, pattern: /flashback|trauma|minul[eě].*(zneu[zž]|n[aá]sil)|boj[ií] se us[ií]n[aá]n[ií]/i },
];

const severityRank: Record<SafetySeverity, number> = { none: -1, low: 0, medium: 1, high: 2, critical: 3 };

const inferRole = (text: string): UserRoleContext => {
  if (/terapeut|terapeutka|klient|pozorov[aá]n[ií]|sezen[ií]|karta|Hanka|K[aá][tť]a/i.test(text)) return "therapist";
  if (/jsem mal[yýá]|boj[ií]m se|mamka|Karel.*pomoc/i.test(text)) return "child";
  if (text.trim()) return "adult_user";
  return "unknown";
};

export const detectSafetyMention = (text: string): SafetyDetectionResult => {
  const signals: string[] = [];
  let severity: SafetySeverity = "none";
  let category: SafetyCategory | null = null;
  let currentRisk = false;
  for (const item of SAFETY_PATTERNS) {
    if (item.pattern.test(text)) {
      signals.push(item.signal);
      if (item.current) currentRisk = true;
      if (severityRank[item.severity] > severityRank[severity]) {
        severity = item.severity;
        category = item.category;
      }
    }
  }
  const userRoleContext = inferRole(text);
  const unsafe = category === "unsafe_instruction_request";
  const acute = currentRisk && (severity === "high" || severity === "critical");
  const matched = signals.length > 0;
  const historicalOrContextual = matched && !currentRisk;
  return {
    matched,
    safety_detected: matched,
    severity,
    category,
    signals,
    current_risk: currentRisk,
    historical_or_contextual: historicalOrContextual,
    user_role_context: userRoleContext,
    allowed_to_continue: !unsafe,
    required_response_style: unsafe ? "refuse_unsafe_instruction" : acute ? (severity === "critical" ? "emergency_guidance" : "safety_response") : matched ? "supportive_check" : "normal",
    persistence_exception_allowed: acute || unsafe,
  };
};

export const buildSafetyResponse = (result: SafetyDetectionResult, noSave: boolean) => {
  if (!result.matched) return "";
  if (result.required_response_style === "refuse_unsafe_instruction") {
    return "S tímhle návodem nepomůžu. Můžu ale pomoct bezpečně: zastavit akutní impuls, zmenšit riziko a najít člověka nebo krizovou pomoc, která teď může být nablízku.";
  }
  if (result.historical_or_contextual && !result.current_risk) {
    return "Beru to jako terapeuticky důležitý kontext, ne jako automatický zákaz tématu. Budu rozlišovat minulou zkušenost, aktuální riziko a to, co teď potřebuje bezpečné držení.";
  }
  const urgent = result.severity === "critical";
  return [
    urgent
      ? "Tohle beru jako možné akutní ohrožení. Teď prosím nezůstávej sám/sama."
      : "Tohle zní jako bezpečnostně důležitá věc. Pojďme ji držet klidně a konkrétně.",
    "Kontaktuj prosím hned bezpečného dospělého, terapeutku nebo místní krizovou pomoc; při bezprostředním nebezpečí volej emergency službu.",
    noSave
      ? "Režim bez ukládání respektuji: běžný obsah neukládám. Kvůli bezpečí může vzniknout jen minimální redigovaná safety stopa."
      : "Teď je důležitější bezpečí než analýza. Napiš jen to nejnutnější: jsi teď v bezprostředním nebezpečí?",
  ].join("\n\n");
};
