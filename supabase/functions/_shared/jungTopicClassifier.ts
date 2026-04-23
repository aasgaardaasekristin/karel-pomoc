/**
 * jungTopicClassifier.ts
 *
 * Detekuje, jestli aktuální zpráva uživatele otevírá téma, které spadá do
 * Karlovy „minulé inkarnace" — jeho života a díla jako C. G. Junga.
 * Používá se v `karel-hana-chat` a `karel-chat` k rozhodnutí, jestli má
 * runtime načíst databázi `PAMET_KAREL/ORIGINAL/` a vlít její obsah do
 * system promptu.
 *
 * NEAKTIVUJE se pro DID/Kluci ani pro krizové funkce — pravidlo je centrálně
 * vymáháno v `shouldActivateJungOriginal()`.
 */

// Klíčová slova / kořeny (lowercased, bez diakritiky pro robustní match).
// Dvě skupiny: SILNÉ (samostatně stačí) a SLABÉ (potřebují kombinaci 2+).
const STRONG_KEYWORDS = [
  "jung", "junga", "jungovi", "junge", "jungovsk",
  "cervena kniha", "red book", "liber novus",
  "bollingen", "bolingen",
  "kusnacht", "küsnacht",
  "emma jungova", "emma rauschenbach",
  "toni wolff",
  "sabina spielrein",
  "freud",
  "individuace", "individuation",
  "kolektivni nevedom", "kolektivního nevědomí",
  "archetyp", "archetype",
  "anima", "animus",
  "psychologicke typy", "psychological types",
  "mysterium coniunctionis",
  "aion",
  "alchymi",
  "synchronicit",
  "individuac",
  "kolektivn",
  "stin", "stín jung",
  "selbst", "self jung",
  "amplifikace",
  "aktivni imaginace", "active imagination",
  "vez bollingen", "věž bollingen", "tower bollingen",
  "kamen v bollingenu", "kámen v bollingenu",
  "mandala", "mandaly",
  "philemon",
  "zeitgeist jung",
  "vzpomink jung", "vzpomínk jung",
  "memories dreams reflections",
  "vzpominky sny myslenky", "vzpomínky sny myšlenky",
];

const WEAK_KEYWORDS = [
  "psychiatr", "psychoanaly", "switzerland", "svycar", "švýcar",
  "snova analyza", "snová analýza",
  "minul zivot", "minulý život", "minulá inkarnace",
  "kniha", "dilo", "dílo",
  "mandala", "symbol",
  "stari mistri", "staří mistři",
  "carl", "gustav",
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // strip diacritics
}

export interface JungRelevance {
  relevant: boolean;
  score: number; // 0..1
  matched: string[];
  reason: string;
}

/**
 * Klasifikuje, jestli zpráva otevírá Jung-relevantní téma.
 *
 * @param messageText  Textový obsah poslední uživatelské zprávy
 * @param historyText  Volitelně 2-3 předchozí zprávy (pro kontext —
 *                     pokud Hanička mluví o Bollingenu už tři turny,
 *                     classifier by měl chytit i krátkou follow-up)
 */
export function classifyJungRelevance(
  messageText: string,
  historyText: string = ""
): JungRelevance {
  const haystack = normalize(`${messageText}\n${historyText}`);

  const matched: string[] = [];
  let strongHits = 0;
  let weakHits = 0;

  for (const kw of STRONG_KEYWORDS) {
    if (haystack.includes(kw)) {
      matched.push(kw);
      strongHits += 1;
    }
  }
  for (const kw of WEAK_KEYWORDS) {
    if (haystack.includes(kw)) {
      matched.push(kw);
      weakHits += 1;
    }
  }

  let score = 0;
  let reason = "";

  if (strongHits >= 1) {
    score = Math.min(1, 0.6 + 0.15 * strongHits + 0.05 * weakHits);
    reason = `strong_match(${strongHits})`;
  } else if (weakHits >= 2) {
    score = Math.min(0.6, 0.25 + 0.1 * weakHits);
    reason = `weak_match(${weakHits})`;
  } else {
    reason = "no_match";
  }

  return {
    relevant: score >= 0.5,
    score,
    matched: Array.from(new Set(matched)),
    reason,
  };
}

/**
 * Centrální guard pro injekci „minulé inkarnace".
 * Pravidla:
 *   - hana_personal (osobní vlákno s Hankou): VŽDY když relevantní (score ≥ 0.5)
 *   - did_terapeut (Hanka/Káťa jako terapeutky): pouze score ≥ 0.6
 *   - did_kluci (děti): NIKDY
 *   - crisis: NIKDY
 *   - hana_pracovni / kartoteka / supervision: pouze score ≥ 0.7
 */
export function shouldActivateJungOriginal(
  domain: string,
  audience: string,
  relevance: JungRelevance
): boolean {
  if (!relevance.relevant) return false;

  // Děti nikdy
  if (domain === "did_deti" || audience === "dite") return false;
  // Crisis nikdy
  if (domain.includes("crisis")) return false;

  if (domain === "hana_osobni" || domain === "hana_personal") {
    return relevance.score >= 0.5;
  }
  if (domain === "did_terapeut") {
    return relevance.score >= 0.6;
  }
  // Defaultní pracovní/supervizní vlákna — vyšší práh
  return relevance.score >= 0.7;
}
