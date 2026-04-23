/**
 * therapeuticToolbox.ts — slovník hravých terapeutických nástrojů
 * pro generování session plánu (Karel + Hanička/Káťa).
 *
 * Účel: Karel při tvorbě návrhu sezení (briefing.proposed_session +
 * deliberation.program_draft) MUSÍ čerpat z konkrétních terapeutických
 * technik — ne psát suché "úvod / práce / uzávěr" bloky. Tento katalog
 * je injektován do system promptů, aby Karel měl po ruce hravý jazyk
 * a konkrétní nástroje C. G. Junga + moderní traumaterapie přizpůsobené
 * remote-native (chat / audio / kresba do screenu / fotka).
 *
 * Důležité: NE všechny nástroje se hodí pro každou část. Karel vybere
 * 2–4 podle: věk části (kluk vs. dospělý insider), aktuální stav
 * (krize/stabilní/explorace), předchozí zkušenost, a doporučení Pantry A.
 *
 * Také NEFYZICKÉ — herna je remote (přes obrazovku). Žádné balónky,
 * žádný papír v ruce terapeuta. Vše skrz chat, hlas, foto kresby,
 * škály, asociace, slovní hry.
 */

export interface TherapeuticTool {
  id: string;
  name: string;
  category: "association" | "projective" | "imagery" | "play" | "narrative" | "somatic" | "art" | "scaling" | "graphology";
  short: string;
  remote_adaptation: string;
  best_for: string[];
  jung_lineage?: string;
}

export const THERAPEUTIC_TOOLBOX: TherapeuticTool[] = [
  // ── ASOCIATIVNÍ (Jungovo originál: Word Association Test 1904) ──
  {
    id: "wat",
    name: "Asociační test (Word Association)",
    category: "association",
    short: "Karel napíše 6–10 slov, část odpovídá první asociací + reakční dobou. Najde komplexy.",
    remote_adaptation: "Slova v chatu, jedno po druhém. Měříme délku odpovědi. Zaseknutí = signál komplexu.",
    best_for: ["explorace", "skryté komplexy", "rezistence k přímým otázkám"],
    jung_lineage: "Jung 1904, Burghölzli — původní empirický důkaz nevědomí",
  },
  {
    id: "barvy_dnes",
    name: "Barva dne",
    category: "association",
    short: "Jaká barva má dnes/tvůj pocit/tahle situace? A co za tou barvou stojí?",
    remote_adaptation: "Jen slovně v chatu, nebo nahrání hlasu. Případně může nakreslit čáru té barvy ve screenu.",
    best_for: ["malé části", "alexithymie", "úvodní rozjezd"],
  },

  // ── PROJEKTIVNÍ ──
  {
    id: "rorschach_lite",
    name: "Skvrny / oblaka (Rorschach lite)",
    category: "projective",
    short: "Karel pošle obrázek skvrny nebo mraku, část popisuje co vidí. Projekce vnitřních obrazů.",
    remote_adaptation: "Karel posílá obrázek do chatu (ze sady připravených), část popisuje slovně.",
    best_for: ["projektivní materiál", "starší části", "dlouhodobé sledování"],
    jung_lineage: "Rorschach 1921 byl Jungovým žákem; Jung sám pracoval s aktivní imaginací",
  },
  {
    id: "tat_lite",
    name: "Příběh k obrázku (TAT lite)",
    category: "projective",
    short: "Karel pošle scénu (fotku, kresbu), část si vymyslí příběh: kdo je tam, co se stalo před, co bude.",
    remote_adaptation: "Obrázek do chatu, odpověď psaná nebo nahraná hlasem.",
    best_for: ["narrativní části", "vztahové vzorce", "explorace dynamiky"],
  },

  // ── AKTIVNÍ IMAGINACE (Jungovo jádro) ──
  {
    id: "active_imagination",
    name: "Aktivní imaginace",
    category: "imagery",
    short: "Vyvolaný vnitřní obraz / postava, dialog s ní. Část popisuje co se děje krok po kroku.",
    remote_adaptation: "Karel vede otázkami v chatu nebo nechá část nahrát monolog. Žádný spěch, krátké pauzy.",
    best_for: ["explorace insiderů", "dialog s vnitřní postavou", "integrace"],
    jung_lineage: "Jung Liber Novus (Červená kniha) — autoportrét aktivní imaginace 1913–1930",
  },
  {
    id: "safe_place",
    name: "Bezpečné místo",
    category: "imagery",
    short: "Vyvolání představy místa, kam se část může mentálně schovat. Detaily smyslů: co vidí, slyší, cítí.",
    remote_adaptation: "Vedeno hlasem/chatem, část odpovídá útržkovitě. Lze si nakreslit a vyfotit do appky.",
    best_for: ["stabilizace v krizi", "úvod do těžších témat", "uzávěr sezení"],
  },

  // ── HRA ──
  {
    id: "what_if",
    name: "Co kdyby…",
    category: "play",
    short: "Hypotetické scény: co kdybys byl zvíře / byl jsi neviditelný / měl jsi superschopnost?",
    remote_adaptation: "Volný dialog v chatu, Karel reaguje hravě.",
    best_for: ["malé chlapecké části", "rozjezd", "nepřímý přístup k tématu"],
  },
  {
    id: "world_building",
    name: "Stavba světa",
    category: "play",
    short: "Část si vymýšlí a popisuje vlastní svět — pravidla, obyvatele, místo. Postupně do toho vkládá svoje témata.",
    remote_adaptation: "Volné psaní v chatu, kresby do screenu. Vrací se napříč sezeními.",
    best_for: ["dlouhodobá práce", "tvořivé části", "Tundrupek-typ"],
  },

  // ── NARRATIVNÍ ──
  {
    id: "tri_dvere",
    name: "Tři dveře",
    category: "narrative",
    short: "Před tebou jsou tři dveře. Které zvolíš? Co je za nimi? Proč právě tyhle?",
    remote_adaptation: "Slovně v chatu nebo Karel pošle obrázek tří dveří, část odpovídá.",
    best_for: ["rozhodnutí", "explorace volby", "uzávěr fáze"],
  },
  {
    id: "deset_let",
    name: "Já za 10 let / Já před 10 lety",
    category: "narrative",
    short: "Co bys řekl tomu mladšímu / staršímu sobě? Co by řekl on tobě?",
    remote_adaptation: "Volné psaní nebo nahrání hlasu.",
    best_for: ["temporal perspective", "integrace", "starší části"],
  },

  // ── SOMATICKÉ (remote-friendly varianty) ──
  {
    id: "skala_telo",
    name: "Tělesná škála 1–10",
    category: "scaling",
    short: "Kde v těle to teď cítíš? Jak silné to je 1–10? Jaký to má tvar / barvu / teplotu?",
    remote_adaptation: "Jednoduchá výměna v chatu, opakovat 2–3× za sezení pro tracking.",
    best_for: ["tracking arousal", "psychosomatika", "stabilizace"],
  },
  {
    id: "grounding_5_4_3_2_1",
    name: "Grounding 5-4-3-2-1",
    category: "somatic",
    short: "5 věcí co vidíš, 4 co slyšíš, 3 co cítíš dotykem, 2 vůně, 1 chuť. Návrat do tady-a-teď.",
    remote_adaptation: "Karel vede v chatu, část odpovídá útržkovitě. Funguje při dissociaci.",
    best_for: ["dissociace v sezení", "úvod / uzávěr", "krize"],
  },

  // ── ART ──
  {
    id: "kresba_dnes",
    name: "Kresba „Jak je dnes uvnitř“",
    category: "art",
    short: "Část nakreslí na papír / do screenu jednu věc co vyjadřuje aktuální stav. Pak ji popíše slovy.",
    remote_adaptation: "Kresba do appky (canvas) nebo papír + foto. Popis hlasem nebo psaním.",
    best_for: ["alexithymie", "výtvarné části", "děti"],
  },
  {
    id: "mandala",
    name: "Mandala (volná kruhová kresba)",
    category: "art",
    short: "V kruhu cokoli, co teď chce ven. Pak hledáme střed, hranice, opakované motivy.",
    remote_adaptation: "Papír + foto do chatu. Karel reflektuje strukturu, ne obsah.",
    best_for: ["integrace", "uzávěr fáze", "Self-symbolika"],
    jung_lineage: "Jung mandala jako symbol Self — Bollingen kresby",
  },

  // ── GRAFOLOGIE / RUKOPIS ──
  {
    id: "rukopis_vzorek",
    name: "Vzorek rukopisu",
    category: "graphology",
    short: "Část napíše rukou krátkou větu, vyfotí. Karel sleduje změny tlaku, sklonu, velikosti mezi částmi.",
    remote_adaptation: "Foto rukopisu do chatu. Užitečné pro odlišení insiderů a sledování stavu napříč dny.",
    best_for: ["identifikace přepnutí", "tracking parts", "starší práce"],
  },
];

