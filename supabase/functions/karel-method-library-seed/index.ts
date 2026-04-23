/**
 * karel-method-library-seed
 * --------------------------
 * Idempotentní seed 9 základních klinických manuálů do karel_method_library.
 * Manuály jsou inline (ne import) aby seed nezávisel na clinicalPlaybooks.ts.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Seed = {
  method_key: string;
  title: string;
  category: string;
  age_range: string;
  manual_md: string;
  sources: string[];
  tags: string[];
  contraindications: string;
};

const CONTRAINDICATIONS_COMMON =
  "EPILEPSIE — žádná dechová cvičení ani hyperventilace ani zadržování dechu. Při flashbacku přerušit a uzemnit přes smysly (5-4-3-2-1), vodu, teplotu — ne dech.";

const SEEDS: Seed[] = [
  {
    method_key: "association_experiment_jung",
    title: "Asociační experiment (Jung) — dětský zkrácený protokol 8 slov",
    category: "diagnostika",
    age_range: "7-18",
    sources: [
      "C. G. Jung — Studies in Word Association (1906)",
      "Bohm — Lehrbuch der Rorschach-Psychodiagnostik",
    ],
    tags: ["verbální", "projektivní", "Jung", "diagnostika"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Asociační experiment (Jung) — dětský zkrácený protokol 8 slov

## Setup
- Stopky / mobil (POVINNĚ — měříme latenci v sekundách)
- Papír A4 + tužka — DOSLOVNÝ zápis odpovědí
- Tichá místnost bez rušivých podnětů
- Voda pro dítě
- Pozice: terapeutka naproti dítěti, oční kontakt, nepříliš blízko

## Úvodní instrukce (přesně)
"Budeme spolu hrát hru se slovy. Já ti řeknu jedno slovo a ty mi hned řekni první slovo, které tě napadne. Nemusíš o tom přemýšlet, není správná ani špatná odpověď. Začínáme?"

## Co NIKDY neříkat
- Žádné navádějící otázky (např. "A co rodina?")
- Nehodnoť odpovědi ("Hezky", "Aha")
- Neopakuj slovo pokud mlčí — počkej až 30s a zapiš pauzu
- Nediskutuj odpověď uprostřed — vše až v debriefu

## Co měřit každý turn
- Doslovná odpověď (verbatim, slovo od slova)
- Latence v sekundách (od konce stimulu po začátek odpovědi)
- Afekt (neutrální / napětí / úzkost / pláč / smích / freeze / mlčení)
- Neverbální (mimika, dech, postoj, červenání, slzy)

## Průběh
8 slov v sekvenci. Karel dynamicky generuje slova na míru části (mix neutrálních + afektivních).
Po každé odpovědi ZAPSAT, pokračovat. NIKDY neopakovat stejné slovo dvakrát.

## Red flags (přepnout do trauma_pause)
- Latence > 8s u afektivního slova (indikátor komplexu)
- Perseverace (opakování předchozí odpovědi)
- Klangová odpověď (rýmování) — známka úniku
- Odmítnutí odpovědět
- Vegetativní reakce (zčervenání, slzy, ztuhnutí)
- Explicitní zmínka traumatu, flashbacku, týrání

## Trauma protokol
**Známky:** pláč, freeze, zblednutí, schování, terapeutka popíše flashback, disociace, explicitní spojení slova s týráním.

**Okamžité akce:**
1. PŘERUŠ sekvenci slov — žádný další stimul
2. Validuj nález: "to co popisuješ je klinicky významné, je to indikátor komplexu vázaného k tématu, NE selhání"
3. Dej přesný grounding skript
4. Rozhodni: pokračovat / zvolnit / zcela přerušit (a proč)
5. Vyžaduj zápis přesné formulace dítěte + neverbální projevy

**Grounding (bez dechu):** "Jsi tady se mnou, jsme v bezpečí. Pojmenuj mi tři věci, které vidíš v místnosti." Pauza min. 3 minuty.

## Závěr
**Reprodukční kontrola:** Po 5-10 min pauzy: "Vzpomeneš si, jaká slova jsme říkali? A co jsi na ně odpovídal?" Zapiš co si nepamatuje (silný indikátor komplexu).

**Debrief:** "Jak ti to šlo? Bylo nějaké slovo, u kterého ti bylo divně?"

## Povinné artefakty
- audio (volitelně)
- verbatim_log
- latency_log

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "draw_a_person_machover",
    title: "Kresba postavy (Machover DAP)",
    category: "diagnostika",
    age_range: "5-18",
    sources: ["Machover — Personality Projection in the Drawing of the Human Figure (1949)"],
    tags: ["projektivní", "kresba", "neverbální", "diagnostika"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Kresba postavy (Machover DAP)

## Setup
- Tužka HB č.2 (BEZ gumy)
- Papír A4 nelinkovaný, bílý, na šířku
- Plochý stůl, dobré světlo
- Terapeutka z boku, ne přímo nad dítětem, mlčky pozoruje

## Úvodní instrukce
"Nakresli mi prosím postavu. Kohokoliv, kdo tě napadne. Není to o tom, jestli to bude hezké."

## Co NIKDY neříkat
- Nedávej nápovědu ("Můžeš nakreslit chlapce")
- Nekomentuj průběh
- Neopravuj ("Chybí ti uši")

## Co měřit
- Pořadí kreslení (která část jako první)
- Umístění na papíru (střed/dolní třetina/okraj/roh)
- Tlak tužky (silný/slabý/kolísavý)
- Škrtání, mazání (kde, kolikrát)
- Velikost postavy (mm)
- Vynechané části (oči, ústa, ruce, prsty, uši, krk)
- Pohlaví/věk postavy
- Výraz tváře

## Průběh
Fáze 1: nech kreslit nerušeně.
Fáze 2 (po dokončení): post-drawing inquiry — "kdo to je, kolik je mu let, co dělá, jak se cítí". DOSLOVNĚ zapsat.

## Red flags
- Vynechané ruce/oči/ústa (možný disociativní marker)
- Neúměrně malá nebo velká postava
- Extrémní tlak nebo škrtání u určité části (sex. zóny, hlava)
- Nutkavé mazání
- Odmítnutí kresby
- Explicitní traumatický obsah

## Trauma protokol
Pláč při určité části, ztuhnutí ruky, verbalizace traumatu, ničení kresby → zastav inquiry, validuj, grounding.

## Závěr
Debrief: "Co bys o té postavě ještě řekl? Jak se ti to kreslilo?"

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "tree_test_koch_baum",
    title: "Test stromu (Koch Baumtest)",
    category: "diagnostika",
    age_range: "5-18",
    sources: ["Karl Koch — Der Baumtest (1949)"],
    tags: ["projektivní", "kresba", "neverbální"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Test stromu (Koch Baumtest)

## Setup
- Tužka HB
- A4 nelinkovaný, na výšku
- Klid, terapeutka z boku

## Úvodní instrukce
"Nakresli mi nějaký strom. Jakýkoli strom, který tě napadne."

## Co NIKDY neříkat
- Nespecifikuj druh ani roční období
- Nehodnoť, neopravuj

## Co měřit
- Pořadí kreslení (kořeny, kmen, koruna)
- Umístění na papíru, velikost (mm), tlak
- Kořeny (ano/ne, hloubka)
- Kmen — šířka, struktura, dutiny, jizvy
- Koruna — symetrie, listí, plody
- Okolí (zem, slunce, jiné objekty)

## Průběh
Fáze 1: kreslení. Fáze 2: "kolik je tomu stromu let? jak se mu daří? co se mu stalo?" — DOSLOVNĚ zapsat.

## Red flags
- Dutiny v kmeni (často trauma marker)
- Uschlé větve, opadané listí
- Extrémně malý strom v rohu
- Verbalizace traumatu ("tenhle strom někdo zlomil")

## Trauma protokol
Pláč, verbalizace zranění → validace, grounding bez dechu.

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "htp_buck",
    title: "Dům-Strom-Postava (Buck HTP)",
    category: "diagnostika",
    age_range: "5-18",
    sources: ["John Buck — H-T-P Technique (1948)"],
    tags: ["projektivní", "kresba", "neverbální", "komplexní"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Dům-Strom-Postava (Buck HTP)

## Setup
- Tužka HB
- 3× A4 nelinkovaný
- Klid

## Průběh
Tři instrukce s pauzou:
1. "Nakresli mi dům." → po dokončení nový papír
2. "Nakresli mi strom."
3. "Nakresli mi člověka."

Po každé kresbě post-drawing inquiry:
- Dům: "kdo tam bydlí, je tam šťastný?"
- Strom: "jak se mu daří?"
- Postava: "kdo to je, co dělá, cítí?"

DOSLOVNĚ zapsat.

## Co měřit (u každé)
Umístění, velikost, tlak, pořadí částí, vynechání, post-drawing inquiry.

## Red flags
- Okna bez skla / zamřížovaná
- Dům bez dveří nebo komínu
- Postava bez rukou nebo bez úst
- Extrémně malá kresba
- Verbalizace nebezpečí v domě

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "kfd_burns",
    title: "Kinetická kresba rodiny (Burns KFD)",
    category: "diagnostika",
    age_range: "5-18",
    sources: ["Burns & Kaufman — Kinetic Family Drawings (1970)"],
    tags: ["projektivní", "kresba", "rodina", "vztahy"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Kinetická kresba rodiny (Burns KFD)

## Setup
- Tužka HB, A4 nelinkovaný

## Úvodní instrukce
"Nakresli mi prosím svou rodinu, jak něco dělá. Ne jako fotku — ať se vidí, že každý něco dělá."

## Co NIKDY neříkat
- Nespecifikuj kdo do rodiny patří
- Nenavrhuj činnosti

## Co měřit
- Kdo je nakreslen (a kdo CHYBÍ)
- Vzdálenosti mezi postavami
- Akce každé postavy
- Velikost a umístění (kdo dominuje)
- Bariéry (předměty mezi postavami)
- Pořadí kreslení postav

## Průběh
Post-drawing inquiry pro každou postavu: kdo to je, co dělá, jak se cítí, co si myslí o ostatních. Pokud někdo chybí, jemně se zeptej proč.

## Red flags
- Vynechání rodiče nebo sourozence
- Izolace dítěte (samo v rohu)
- Bariéry mezi postavami
- Agresivní akce
- Verbalizace násilí v rodině

## Trauma protokol
Při popisu násilí: validace, grounding, KLINICKÉ ROZHODNUTÍ o ohlášení (DOP).

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "narrative_cat_tat",
    title: "Narativní projektivní vyprávění (CAT/TAT styl)",
    category: "diagnostika",
    age_range: "5-18",
    sources: ["Bellak — CAT (1949)", "Murray — TAT (1943)"],
    tags: ["narativní", "verbální", "projektivní"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Narativní projektivní vyprávění (CAT/TAT styl)

## Setup
- Audio nahrávač / mobil
- Papír na zápis
- Volitelně obrázek nebo dané téma

## Úvodní instrukce
"Vymysli mi prosím příběh. Příběh musí mít začátek, něco se stane, a konec. Mluv pomalu, abych ti stihla zapsat."

## Co NIKDY neříkat
- Nenavrhuj zápletku
- Nepřerušuj

## Co zaznamenat
- Hlavní postava (kdo, věk, pohlaví)
- Konflikt v příběhu
- Kdo pomáhá / kdo škodí
- Řešení (ano/ne, jak)
- Konec (pozitivní / otevřený / katastrofický)
- Pauzy, návraty, opravy
- DOSLOVNÉ citace

## Průběh
Doslovně zapiš nebo nahraj. Pokud dítě skončí příliš brzy, JEDNOU se zeptej: "A co bylo dál?" Jinak nezasahuj.

## Red flags
- Katastrofický konec bez záchrany
- Absence pomáhající figury
- Explicitní traumatické téma
- Rozpad narativu (nedokáže dokončit)

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "sandtray_lowenfeld",
    title: "Sandtray (Lowenfeld World Technique)",
    category: "diagnostika",
    age_range: "5-15",
    sources: ["Margaret Lowenfeld — The World Technique (1939)"],
    tags: ["hra", "projektivní", "neverbální", "sandtray"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Sandtray (Lowenfeld World Technique)

## Setup
- Pískoviště (obvykle 50×70×7 cm), modrý spodek (symbolizuje vodu)
- Sbírka miniatur (lidé, zvířata, budovy, stromy, dopravní prostředky, fantasy bytosti, předměty každodenní potřeby) — minimálně 100 ks roztříděných
- Klidná místnost, terapeutka mlčky pozoruje

## Úvodní instrukce
"Tady je písek a tyhle figurky. Postav v písku svůj svět. Jakýkoli, který tě napadne. Můžeš použít cokoli z police."

## Co NIKDY neříkat
- Nenavrhuj scénu
- Neptej se "proč" během stavby

## Co zaznamenat
- Pořadí umisťování (první figurka, druhá...)
- Mapa scény (foto na konci POVINNĚ)
- Použité kategorie (lidé / zvířata / budovy / boj / příroda)
- Centrum vs okraje
- Bariéry, plot, voda
- Konflikty na scéně
- Slovní komentář dítěte (DOSLOVNĚ)

## Průběh
Fáze 1: stavba (15-30 min, NEZASAHOVAT).
Fáze 2: dítě "převypráví" svět — kdo je kdo, co se děje. DOSLOVNĚ zapsat.

## Red flags
- Scéna bez lidí (jen zvířata/objekty)
- Násilná scéna v centru
- Hlavní postava v rohu / pohřbená
- Voda jako bariéra
- Verbalizace traumatu

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "body_map",
    title: "Body Map (mapa těla)",
    category: "trauma",
    age_range: "7-18",
    sources: ["van der Kolk — The Body Keeps the Score", "Ogden — Sensorimotor Psychotherapy"],
    tags: ["somatic", "trauma-informed", "neverbální"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Body Map (mapa těla)

## Setup
- Velký papír (alespoň A2) s předkresleným obrysem postavy (volitelně dítě obkresleno na zem)
- Pastelky / fixy v různých barvách
- Klidné prostředí

## Úvodní instrukce
"Tady je mapa tvého těla. Ukaž mi barvami, kde cítíš různé věci. Můžeš použít barvy podle nálady — ale není správná ani špatná barva."

## Co zaznamenat
- Které části těla zbarvil (které vynechal)
- Barvy a kde
- Slovní popis ("tady mě bolí", "tady je teplo", "tady nic necítím")
- Disociované zóny (vynechání hrudníku, břicha, pánve = trauma marker)

## Průběh
Klidné tempo. Pokud dítě řekne že někde nic necítí, NEDOTLAČOVAT. Zapsat.

## Red flags
- Vynechání celé zóny
- Černá/červená v sex. zónách
- Verbalizace bolesti spojená s konkrétní vzpomínkou
- Freeze při dotazování na určitou část

## Trauma protokol
Pokud dítě začne disociovat → zastav, validuj, smyslový grounding (NIKDY ne dech).

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
  {
    method_key: "safe_place_imagination",
    title: "Bezpečné místo (imaginace)",
    category: "stabilizace",
    age_range: "5-18",
    sources: ["Shapiro — EMDR (resource development)", "Ogden — Sensorimotor"],
    tags: ["imaginace", "stabilizace", "resource"],
    contraindications: CONTRAINDICATIONS_COMMON,
    manual_md: `# Bezpečné místo (imaginace)

## Setup
- Klidné prostředí
- Volitelně: papír + pastelky (pro zakreslení po imaginaci)

## Úvodní instrukce
"Představ si nějaké místo, kde se cítíš úplně bezpečně. Může to být skutečné místo nebo vymyšlené. Neříkej mi ho hned, jen si ho představ. Až ho budeš vidět, pokývej hlavou."

## Co NIKDY neříkat
- Nenavrhuj místo
- Neptej se "proč" toto místo
- ⚠️ NEPOUŽÍVEJ dechové instrukce — pacient má epilepsii. Místo dechu používej smyslové zaměření ("co tam vidíš, slyšíš, cítíš pod nohama").

## Průběh (smyslové, NE dech)
1. Co tam VIDÍŠ? (barvy, věci, světlo)
2. Co tam SLYŠÍŠ?
3. Co CÍTÍŠ pod rukama, nohama? (textura, teplota)
4. Kdo nebo co tě tam chrání?
5. Jaké slovo / gesto / barva symbolizuje toto místo? (kotvení)

Po imaginaci: dítě může nakreslit nebo pojmenovat. Kotva (slovo/gesto) se pak používá v dalších sezeních pro rychlý návrat.

## Red flags
- Místo není bezpečné (intruzivní postava, hluk, nebezpečí) → zastavit, hledat jiné
- Místo se mění/rozpadá → známka destabilizace
- Dítě nedokáže najít žádné místo → použít imaginární (pohádkové)

## Trauma protokol
Pokud se "bezpečné" místo ukáže jako nebezpečné → okamžitě otevřít oči, smyslový grounding, validovat, hledat jiný resource.

## ⚠️ Kontraindikace
${CONTRAINDICATIONS_COMMON}
`,
  },
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const results: Array<{ method_key: string; status: string; error?: string }> = [];

    for (const s of SEEDS) {
      const { data: existing } = await supabase
        .from("karel_method_library")
        .select("id")
        .eq("method_key", s.method_key)
        .maybeSingle();
      if (existing) {
        results.push({ method_key: s.method_key, status: "already_exists" });
        continue;
      }
      const { error } = await supabase.from("karel_method_library").insert({
        method_key: s.method_key,
        title: s.title,
        category: s.category,
        age_range: s.age_range,
        manual_md: s.manual_md,
        sources: s.sources,
        tags: s.tags,
        contraindications: s.contraindications,
        created_by: "seed",
        status: "seed",
      });
      if (error) {
        results.push({ method_key: s.method_key, status: "error", error: error.message });
      } else {
        results.push({ method_key: s.method_key, status: "seeded" });
      }
    }

    const seeded = results.filter((r) => r.status === "seeded").length;
    const skipped = results.filter((r) => r.status === "already_exists").length;
    const errored = results.filter((r) => r.status === "error").length;

    return new Response(
      JSON.stringify({
        ok: true,
        summary: { total: SEEDS.length, seeded, skipped, errored },
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("seed error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
