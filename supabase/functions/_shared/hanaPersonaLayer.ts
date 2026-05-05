/**
 * P28 EFGH — Hana persona layer + opening strategy.
 * Pure functions, no side effects.
 */

export const KAREL_PERSONA_LAYER_HANA_PERSONAL = `
═══ KAREL_PERSONA_LAYER_HANA_PERSONAL ═══
Karel je v Hana/osobní režimu:
- teplý, konkrétní, vztahově přítomný
- psychologicky inteligentní
- Jungovsky inspirovaný v práci s obrazem, vinou, stínem, protiklady, smyslem a vnitřní integrací
- nesmí být teatrální
- nesmí používat těžkou analytickou řeč, pokud Hanka potřebuje jen držení
- nesmí začínat úředními větami ("objevilo se téma kolem části…", "v tvém včerejším osobním rozhovoru se objevilo...")
- může použít jemnou symbolickou metaforu, pokud to pomáhá stabilizaci
- může nabídnout aktivní imaginaci / krátké vnitřní cvičení jen když je Hanka stabilní a souhlasí

POVOLENÉ:
"To, co v tobě nese vinu, nemusíme hned přesvědčovat. Nejdřív ho můžeme jen posadit vedle nás, aby nebylo samo."

ZAKÁZANÉ:
- "Jako Jung bych řekl..."
- "Ve své knize jsem napsal..."
- jakékoliv fake citace nebo fake historické vzpomínky
- věty začínající "ve včerejším osobním rozhovoru se objevilo téma kolem části..."
`.trim();

export type OpeningStrategy = "very_soft" | "direct_but_warm" | "if_she_seems_avoidant";

export interface OpeningSelection {
  strategy: OpeningStrategy;
  candidate: string;
  why: string;
  avoids: string[];
  may_bridge_to_later: string[];
}

export interface HanaDeepMemory {
  id: string;
  memory_type: string;
  payload: Record<string, any>;
}

const GENERIC_OPENING_PATTERNS: RegExp[] = [
  /t[ée]ma\s+kolem\s+[čc][áa]sti/i,
  /ve\s+v[čc]erej[šs][íi]m\s+osobn[íi]m\s+rozhovoru/i,
  /objevilo\s+se\s+t[ée]ma/i,
];

export function isGenericOpening(text: string): boolean {
  return GENERIC_OPENING_PATTERNS.some((re) => re.test(text || ""));
}

export function selectOpeningStrategy(
  firstUserMessage: string,
  candidates: { very_soft?: string; direct_but_warm?: string; if_she_seems_avoidant?: string },
): OpeningSelection | null {
  const txt = String(firstUserMessage || "").trim();
  const len = txt.length;

  // Heuristics
  const mentionsGuilt = /vin[aěuy]|tundrup|gustav|k\.?\s*g\.?|truchl|t[íi]ha|smutek/i.test(txt);
  const avoidant = /poj[ďd]me\s+(?:o\s+n[ěe][čc]em\s+)?jin[ée]m|nechci\s+(?:dnes\s+)?o\s+tom|rad[šs]i\s+ne|zm[ěe][nň]me\s+t[ée]ma|jak\s+se\s+m[áa][šs]\?$/i.test(txt);

  let strategy: OpeningStrategy = "very_soft";
  let why = "Krátký nebo neutrální vstup → měkký, přítomný start bez okamžitého návratu k těžkému tématu.";

  if (avoidant && candidates.if_she_seems_avoidant) {
    strategy = "if_she_seems_avoidant";
    why = "Vstup naznačuje vyhnutí se / změnu tématu → respektovat to, jen tiše signalizovat, že Karel nezapomněl.";
  } else if (mentionsGuilt && candidates.direct_but_warm) {
    strategy = "direct_but_warm";
    why = "Hanka sama navazuje na vinu/Tundrupa/K.G. → jemně, ale přímo otevřít téma.";
  } else if (len < 80 && candidates.very_soft) {
    strategy = "very_soft";
  } else if (candidates.very_soft) {
    strategy = "very_soft";
  } else {
    return null;
  }

  const candidate = candidates[strategy];
  if (!candidate) return null;

  return {
    strategy,
    candidate,
    why,
    avoids: [
      "generický úřední start ('téma kolem části…')",
      "rychlé popření viny",
      "tlak na okamžitý návrat k těžkému tématu",
    ],
    may_bridge_to_later: [
      "ověření těla/dechu/tíhy",
      "jemné připomenutí včerejšího bodu pouze pokud Hanka dovolí",
      "nabídka držení místo analýzy",
    ],
  };
}

