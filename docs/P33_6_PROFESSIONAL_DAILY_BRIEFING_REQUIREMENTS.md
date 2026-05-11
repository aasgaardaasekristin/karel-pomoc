# P33.6 — Professional Daily Briefing Requirements

Závazné profesionální požadavky pro Karlův denní přehled v UI Pracovny. Backend zelené SQL/runtime kontroly nestačí — viditelný výstup musí splnit všechna níže uvedená pravidla.

## 1. Aktuálnost (Currentness)

- Každé tvrzení o "dnešku" musí být vázáno na pražské datum dnes a na poslední přijatý `source_cycle_id` (briefing_truth_gate.ok=true).
- Staré návrhy a staré internetové události se nesmí zobrazovat jako dnešní živý plán. Mohou se objevit jen pod sbalenou sekcí "Starší návrhy k revizi" nebo jako historický kontext.

## 2. Relevance (proposed today part)

Dnešní navrhovaná část musí pocházet z:
- `today_part_proposal` z briefingu, který prošel truth-gate, **NEBO**
- vybraná část v dnešním session/playroom plánu, **NEBO**
- nedávné vlákno (24–72h) / live progress, **NEBO**
- explicitní zmínka terapeutkou v pending question/odpovědi.

Nesmí přijít z:
- slepého `did_part_registry.status='active'`,
- starých `today_part_proposal` z minulých dnů,
- stale `active_part_daily_brief` bez `weekly_matrix_ref` a `query_plan_version=p30.3_personal_anchor_general_trigger_weekly_matrix`,
- dormantních legacy názvů typu `001_Anička`, `002_Anička`.

Technické prefixy (`001_`, `002_`) musí být buď normalizovány, nebo část skryta z primárního návrhu.

Pokud opora (`evidence_strength=low` a `is_hypothesis_only=true`) je nedostatečná, viditelný text zní:
> *Dnes nemám dost opory vybrat konkrétní část před prvním kontaktem. Vybereme až podle toho, co kluci sami přinesou.*

## 3. Transparentnost externí reality

Pro každý zobrazený externí signál ukázat:
- kategorii / téma,
- jméno části, které se týká,
- doménu zdroje (`source_domain`),
- datum ověření / fetched_at,
- datum publikace, pokud je k dispozici,
- recency tier label.

Recency tiery (závazné fráze):
- **fresh_today_event** → "čerstvě zachycený / ověřený dnes" — doporučeno hlídat rámec.
- **checked_today_unknown_publication_date** → "internetový přehled dnes znovu ověřil citlivý okruh… datum publikace zdroje není jasné… **neberu to jako dnešní událost**".
- **historical_sensitive_context** → "dříve evidovaný citlivý okruh bez čerstvého zdrojovaného podkladu pro dnešek".

Zakázáno pro tier 2/3:
- "může dnes zatížit",
- "dnes se objevilo",
- "dnešní událost".

Zakázáno (vždy):
- skrýt všechny internetem ověřené zdroje, když existují tier 2 zdroje,
- prezentovat tier 1+ jen jako počty bez popisu.

## 4. Klinická bezpečnost

- Žádné grafické detaily.
- Žádná diagnóza.
- Žádná symbolická interpretace.
- Slovní vrstva: "ověřit", "držet rámec", "nepředpokládat", "jemně zkontrolovat".

## 5. Jazyková kvalita

Zakázané viditelně:
- technické / debug fráze: "AI polish", "audit", "Technické podklady",
- interní termíny: `payload`, `truth gate`, `job graph`, `provider_status`, `query_plan_version`, `source_cycle_id`, `unsupported_claims`, `robotic_phrase`,
- robotické fráze: "Na základě dat", "Bylo zjištěno", "systém indikuje" atd.,
- dvojité interpunkce (`..`, `,,`, `;;`),
- chybná gramatika ("doložený praktickou poznámku", "Opora v podkladech je nízká"),
- technické prefixy částí (`001_…`, `002_…`),
- malá písmena u kanonických jmen (`arthur`, `tundrupek`).

Pravidla:
- věty jsou Karlovým hlasem (klidné, opatrné, s vokativem k Haničce/Káťě),
- správná česká gramatika a interpunkce,
- kanonické názvy částí s velkým prvním písmenem.

## 6. Integrita plánu

Týmové porady, návrhy sezení a herny zobrazit jako "dnešní plán" jen pokud:
- `valid_for_date = today`, **NEBO** `session_date = today`,
- **NEBO** navázáno na poslední `source_cycle_id`,
- a status je active/awaiting_signoff a není po expiraci.

Staré otevřené návrhy (např. plán s Timmim z předchozího dne) → sklápěcí "Starší návrhy k revizi", nikdy ne primární dnešní plán.

## 7. Admin / debug

`Technické podklady` a `AI polish náhled — pouze audit` se v normální Pracovně **nesmí** zobrazit. Zobrazí se jen pokud `karelDebugMode()` vrací `true` (URL parametr `?karelDebug=1` nebo `localStorage.karel_debug==='1'`).

## Acceptance

- `professional_requirements_doc_created = true`
- `requirements_cover_currentness_relevance_external_safety_language_plan_integrity = true`
