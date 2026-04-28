export type SafetySeverity = "low" | "medium" | "high" | "critical";

export interface SafetyDetectionResult {
  matched: boolean;
  severity: SafetySeverity;
  signals: string[];
}

const SAFETY_PATTERNS: Array<{ signal: string; severity: SafetySeverity; pattern: RegExp }> = [
  { signal: "sebepoškození", severity: "critical", pattern: /sebepo\w*|řez[aá]t se|rezat se|ubl[ií][zž]it si|ublizit si/i },
  { signal: "sebevražda", severity: "critical", pattern: /sebevra\w*|suicid|zab[ií]t se|nechci [zž][ií]t|ukon[cč]it [zž]ivot/i },
  { signal: "ublížení druhým", severity: "critical", pattern: /ubl[ií][zž]it (mu|j[ií]|jim|n[eě]komu)|zabiju|napadnu|chci mu ubl/i },
  { signal: "dítě v bezprostředním nebezpečí", severity: "critical", pattern: /d[ií]t[eě].*(nebezpe[cč][ií]|ohro[zž]en|akutn)|bezprost[rř]edn[íi].*nebezpe[cč][ií]/i },
  { signal: "akutní krize", severity: "high", pattern: /akutn[ií] krize|krizov[aá] situace|kolaps|nezvl[aá]d[aá]m to|jsem v nebezpe[cč][ií]/i },
  { signal: "zneužití/násilí/trauma", severity: "high", pattern: /zneuž|zneuz|n[aá]sil|nasili|zn[aá]sil|tyr[aá]n|trauma|napaden/i },
];

const severityRank: Record<SafetySeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const detectSafetyMention = (text: string): SafetyDetectionResult => {
  const signals: string[] = [];
  let severity: SafetySeverity = "low";
  for (const item of SAFETY_PATTERNS) {
    if (item.pattern.test(text)) {
      signals.push(item.signal);
      if (severityRank[item.severity] > severityRank[severity]) severity = item.severity;
    }
  }
  return { matched: signals.length > 0, severity, signals };
};

export const buildSafetyResponse = (result: SafetyDetectionResult, noSave: boolean) => {
  if (!result.matched) return "";
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
