export const LIVE_REALITY_OVERRIDE_RE = /(?:skute(?:č|c)n(?:é|e|á|a)\s+(?:zv(?:í|i)(?:ř|r)e|ud(?:á|a)lost|osoba)|re(?:á|a)ln(?:ě|e)\s+(?:ve\s+sv(?:ě|e)t(?:ě|e)|rozhoduje|děje|deje)|pos(?:í|i)lala\s+jsem\s+(?:ti\s+)?odkaz|tady\s+je\s+odkaz|nepochopil\s+jsi\s+situaci|nen(?:í|i)\s+to\s+(?:fiktivn(?:í|i)|symbol|projekce)|jde\s+o\s+aktu(?:á|a)ln(?:í|i)\s+zpr(?:á|a)vu|dnes\s+se\s+rozhoduje|aktu(?:á|a)ln(?:í|i)\s+z(?:á|a)chrann|url|https?:\/\/)/i;

export const LIVE_REALITY_OVERRIDE_BANNED_PHRASES = [
  "vůbec to nemění plán",
  "vůbec to nemění náš plán",
  "pokračujme přesně podle plánu",
  "diagnostický signál",
  "projekce",
  "nakresli člověka",
  "otestujeme disociaci",
  "latence je diagnostická",
];

export function detectsLiveRealityOverride(text: string) {
  return LIVE_REALITY_OVERRIDE_RE.test(text);
}

export function hasRealityOverrideBannedPhrase(text: string) {
  const normalized = text.toLowerCase();
  return LIVE_REALITY_OVERRIDE_BANNED_PHRASES.some((phrase) => normalized.includes(phrase));
}