export interface BuildContextBlocksInput {
  memories: HanaDeepMemory[];
  firstUserMessage?: string;
}

export interface ContextBlocksOutput {
  text: string;
  loaded_memory_ids: string[];
  opening_selection: OpeningSelection | null;
  has_shared_relational: boolean;
}

export function buildHanaDeepContextBlocks(input: BuildContextBlocksInput): ContextBlocksOutput {
  const { memories, firstUserMessage = "" } = input;
  const loaded_memory_ids: string[] = [];
  const lines: string[] = [];

  const continuity = memories.find(
    (m) => m.memory_type === "hana_emotional_state" && m.payload && Object.keys(m.payload).length > 0,
  );
  const shared = memories.find((m) => m.memory_type === "shared_relational_memory_candidate");

  let opening_selection: OpeningSelection | null = null;

  if (continuity) {
    loaded_memory_ids.push(continuity.id);
    const p = continuity.payload || {};
    const sig = Array.isArray(p.emotional_signature) ? p.emotional_signature.join(", ") : "";
    const themes = Array.isArray(p.dominant_themes) ? p.dominant_themes.join(", ") : "";
    const wnts = Array.isArray(p.what_not_to_say) ? p.what_not_to_say.map((s: string) => `- ${s}`).join("\n") : "";
    const wtag = Array.isArray(p.what_to_approach_gently) ? p.what_to_approach_gently.map((s: string) => `- ${s}`).join("\n") : "";

    lines.push(`═══ KAREL_HANA_EMOTIONAL_CONTINUITY ═══
Emoční signatura: ${sig || "(není)"}
Dominantní témata: ${themes || "(není)"}
Vnitřní konflikt: ${p.unresolved_inner_conflict || "(není)"}
Ochranná potřeba: ${p.protective_need || "(není)"}
Vztahová potřeba: ${p.relational_need || "(není)"}
Oblouk hovoru: ${p.conversation_arc_suggestion || "(není)"}`);

    if (wnts) lines.push(`═══ WHAT_NOT_TO_SAY ═══\n${wnts}`);
    if (wtag) lines.push(`═══ WHAT_TO_APPROACH_GENTLY ═══\n${wtag}`);

    const candidates = (p.opening_candidates || {}) as any;
    opening_selection = selectOpeningStrategy(firstUserMessage, candidates);

    if (opening_selection) {
      lines.push(`═══ KAREL_NEXT_OPENING_STRATEGY ═══
Strategie: ${opening_selection.strategy}
Doporučený opening (použij přesně nebo téměř přesně, neopisuj genericky): "${opening_selection.candidate}"
Proč právě tahle strategie: ${opening_selection.why}
Čemu se vyhnout: ${opening_selection.avoids.join(" | ")}
Na co lze později jemně navázat: ${opening_selection.may_bridge_to_later.join(" | ")}`);
    } else if (candidates && Object.keys(candidates).length > 0) {
      lines.push(`═══ KAREL_NEXT_OPENING_STRATEGY ═══
K dispozici jsou opening kandidáti: ${Object.keys(candidates).join(", ")}.
Vyber podle vstupu Hany — nikdy nezačínej genericky ("téma kolem části…").`);
    }
  }

  if (shared) {
    loaded_memory_ids.push(shared.id);
    const p = shared.payload || {};
    lines.push(`═══ KAREL_SHARED_RELATIONAL_MEMORY_HANA_ONLY ═══
visibility: ${p.visibility || "hana_only"}
never_export_to_did: ${p.never_export_to_did === true ? "true" : "true (forced)"}
never_external_fact: true
Symbolická kotva: ${p.symbolic_anchor || "(není)"}
Emoční význam: ${p.emotional_meaning || "(není)"}
Bezpečná věta, kterou Karel může použít: "${p.safe_phrase_karel_may_use || ""}"
Kdy použít: ${p.when_to_use || ""}
Kdy NEpoužít: ${p.when_not_to_use || ""}
TENTO blok je výhradně Hana-only. NIKDY nepřenášet do DID/kluci, do karet částí, ani jako externí fakt.`);
  }

  return {
    text: lines.join("\n\n"),
    loaded_memory_ids,
    opening_selection,
    has_shared_relational: !!shared,
  };
}
