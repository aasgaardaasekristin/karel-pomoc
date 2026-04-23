/**
 * Clinical Playbooks (shared)
 * ---------------------------
 * Pevná knihovna profesionálních diagnostických protokolů.
 * Karel je MUSÍ dodržet — toto je rámec, který vyrobí klinické podmínky
 * a zabrání jeho "improvizaci" do obecných frází.
 *
 * Každý playbook má pevnou strukturu (viz typ Playbook).
 * Inspirace v reálných manuálech (Jung asociační experiment, Machover DAP,
 * Koch Baum, Buck HTP, Burns KFD, CAT, sandtray Lowenfeld).
 *
 * Důležité: NEsimulujeme reálné testy 1:1 (na to nejsou data ani validace),
 * ale vynucujeme STANDARDNÍ podmínky a STANDARDNÍ pozorovací kritéria,
 * aby Karlova pozdější analýza byla validní a ne plácaná.
 */

export type PlaybookPhase =
  | "setup"
  | "running"
  | "trauma_pause"
  | "closure"
  | "done";

export type Playbook = {
  method_id: string;
  method_label: string;
  source_refs: string[];
  pre_session_setup: {
    supplies: string[];
    room: string;
    therapist_position: string;
    child_position: string;
    what_to_say_first: string;
    what_NOT_to_say: string[];
    measurements_required: string[]; // co zapisovat každý turn
  };
  step_protocol: {
    /** Když je kind="sequence_words", planned_steps je pole stimulů. */
    kind: "sequence_words" | "drawing_phases" | "open_dialog" | "narrative" | "play";
    planned_steps?: string[]; // např. asoc. slova
    instruction: string;      // co dělat na každém kroku
    what_to_record: string[]; // doslovná odpověď, latence, mimika...
    red_flags: string[];      // kdy přepnout do trauma_pause
  };
  trauma_response_protocol: {
    signs: string[];
    immediate_actions: string[];
    do_not_repeat_stimulus: boolean; // u asociací NIKDY znovu stejné slovo
    grounding_script: string;
  };
  closure_protocol: {
    reproduction_check: string | null; // např. `po pauze zopakuj slova`
    debrief_questions: string[];
    grounding: string;
  };
  required_artifacts: ("image" | "audio" | "text" | "verbatim_log" | "latency_log")[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 1) JUNG ASOCIAČNÍ EXPERIMENT (zkrácený 8slovný dětský variant)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_association_experiment_jung: Playbook = {
  method_id: "association_experiment_jung",
  method_label: `Asociační experiment (Jung) — dětský zkrácený protokol 8 slov`,
  source_refs: [
    `C. G. Jung — Studies in Word Association (1906)`,
    `Bohm — Lehrbuch der Rorschach-Psychodiagnostik (kontext indikátorů komplexu)`,
  ],
  pre_session_setup: {
    supplies: [
      `stopky / mobil se stopkami (povinné — měříme latenci v sekundách)`,
      `papír A4 + tužka — DOSLOVNÝ zápis odpovědí`,
      `tichá místnost bez rušivých podnětů`,
      `voda pro dítě`,
    ],
    room: `klid, žádné zrcadlo proti dítěti, mírné světlo`,
    therapist_position: `naproti dítěti, oční kontakt, ne příliš blízko`,
    child_position: `pohodlně, nohy na zemi, ruce volně`,
    what_to_say_first:
      "Řekni přesně: »Tundrupku, budeme spolu hrát hru se slovy. Já ti řeknu jedno slovo a ty mi hned řekni první slovo, které tě napadne. Nemusíš o tom přemýšlet, není správná ani špatná odpověď. Začínáme?«",
    what_NOT_to_say: [
      `Nepokládej navádějící otázky (např. A co rodina?)`,
      `Nehodnoť odpovědi (např. Hezky., Aha to je zajímavé.)`,
      `Neopakuj slovo, pokud mlčí — počkej až 30 s a zapiš pauzu`,
      `Nediskutuj odpověď uprostřed — všechno až v debriefu`,
    ],
    measurements_required: [
      `doslovná odpověď (verbatim, slovo od slova)`,
      `latence v sekundách (od konce tvého slova po začátek odpovědi)`,
      `afekt (neutrální / napětí / úzkost / pláč / smích / ztuhnutí / mlčení)`,
      `neverbální (mimika, dech, postoj, červenání, slzy, mrknutí)`,
    ],
  },
  step_protocol: {
    kind: "sequence_words",
    // planned_steps doplňuje dynamicky karel-live-session-produce na míru bodu programu
    planned_steps: undefined,
    instruction:
      `Řekni přesně jedno slovo, klidně, neutrálním tónem. Spusť stopky. Doslovně zapiš první odpověď dítěte. Zaznamenej latenci a afekt. Pokud dítě mlčí > 30 s, zapiš »odmlka 30+ s` a přejdi k dalšímu slovu BEZ opakování.``,
    what_to_record: [
      "verbatim",
      "latency_seconds",
      "affect",
      "nonverbal",
      "therapist_note",
    ],
    red_flags: [
      `prodloužení latence > 8 s u afektivního slova (indikátor komplexu)`,
      `perseverace (opakování předchozí odpovědi)`,
      `klangová odpověď (rýmování) — známka úniku`,
      `odmítnutí odpovědět`,
      `vegetativní reakce (zčervenání, slzy, ztuhnutí, dech)`,
      `změna hlasu nebo pozice těla`,
      `explicitní zmínka traumatu, flashbacku, týrání`,
    ],
  },
  trauma_response_protocol: {
    signs: [
      `dítě pláče, ztuhne, zbledne, schová se`,
      `terapeutka popíše flashback nebo trauma vazbu`,
      `disociativní příznaky (prázdný pohled, pomalé tempo, ztráta kontaktu)`,
      `explicitní spojení slova s týráním v anamnéze`,
    ],
    immediate_actions: [
      `PŘERUŠ sekvenci slov — žádný další stimul`,
      `Validuj nález terapeutce (»to co popisuješ je klinicky významné, je to indikátor komplexu vázaného k tématu, NE selhání`)``,
      `Dej terapeutce přesný grounding skript pro dítě`,
      `Rozhodni: pokračovat / zvolnit / zcela přerušit (a proč)`,
      `Vyžaduj zápis přesné formulace dítěte + neverbální projevy`,
    ],
    do_not_repeat_stimulus: true,
    grounding_script:
      'Přečti dítěti klidně: »Tundrupku, jsi tady se mnou, jsme v bezpečí. Zhluboka se nadechni se mnou — nádech, výdech. Pojmenuj mi tři věci, které vidíš v místnosti.` Počkej na odpovědi, oceň, pak pauza min. 3 minuty.'`,
  },
  closure_protocol: {
    reproduction_check:
      `Po dokončení 8 slov a pauze 5–10 min požádej dítě: »Vzpomeneš si, jaká slova jsme říkali? A co jsi na ně odpovídal?` Zapiš, která slova/odpovědi si nepamatuje (reprodukční chyba = silný indikátor komplexu).``,
    debrief_questions: [
      `Jak ti to šlo?`,
      `Bylo nějaké slovo, u kterého ti bylo divně?`,
      `Chceš mi k něčemu něco dovyprávět?`,
    ],
    grounding:
      `Zakončete krátkou klidnou aktivitou (oblíbená hračka, voda, pohyb) — neodcházej hned k dalšímu testu.`,
  },
  required_artifacts: ["audio", "verbatim_log", "latency_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) KRESBA POSTAVY (Machover Draw-A-Person)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_draw_a_person_machover: Playbook = {
  method_id: "draw_a_person_machover",
  method_label: `Kresba postavy (Machover DAP)`,
  source_refs: [
    `Machover — Personality Projection in the Drawing of the Human Figure (1949)`,
    `Goodenough-Harris Drawing Test (vývojové normy)`,
  ],
  pre_session_setup: {
    supplies: [
      `tužka HB č.2 (BEZ gumy)`,
      `papír A4 nelinkovaný, bílý, na šířku`,
      `plochý stůl, dobré světlo`,
    ],
    room: `klidné prostředí`,
    therapist_position: `z boku, ne přímo nad dítětem, mlčky pozoruj`,
    child_position: `u stolu, papír před sebou`,
    what_to_say_first:
      'Řekni přesně: »Tundrupku, nakresli mi prosím postavu. Kohokoliv, kdo tě napadne. Není to o tom, jestli to bude hezké.` Pak mlčky pozoruj, NEzasahuj.'`,
    what_NOT_to_say: [
      `Nedávej nápovědu (např. Můžeš nakreslit chlapce.)`,
      `Nekomentuj průběh (např. Hezké vlasy.)`,
      `Neopravuj (např. Chybí ti uši.)`,
    ],
    measurements_required: [
      `pořadí kreslení (která část jako první, druhá…)`,
      `umístění na papíru (střed / dolní třetina / okraj / roh)`,
      `tlak tužky (silný / slabý / kolísavý)`,
      `škrtání, mazání (kde, kolikrát)`,
      `velikost postavy (mm výška)`,
      `vynechané části (oči, ústa, ruce, prsty, uši, krk)`,
      `pohlaví / věk postavy (pokud sdělí)`,
      `výraz tváře`,
    ],
  },
  step_protocol: {
    kind: "drawing_phases",
    instruction:
      `Fáze 1: nech kreslit nerušeně. Fáze 2 (po dokončení): post-drawing inquiry — klidným tónem se zeptej kdo to je, kolik je mu let, co dělá, jak se cítí. Doslova zapiš odpovědi.`,
    what_to_record: [
      "drawing_order",
      "placement",
      "pressure",
      "erasures",
      "size",
      "missing_parts",
      "post_drawing_inquiry_verbatim",
    ],
    red_flags: [
      `vynechané ruce / oči / ústa (možná disociativní marker)`,
      `neúměrně malá nebo velká postava`,
      `extrémní tlak nebo škrtání u určité části (sex. zóny, hlava)`,
      `nutkavé mazání`,
      `odmítnutí kresby`,
      `explicitní traumatický obsah`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč při určité části`, `ztuhnutí ruky`, `verbalizace traumatu`, `dramatické zničení kresby`],
    immediate_actions: [
      `Zastav inquiry, neptej se dál`,
      `Validuj (»to je důležitý vjem`)``,
      "Grounding",
      `Rozhodni o pokračování`,
    ],
    do_not_repeat_stimulus: false,
    grounding_script: `Klidně: Pojď na chvíli k oknu nebo se napij. Děkuji ti, že jsi mi to ukázal.'`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [
      `Co bys o té postavě ještě řekl?`,
      `Jak se ti to kreslilo?`,
    ],
    grounding: `krátká uvolňovací aktivita`,
  },
  required_artifacts: ["image", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 3) STROM (Koch Baumtest)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_tree_test_koch: Playbook = {
  method_id: "tree_test_koch_baum",
  method_label: `Test stromu (Koch Baumtest)`,
  source_refs: [`Karl Koch — Der Baumtest (1949)`],
  pre_session_setup: {
    supplies: [`tužka HB`, `A4 nelinkovaný papír (na výšku)`, "klid"],
    room: `klidné prostředí`,
    therapist_position: `z boku, mlčky pozoruj`,
    child_position: `u stolu`,
    what_to_say_first:
      'Řekni přesně: »Nakresli mi nějaký strom. Jakýkoli strom, který tě napadne.` Pak mlčky pozoruj.'`,
    what_NOT_to_say: [
      `Nespecifikuj druh ani roční období`,
      `Nehodnoť, neopravuj`,
    ],
    measurements_required: [
      `pořadí kreslení (kořeny, kmen, koruna)`,
      `umístění na papíru`,
      `velikost (mm)`,
      `tlak tužky`,
      `kořeny ano/ne, jak hluboko`,
      `kmen — šířka, struktura, dutiny, jizvy`,
      `koruna — symetrie, listí ano/ne, plody`,
      `okolí (zem, slunce, jiné objekty)`,
    ],
  },
  step_protocol: {
    kind: "drawing_phases",
    instruction:
      `Fáze 1: nech kreslit. Fáze 2: post-drawing — »kolik je tomu stromu let? jak se mu daří? co se mu stalo?`. Doslovný zápis.``,
    what_to_record: ["drawing_order", "placement", "size", "pressure", "tree_parts", "post_inquiry_verbatim"],
    red_flags: [
      `dutiny v kmeni (často trauma marker)`,
      `uschlé větve, opadané listí`,
      `extrémně malý strom v rohu`,
      `verbalizace traumatu (»tenhle strom někdo zlomil`)``,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, `verbalizace zranění stromu`, `ztuhnutí`],
    immediate_actions: ["validace", "grounding", `rozhodnutí`],
    do_not_repeat_stimulus: false,
    grounding_script: `Klidně přesun k bezpečné aktivitě.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Co tomu stromu přeješ?`],
    grounding: `krátká pauza`,
  },
  required_artifacts: ["image", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 4) DŮM-STROM-POSTAVA (Buck HTP)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_htp_buck: Playbook = {
  method_id: "htp_buck",
  method_label: `Dům-Strom-Postava (Buck HTP)`,
  source_refs: [`John Buck — H-T-P Technique (1948)`],
  pre_session_setup: {
    supplies: [`tužka HB`, `3× A4 nelinkovaný papír`, "klid"],
    room: `klidné prostředí`,
    therapist_position: `z boku`,
    child_position: `u stolu`,
    what_to_say_first:
      'Postupně dej tři instrukce s pauzou: »Nakresli mi dům.` → po dokončení nový papír → »Nakresli mi strom.` → »Nakresli mi člověka.` Mezi nimi krátká pauza.'`,
    what_NOT_to_say: [`Nespecifikuj typ`, `Nehodnoť`],
    measurements_required: [
      `pořadí všech tří kreseb`,
      `u každé: umístění, velikost, tlak, pořadí částí, vynechání, post-drawing inquiry`,
    ],
  },
  step_protocol: {
    kind: "drawing_phases",
    instruction:
      `Po každé kresbě post-drawing inquiry: dům — »kdo tam bydlí, je tam šťastný?`, strom — »jak se mu daří?`, postava — »kdo to je, co dělá, cítí?`. Doslovně zapiš.``,
    what_to_record: ["per_drawing_full_set"],
    red_flags: [
      `okna bez skla / zamřížovaná`,
      `dům bez dveří nebo komínu`,
      `postava bez rukou nebo bez úst`,
      `extrémně malá kresba`,
      `verbalizace nebezpečí v domě`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, `popis nebezpečí v domě`, `ztuhnutí`],
    immediate_actions: ["validace", "grounding"],
    do_not_repeat_stimulus: false,
    grounding_script: `Klidně přesun.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Která kresba se ti dělala nejlíp?`],
    grounding: "pauza",
  },
  required_artifacts: ["image", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 5) RODINA V AKCI (Burns KFD)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_kfd_burns: Playbook = {
  method_id: "kfd_burns",
  method_label: `Kinetická kresba rodiny (Burns KFD)`,
  source_refs: [`Burns & Kaufman — Kinetic Family Drawings (1970)`],
  pre_session_setup: {
    supplies: [`tužka HB`, `A4 nelinkovaný`],
    room: "klid",
    therapist_position: `z boku`,
    child_position: `u stolu`,
    what_to_say_first:
      'Řekni přesně: »Nakresli mi prosím svou rodinu, jak něco dělá. Ne jako fotku — ať se vidí, že každý něco dělá.`'`,
    what_NOT_to_say: [`Nespecifikuj kdo do rodiny patří`, `Nenavrhuj činnosti`],
    measurements_required: [
      `kdo je nakreslen (a kdo chybí)`,
      `vzdálenosti mezi postavami`,
      `akce každé postavy`,
      `velikost a umístění (kdo dominuje)`,
      `bariéry (předměty mezi postavami)`,
      `pořadí kreslení postav`,
    ],
  },
  step_protocol: {
    kind: "drawing_phases",
    instruction:
      `Post-drawing inquiry: zeptej se na každou postavu — kdo to je, co dělá, jak se cítí, co si myslí o ostatních. Pokud někdo chybí, jemně se zeptej proč.`,
    what_to_record: ["all_KFD_indicators", "post_inquiry_verbatim"],
    red_flags: [
      `vynechání rodiče nebo sourozence`,
      `izolace dítěte (samo v rohu)`,
      `bariéry mezi postavami`,
      `agresivní akce`,
      `verbalizace násilí v rodině`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, `popis násilí`, `ztuhnutí při určité postavě`],
    immediate_actions: [`okamžitá validace`, "grounding", `klinické rozhodnutí o ohlášení (DOP)`],
    do_not_repeat_stimulus: false,
    grounding_script: `Klid, bezpečí, pauza.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Jak se cítíš, když se na tu kresbu díváš?`],
    grounding: `pauza, klidná aktivita`,
  },
  required_artifacts: ["image", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 6) NARATIVNÍ PROJEKCE (CAT/TAT styl)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_narrative_cat: Playbook = {
  method_id: "narrative_cat_tat",
  method_label: `Narativní projektivní vyprávění (CAT/TAT styl)`,
  source_refs: [`Bellak — CAT (1949)`, `Murray — TAT (1943)`],
  pre_session_setup: {
    supplies: [`audio nahrávač / mobil`, `papír na zápis`, `obrázek nebo téma`],
    room: "klid",
    therapist_position: `naproti, klidně`,
    child_position: `pohodlně`,
    what_to_say_first:
      'Řekni přesně: »Vymysli mi prosím příběh. Příběh musí mít začátek, něco se stane, a konec. Mluv pomalu, abych ti stihla zapsat.`'`,
    what_NOT_to_say: [`Nenavrhuj zápletku`, `Nepřerušuj`],
    measurements_required: [
      `hlavní postava (kdo, věk, pohlaví)`,
      `konflikt v příběhu`,
      `kdo pomáhá / kdo škodí`,
      `řešení (ano/ne, jak)`,
      `konec (pozitivní / otevřený / katastrofický)`,
      `pauzy, návraty, opravy`,
      `doslovné citace`,
    ],
  },
  step_protocol: {
    kind: "narrative",
    instruction:
      `Doslovně zapiš nebo nahraj. Pokud dítě skončí příliš brzy, jednou se zeptej: »A co bylo dál?` Jinak nezasahuj.``,
    what_to_record: ["full_verbatim_story", "pauses", "affect_changes"],
    red_flags: [
      `katastrofický konec bez záchrany`,
      `absence pomáhající figury`,
      `explicitní traumatické téma`,
      `rozpad narativu (dítě nedokáže dokončit)`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, "freeze", `ztráta hlasu`, `verbalizace traumatu jako toho hrdiny]`,
    immediate_actions: [`okamžitě zastav vyprávění`, "validace", "grounding"],
    do_not_repeat_stimulus: false,
    grounding_script: `Klidně přesun do bezpečí.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Co by si ten hrdina přál?`, `Jak se cítíš teď?`],
    grounding: "pauza",
  },
  required_artifacts: ["audio", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 7) HRA S FIGURKAMI / PÍSKOVIŠTĚ (Lowenfeld)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_sandtray_lowenfeld: Playbook = {
  method_id: "sandtray_lowenfeld",
  method_label: `Hra s figurkami / pískoviště (Lowenfeld World Technique)`,
  source_refs: [`Margaret Lowenfeld — The World Technique (1979)`],
  pre_session_setup: {
    supplies: [`set figurek (lidi, zvířata, vozidla, domy, přírodní objekty, stinné figurky)`, `podložka / pískoviště`, `audio záznam`, `fotoaparát`],
    room: `klid, dostatek místa`,
    therapist_position: `z boku, na úrovni dítěte`,
    child_position: `u podložky`,
    what_to_say_first:
      'Řekni přesně: »Tady máš různé figurky. Postav si svůj svět — jakýkoliv. Já budu jen pozorovat.`'`,
    what_NOT_to_say: [`Nenavrhuj scénu`, `Nehodnoť výběr figurek`],
    measurements_required: [
      `první vybraná figurka`,
      `umístění (centrum / okraj)`,
      `vzdálenosti`,
      `skupiny / izolace`,
      `akce (boj, ochrana, ignorace)`,
      `změny scény (přesuny, schování, vyřazení)`,
      `narativ dítěte k scéně`,
    ],
  },
  step_protocol: {
    kind: "play",
    instruction:
      `Mlčky pozoruj 10–20 min. Zapiš sekvenci akcí. Po dokončení se zeptej: »Můžeš mi povědět, co se v tom světě děje?` Vyfoť výslednou scénu.``,
    what_to_record: ["sequence_of_actions", "final_scene_photo", "narrative_verbatim"],
    red_flags: [
      `izolovaná malá figurka v rohu`,
      `opakované pohřbívání / schovávání`,
      `scéna násilí bez záchrany`,
      `verbalizace traumatu`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, `destruktivní zničení scény`, `ztuhnutí`],
    immediate_actions: ["validace", "grounding", `rozhodnutí`],
    do_not_repeat_stimulus: false,
    grounding_script: `Klid.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Co bys v tom světě ještě chtěl změnit?`],
    grounding: "pauza",
  },
  required_artifacts: ["image", "audio", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 8) TĚLOVÁ MAPA (somatický scan, dětská adaptace)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_body_map_somatic: Playbook = {
  method_id: "body_map_somatic",
  method_label: `Tělová mapa (somatic scan)`,
  source_refs: [`Levine — Somatic Experiencing (adaptace pro děti)`],
  pre_session_setup: {
    supplies: [`předtištěná silueta postavy A4`, `barevné pastelky / fixy`, "klid"],
    room: "klid",
    therapist_position: `vedle, podpůrně`,
    child_position: `u stolu`,
    what_to_say_first:
      'Řekni přesně: »Tady je obrys postavy. Vybarvi prosím barvami místa, kde něco cítíš. Dej barvu, jakou si vybereš — třeba červenou, kde to bolí, modrou kde je klid…`'`,
    what_NOT_to_say: [`Nediktuj barvy ani významy`],
    measurements_required: [
      `barva → tělesná oblast`,
      `intenzita (silně / slabě)`,
      `verbální komentář dítěte`,
    ],
  },
  step_protocol: {
    kind: "drawing_phases",
    instruction:
      `Po dokončení projdi spolu mapu — »a tady ta barva znamená co?`. Doslovně zapiš.``,
    what_to_record: ["color_to_zone_mapping", "verbatim_explanations"],
    red_flags: [
      `černé/červené zóny v genitální oblasti, krku, hrudi (somatický marker traumatu)`,
      `nebarvi se vůbec (alexithymie)`,
      `explicitní bolest`,
    ],
  },
  trauma_response_protocol: {
    signs: [`pláč`, `verbalizace bolesti vázané na vzpomínku`, `ztuhnutí`],
    immediate_actions: ["validace", "grounding", `rozhodnutí`],
    do_not_repeat_stimulus: false,
    grounding_script: `Klid, dech.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Která barva ti přijde teď nejvíc?`],
    grounding: `pohyb / dech`,
  },
  required_artifacts: ["image", "verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// 9) BEZPEČNÉ MÍSTO (vizualizace, grounding)
// ─────────────────────────────────────────────────────────────────────────────
export const playbook_safe_place: Playbook = {
  method_id: "safe_place_visualization",
  method_label: `Bezpečné místo (vizualizace)`,
  source_refs: [`EMDR Resource Development — Shapiro`],
  pre_session_setup: {
    supplies: [`tužka + A4 NEBO jen klid`, `tichá místnost`],
    room: `klid, tlumené světlo`,
    therapist_position: `klidně vedle nebo naproti`,
    child_position: `pohodlně, oči otevřené nebo zavřené (jak chce dítě)`,
    what_to_say_first:
      'Řekni klidně, pomalu: »Představ si místo, kde se cítíš úplně v bezpečí. Může být skutečné nebo vymyšlené. Až ho budeš mít, řekni mi o něm.`'`,
    what_NOT_to_say: [`Nenavrhuj místo`, `Nepospíchej`],
    measurements_required: [
      `popis místa (verbatim)`,
      `smyslové detaily (co vidí, slyší, cítí)`,
      `kdo tam je (sám / s někým)`,
      `afekt během vizualizace`,
    ],
  },
  step_protocol: {
    kind: "open_dialog",
    instruction:
      `Pomalé otázky: »Co vidíš? Co slyšíš? Jak to tam voní? Jak se ti tam dýchá?` Žádný spěch.``,
    what_to_record: ["full_description", "sensory_anchors", "affect"],
    red_flags: [
      `dítě nedokáže najít bezpečné místo (silný marker absence vnitřního bezpečí)`,
      `místo se mění v ohrožující`,
    ],
  },
  trauma_response_protocol: {
    signs: [`intruze traumatické vzpomínky během vizualizace`],
    immediate_actions: [`okamžitě otevřít oči`, `5-4-3-2-1 grounding`, `ne pokračovat`],
    do_not_repeat_stimulus: false,
    grounding_script:
      `Pojmenuj 5 věcí, které vidíš, 4 zvuky, 3 dotyky, 2 vůně, 1 chuť.`,
  },
  closure_protocol: {
    reproduction_check: null,
    debrief_questions: [`Můžeš si to místo zapamatovat? Vrátíme se k němu jindy?`],
    grounding: `lehký pohyb`,
  },
  required_artifacts: ["verbatim_log"],
};

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY + DETEKCE
// ─────────────────────────────────────────────────────────────────────────────
export const ALL_PLAYBOOKS: Playbook[] = [
  playbook_association_experiment_jung,
  playbook_draw_a_person_machover,
  playbook_tree_test_koch,
  playbook_htp_buck,
  playbook_kfd_burns,
  playbook_narrative_cat,
  playbook_sandtray_lowenfeld,
  playbook_body_map_somatic,
  playbook_safe_place,
];

export function detectPlaybook(blockText: string): Playbook | null {
  const t = (blockText || ``).toLowerCase();

  // asociace — slova, asociační experiment, `8 slov`
  if (/(asocia[čc]n|asociac|slovn[íi] hr|prvn[íi] n[áa]pad|napadne|\b\d+\s*slov\b)/.test(t)) {
    return playbook_association_experiment_jung;
  }

  // bezpečné místo
  if (/(bezpe[čc]n[éeéeé]\s*m[íi]sto|safe\s*place|vizualizac|kotven[íi])/.test(t)) {
    return playbook_safe_place;
  }

  // tělová mapa
  if (/(t[ěe]lov[áa]\s*map|body\s*map|somat|kde\s+to\s+v\s+t[ěe]le)/.test(t)) {
    return playbook_body_map_somatic;
  }

  // pískoviště / hra s figurkami
  if (/(figurk|loutk|sandtray|p[íi]skovi[šs]|hra\s+s\s+(figurk|hra[čc]k))/.test(t)) {
    return playbook_sandtray_lowenfeld;
  }

  // rodina (KFD)
  if (/(kresba\s+rodin|rodina\s+v\s+akci|nakresli.*rodin|kfd|kinetick)/.test(t)) {
    return playbook_kfd_burns;
  }

  // HTP — explicitní zmínka domu+stromu+postavy
  if (/(d[ůu]m.*strom.*postav|htp|h-t-p|d[ůu]m.{0,10}strom)/.test(t)) {
    return playbook_htp_buck;
  }

  // strom (Koch)
  if (/(\bstrom\b|baumtest|koch.*strom)/.test(t)) {
    return playbook_tree_test_koch;
  }

  // postava (Machover)
  if (/(kresba\s+postav|nakresli.*postav|nakresli\s+(?:[čc]lov|sebe)|machover|dap\b)/.test(t)) {
    return playbook_draw_a_person_machover;
  }

  // narativ
  if (/(p[řr]íb[ěe]h|narativ|narrative|cat\b|tat\b|vym[yi]sli.*p[řr][íi]b)/.test(t)) {
    return playbook_narrative_cat;
  }

  return null;
}

/**
 * Zformátuje playbook do textového briefingu (pro injection do AI promptu).
 */
export function renderPlaybookForPrompt(p: Playbook, plannedSteps?: string[]): string {
  const steps = plannedSteps && plannedSteps.length ? plannedSteps : (p.step_protocol.planned_steps || []);
  return `═══ KLINICKÝ PLAYBOOK (POVINNÝ) ═══`
METODA: ${p.method_label}
ZDROJ: ${p.source_refs.join(`; `)}

▼ PRE-SESSION SETUP (musíš nejdřív vysvětlit terapeutce, NEŽ dáš první stimul)
Pomůcky: ${p.pre_session_setup.supplies.join(`, `)}
Místnost: ${p.pre_session_setup.room}
Pozice terapeutky: ${p.pre_session_setup.therapist_position}
Pozice dítěte: ${p.pre_session_setup.child_position}
Co PŘESNĚ říct dítěti na začátku:
${p.pre_session_setup.what_to_say_first}
Co NESMÍŠ dělat / říkat:
${p.pre_session_setup.what_NOT_to_say.map(s => `  - ` + s).join(`\n`)}
CO MUSÍ TERAPEUTKA POVINNĚ ZAZNAMENÁVAT KAŽDÝ TURN:
${p.pre_session_setup.measurements_required.map(s => `  • ` + s).join(`\n`)}

▼ STEP PROTOCOL (typ: ${p.step_protocol.kind})
${steps.length ? `Plánované stimuly (${steps.length}):\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join(`\n`)}` : ``}
Instrukce na každý krok: ${p.step_protocol.instruction}
Co zaznamenat: ${p.step_protocol.what_to_record.join(`, `)}
RED FLAGS (kdy přerušit a přejít do trauma_pause):
${p.step_protocol.red_flags.map(s => `  ⚠ ` + s).join(`\n`)}

▼ TRAUMA RESPONSE PROTOCOL
Příznaky: ${p.trauma_response_protocol.signs.join(`; `)}
DO NOT REPEAT STIMULUS: ${p.trauma_response_protocol.do_not_repeat_stimulus ? `ANO — NIKDY neopakuj stejný stimul po traumatické reakci` : "ne"}
Okamžité akce:
${p.trauma_response_protocol.immediate_actions.map(s => `  → ` + s).join(`\n`)}
Grounding skript pro dítě:
${p.trauma_response_protocol.grounding_script}

▼ CLOSURE
${p.closure_protocol.reproduction_check ? `Reprodukční zkouška: ${p.closure_protocol.reproduction_check}` : `(bez reprodukční zkoušky)`}
Debrief otázky:
${p.closure_protocol.debrief_questions.map(s => `  • ` + s).join(`\n`)}
Grounding po dokončení: ${p.closure_protocol.grounding}

▼ POVINNÉ ARTEFAKTY: ${p.required_artifacts.join(`, `)}
═══════════════════════════════════`;`
}