export function summarizeToolboxForPrompt(): string {
  const byCategory = new Map<string, TherapeuticTool[]>();
  for (const t of THERAPEUTIC_TOOLBOX) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category)!.push(t);
  }
  const lines: string[] = [
    "═══ TERAPEUTICKÝ ARZENÁL (vyber 2–4 nástroje pro tento konkrétní program) ═══",
    "Pravidlo: program MUSÍ obsahovat alespoň 2 konkrétní hravé nástroje z tohoto seznamu.",
    "NE generická slova jako „práce s emocemi", „rozhovor", „reflexe". VŽDY pojmenuj konkrétní nástroj.",
    "Vše remote-native (chat / hlas / foto kresby / screen canvas) — NIKDY fyzické pomůcky v ruce terapeuta.",
    "",
  ];
  for (const [cat, tools] of byCategory) {
    lines.push(`── ${cat.toUpperCase()} ──`);
    for (const t of tools) {
      const jung = t.jung_lineage ? ` ⟨${t.jung_lineage}⟩` : "";
      lines.push(`• ${t.name} [id:${t.id}] — ${t.short}${jung}`);
      lines.push(`  · remote: ${t.remote_adaptation}`);
      lines.push(`  · vhodné pro: ${t.best_for.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Krátký heuristický výběr — když potřebujeme přednastavit Karlovu pozornost
 * podle aktuálního stavu části (z PIF nebo z briefing kontextu).
 */
export function preselectToolsByState(stateHint: {
  in_crisis?: boolean;
  age_band?: "child" | "teen" | "adult" | "unknown";
  prefers_art?: boolean;
  alexithymia?: boolean;
}): TherapeuticTool[] {
  const picks: TherapeuticTool[] = [];
  if (stateHint.in_crisis) {
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "grounding_5_4_3_2_1")!);
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "safe_place")!);
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "skala_telo")!);
  }
  if (stateHint.age_band === "child") {
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "what_if")!);
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "barvy_dnes")!);
  }
  if (stateHint.prefers_art || stateHint.alexithymia) {
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "kresba_dnes")!);
    picks.push(THERAPEUTIC_TOOLBOX.find((t) => t.id === "mandala")!);
  }
  return picks.filter((t, i, a) => a.indexOf(t) === i);
}
