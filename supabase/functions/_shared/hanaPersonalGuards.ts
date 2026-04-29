export const pragueDateISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const INLINE_BRIEFING_PATTERN = /(DENN[ÍI]\s+BRIEFING|KARL[ŮU]V\s+P[ŘR]EHLED|AKUTN[ÍI]\s*:|ÚKOLY\s+NA\s+DNES\s*:|UKOLY\s+NA\s+DNES\s*:|SLEDOVAT\s*:|STRUČN[ÝY]\s+PŘEHLED\s*:|STRUCN[YÝ]\s+PREHLED\s*:|PANTRY\s*B|INGESTION\s+SUMMARY|DRIVE\s+SYNC)/i;
const EXPLICIT_BRIEFING_REQUEST_PATTERN = /(denn[íi]\s+briefing|karl[ůu]v\s+p[řr]ehled|rann[íi]\s+p[řr]ehled|uka[zž].*briefing|p[řr]egeneruj.*briefing)/i;
const OVERSTRONG_EVIDENCE_PATTERN = /(diagnostick[ýy]\s+sign[áa]l|vysv[ěe]tluje(?:\s+to)?|zt[ěe]les[nň]uje|zt[ěe]lesn[ěe]n[íi]|hlubok[ýy]\s+sign[áa]l|jednozna[čc]n[ěe]\s+ukazuje|ukazuje\s+n[áa]m\s+jednozna[čc]n[ěe]|je\s+to\s+projekce|symbol\s+zraniteln[ýy]ch\s+[čc][áa]st[íi]|(?:stal|stala|stalo|st[aá]v[aá]\s+se)\s+[^.!?\n]{0,80}\bsymbolem\b|identifikace\s+s\s+n[íi]m|d[ěe]ti\s+(?:jsou|se\s+staly)\s+[^.!?\n]{0,80}\b(?:v\s+n[ěe]m|j[íi]m)\b|dob[řr]e\s+znaj[íi]\s+[^.!?\n]{0,80}\bpot[řr]ebu\b|pot[řr]ebu\s+b[ýy]t\s+zachr[aá]n[ěe]n|souzn[ěe]j[íi]|ob[řr][íi]\s+empatie)/i;
const REAL_WORLD_FACT_INPUT_PATTERN = /(skute[čc]n(?:[áaéeý]|ou)|re[aá]ln(?:[áaéeý]|ou)|aktu[aá]ln[íi]|zpr[aá]v[ayu]|odkaz|url|https?:\/\/|nen[íi]\s+to\s+(?:symbol|projekce|fiktivn[íi])|nepochopil\s+jsi\s+situaci|z[aá]chrann(?:[áaý]|ou)|telefon[aá]t|[úu]mrt[íi]|ztr[aá]t[au]|v[aá]lk[ay]|po[žz][aá]r|nemoc|zdravotn[íi]\s+ud[aá]lost|[čc]l[aá]nek)/i;

export function hanaPersonalSystemGuardBlock(currentDate = pragueDateISO()): string {
  return `
═══ HANA/OSOBNÍ PRIVACY-FIRST GUARD ═══
Aktuální ověřené datum pro Prahu: ${currentDate}. Pokud uvádíš datum, použij pouze toto datum nebo datum explicitně doložené v DB kontextu. Nikdy nehádej datum.

V Hana/Osobní nikdy nevypisuj interní denní briefing, Karlův přehled, týmový dashboard, úkolový briefing pro Haničku/Káťu, Pantry/ingestion internals ani backendové provozní shrnutí, pokud si to Hanička výslovně nevyžádá.

Pokud Hanička přinese DID-relevantní informaci, odpověz osobně, krátce, klidně a podpůrně. Zpracovaná terapeutická implikace může vzniknout na pozadí, ale v chatu nevkládej interní briefing.

Jazyk: pro kluky nepoužívej chladné slovo „systém“, pokud nejde o technické vysvětlení. Preferuj „kluci“, „děti“, „části“, „vnitřní rodina“.

Evidence discipline: Hana/Osobní vstup je therapist report / therapist observation / factual correction. Reálná událost, odkaz, zpráva, osoba, zvíře, telefonát, zdravotní událost nebo světová situace je external_fact / therapist_factual_correction, ne child evidence. Nesmíš z ní automaticky dělat jistý klinický závěr o části. Používej opatrné formulace: „může to ukazovat“, „zdá se“, „stojí za ověření“, „je potřeba se zeptat, co děti samy říkají/cítí“. Bez přímé evidence části neříkej: „diagnostický signál“, „vysvětluje to“, „ztělesňuje“, „hluboký signál“, „jednoznačně ukazuje“, „projekce“, „symbol zranitelných částí“.`;
}

export function guardHanaPersonalResponse(output: string, userInput: string, currentDate = pragueDateISO()): { text: string; replaced: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const explicitBriefing = EXPLICIT_BRIEFING_REQUEST_PATTERN.test(userInput || "");
  if (!explicitBriefing && INLINE_BRIEFING_PATTERN.test(output || "")) reasons.push("inline_daily_briefing");
  if (/2\.\s*kv[ěe]tna/i.test(output || "") && !/2\.\s*kv[ěe]tna/i.test(userInput || "")) reasons.push("wrong_date_may_2");
  if (OVERSTRONG_EVIDENCE_PATTERN.test(output || "")) reasons.push("overstrong_evidence_claim");
  if (!reasons.length) return { text: output, replaced: false, reasons };
  if (REAL_WORLD_FACT_INPUT_PATTERN.test(userInput || "")) {
    return {
      replaced: true,
      reasons,
      text: `Hani, rozumím. Beru to jako skutečnou aktuální situaci a důležitý emoční kontext, ne jako automatický závěr o klucích.

Nebudu z toho dělat klinický výklad bez jejich vlastní reakce. Stojí za to jemně ověřit vlastní reakci kluků/dětí: co o té situaci sami říkají, co cítí v těle, jestli jsou zahlcení, co by teď potřebovali a co jim pomáhá zůstat tady a v bezpečí.`,
    };
  }
  return {
    replaced: true,
    reasons,
    text: `Hani, rozumím. Tohle je pro kluky důležité a zároveň citlivé. Tady v osobním vlákně ti odpovím lidsky a klidně; interní terapeutické zpracování si Karel udělá na pozadí, bez toho, aby ti do osobního chatu vkládal briefing.

Držím se dnešního data (${currentDate}) a budu to brát opatrně: jako Hančino sdělení a faktický/terapeutický kontext, ne jako jistý závěr o dětech bez jejich vlastní reakce.`,
  };
}