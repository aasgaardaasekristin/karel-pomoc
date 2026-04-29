export const pragueDateISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const INLINE_BRIEFING_PATTERN = /(DENN[ÍI]\s+BRIEFING|KARL[ŮU]V\s+P[ŘR]EHLED|AKUTN[ÍI]\s*:|ÚKOLY\s+NA\s+DNES\s*:|UKOLY\s+NA\s+DNES\s*:|SLEDOVAT\s*:|STRUČN[ÝY]\s+PŘEHLED\s*:|STRUCN[YÝ]\s+PREHLED\s*:|PANTRY\s*B|INGESTION\s+SUMMARY|DRIVE\s+SYNC)/i;
const EXPLICIT_BRIEFING_REQUEST_PATTERN = /(denn[íi]\s+briefing|karl[ůu]v\s+p[řr]ehled|rann[íi]\s+p[řr]ehled|uka[zž].*briefing|p[řr]egeneruj.*briefing)/i;
const OVERSTRONG_EVIDENCE_PATTERN = /(diagnostick[ýy]\s+sign[áa]l|vysv[ěe]tluje(?:\s+to)?|zt[ěe]les[nň]uje|zt[ěe]lesn[ěe]n[íi]|hlubok[ýy]\s+sign[áa]l|jednozna[čc]n[ěe]\s+ukazuje|ukazuje\s+n[áa]m\s+jednozna[čc]n[ěe]|ukazuje\s+n[áa]m,?\s+jak\s+hluboce|je\s+to\s+projekce|symbol\s+zraniteln[ýy]ch\s+[čc][áa]st[íi]|(?:stal|stala|stalo|st[aá]v[aá]\s+se)\s+[^.!?\n]{0,80}\bsymbolem\b|identifikoval[aiy]?\s+se\s+[^.!?\n]{0,80}|identifikace\s+s\s+n[íi]m|(?:stal|stala|stalo)\s+[^.!?\n]{0,80}\bTimm(?:i|y)m?\b|d[ěe]ti\s+(?:jsou|se\s+staly)\s+[^.!?\n]{0,80}\b(?:v\s+n[ěe]m|j[íi]m)\b|dob[řr]e\s+znaj[íi]\s+[^.!?\n]{0,80}\bpot[řr]ebu\b|pot[řr]ebu\s+b[ýy]t\s+zachr[aá]n[ěe]n|souzn[ěe]j[íi]|ob[řr][íi]\s+empatie)/i;
const EXTERNAL_FACT_OVERINTERPRETATION_PATTERN = /(\b(?:je|jsou|byl[ao]?|bude|p[ůu]sob[íi]\s+jako)\s+[^.!?\n]{0,80}\bsymbol(?:em|u|y|ick[ýy])\b|\bsymbolizuje\b|\b(?:se\s+[^.!?\n]{0,80})?st[aá]v[aá]\s+[^.!?\n]{0,80}\bsymbolem\b|\bzt[ěe]les[nň]uje\b|\bje\s+[^.!?\n]{0,80}\bzt[ěe]lesn[ěe]n[íi]m\b|\bje\s+[^.!?\n]{0,80}\b(?:obrazem|metaforou)\b|\breprezentuje\b|\bodr[aá][zž][íi]\s+(?:jejich|vnit[řr]n[íi])\s+stav\b|\bukazuje\s+[^.!?\n]{0,80}\b(?:jejich\s+)?pot[řr]ebu\b|\bvysv[ěe]tluje\s+[^.!?\n]{0,80}\b(?:jejich\s+)?(?:[úu]navu|stav|strach|reakci|pro[žz][ií]v[aá]n[íi])\b|\b(?:je\s+[^.!?\n]{0,40}\b)?projekc[íi]\b|diagnostick[ýy]\s+sign[áa]l|hlubok[ýy]\s+sign[áa]l|jednozna[čc]n[ěe]\s+ukazuje|d[ěe]ti\s+(?:jsou|se\s+s\s+n[íi]m\s+ztoto[zž]nil[yi]|se\s+ztoto[zž]nil[yi])\s+[^.!?\n]{0,80}\b(?:v\s+n[ěe]m|j[íi]m|s\s+n[íi]m)?\b)/i;
const EXTERNAL_FACT_CHILD_STATE_CLAIM_PATTERN = /(pro\s+(?:na[sš]e\s+)?(?:d[ěe]ti|kluky|[čc][aá]sti)\s+[^.!?\n]{0,120}\b(?:je|nen[íi]|vytv[aá][řr][íi]|spou[sš]t[íi]|znamen[aá])\b|(?:d[ěe]ti|kluci|[čc][aá]sti)\s+[^.!?\n]{0,120}\b(?:c[ií]t[íi]|pro[žz][ií]vaj[íi]|pot[řr]ebuj[íi]|maj[íi]|spou[sš]t[íi]|identifikuj[íi]|ztoto[zž][nň]uj[íi])\b|jejich\s+(?:[úu]zkost|strach|stav|pro[žz][ií]v[aá]n[íi]|pot[řr]eba|reakce)\s+[^.!?\n]{0,80}\b(?:je|ukazuje|znamen[aá]|souvis[íi])\b|vnit[řr]n[íi]\s+(?:sv[ěe]t|po[zž][aá]r|pr[aá]ce|stav)\b|nen[íi]\s+jen\s+(?:informace|zpr[aá]va|ud[aá]lost|zv[ií][řr]e))/i;
const REAL_WORLD_FACT_INPUT_PATTERN = /(skute[čc]n(?:[áaéeý]|ou)|re[aá]ln(?:[áaéeý]|ou)|aktu[aá]ln[íi]|zpr[aá]v[ayu]|odkaz|url|https?:\/\/|nen[íi]\s+to\s+(?:symbol|projekce|fiktivn[íi])|nepochopil\s+jsi\s+situaci|z[aá]chrann(?:[áaý]|ou)|telefon[aá]t|[úu]mrt[íi]|ztr[aá]t[au]|v[aá]lk[ay]|po[žz][aá]r|nemoc|zdravotn[íi]\s+ud[aá]lost|[čc]l[aá]nek|rybi[čc]k|tim+m[iy]|kepork|velryb)/i;

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
  const realWorldFactInput = REAL_WORLD_FACT_INPUT_PATTERN.test(userInput || "");
  if (!explicitBriefing && INLINE_BRIEFING_PATTERN.test(output || "")) reasons.push("inline_daily_briefing");
  if (/2\.\s*kv[ěe]tna/i.test(output || "") && !/2\.\s*kv[ěe]tna/i.test(userInput || "")) reasons.push("wrong_date_may_2");
  if (OVERSTRONG_EVIDENCE_PATTERN.test(output || "")) reasons.push("overstrong_evidence_claim");
  if (realWorldFactInput && EXTERNAL_FACT_OVERINTERPRETATION_PATTERN.test(output || "")) reasons.push("external_fact_overinterpretation");
  if (realWorldFactInput && EXTERNAL_FACT_CHILD_STATE_CLAIM_PATTERN.test(output || "")) reasons.push("external_fact_child_state_claim");
  if (!reasons.length) return { text: output, replaced: false, reasons };
  if (realWorldFactInput) {
    const fishContext = /rybi[čc]k|tim+m[iy]|kepork|velryb/i.test(`${userInput}\n${output}`);
    return {
      replaced: true,
      reasons,
      text: fishContext ? `Hani, myslíš Timmiho/keporkaka a to, jak kluci včera sledovali reálnou záchrannou situaci. Je to skutečná aktuální situace a budu ji držet jako skutečnou událost a emoční kontext, ne jako projekci ani závěr o klucích.

Nevyvodím z toho význam bez závěru bez vlastní reakce kluků. Dnes bych šel jemně: nejdřív ověřit, co o tom sami říkají, co cítí v těle, jestli jsou zahlcení a co by teď potřebovali, aby zůstali tady a v bezpečí.` : `Hani, rozumím. Je to skutečná aktuální situace a důležitý emoční kontext, ne automatický závěr o klucích.

Nebudu z toho dělat klinický význam bez závěru bez vlastní reakce kluků. Stojí za to jemně ověřit: co o té situaci sami říkají, co cítí v těle, jestli jsou zahlcení, co by teď potřebovali a co jim pomáhá zůstat tady a v bezpečí.`,
    };
  }
  return {
    replaced: true,
    reasons,
    text: `Hani, rozumím. Tohle je pro kluky důležité a zároveň citlivé. Tady v osobním vlákně ti odpovím lidsky a klidně; interní terapeutické zpracování si Karel udělá na pozadí, bez toho, aby ti do osobního chatu vkládal briefing.

Držím se dnešního data (${currentDate}) a budu to brát opatrně: jako Hančino sdělení a faktický/terapeutický kontext, ne jako jistý závěr o dětech bez jejich vlastní reakce.`,
  };
}