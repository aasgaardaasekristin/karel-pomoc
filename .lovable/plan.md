Schvaluji pouze nejmenší bezpečný opravný patch QA-MVP-SESSION-1. MVP-SESSION-1 se po tomto patchi stále nerozšiřuje funkčně; opravuje se jen klinická přesnost a auditovatelnost.

## Scope

Neměnit:
- session workflow
- dashboard
- deliberation architecture
- Drive writer / daily-cycle / briefing
- 05A writeback pravidla, pokud zůstanou podle QA beze změny
- PAMET_KAREL
- crisis workflow

Nespouštět:
- finalizer ani evaluator na produkčním sezení
- daily-cycle
- briefing
- Drive queue

## Změny

### 1. `karel-did-session-evaluate`: oprava `analysis_json`

Upravit tvorbu `analysis_json` tak, aby:
- `confirmed_facts` obsahovalo jen deterministická / doložená fakta:
  - `plan_id`
  - `part_name`
  - `completedBlocks`
  - `totalBlocks`
  - `completion_ratio`
  - `contactOccurred`
  - `actualPart`, pokud je doložená
  - `durationMinutes`, pokud je doložená
  - `live_progress` available/missing
  - checklist count
  - turn-by-turn count
  - observations count
  - transcript available/missing
  - artifacts count
  - review status
- `confirmed_facts` už nikdy neobsahovalo:
  - `evaluation.session_arc`
  - `evaluation.child_perspective`
  - AI shrnutí
  - interpretace
  - hypotézy
  - klinické závěry
- `session_arc` a `child_perspective` budou přesunuty mimo `confirmed_facts`, do bezpečné části jako `narrative_summary` a/nebo `working_deductions` podle existující struktury.
- pokud analýza není skutečně vytvořená, JSON bude explicitní:

```json
{
  "schema": "did_session_review.analysis.v1",
  "status": "missing"
}
```

### 2. `karel-did-session-evaluate`: `post_session_result.provenance`

Upravit `buildStructuredPostSessionResult` tak, aby výsledek nepředstíral terapeuticky zadaný payload.

Přidat vždy:

```json
{
  "schema": "post_session_result.v1",
  "provenance": "therapist_entered|auto_derived|missing",
  "entered_by": null,
  "entered_at": null
}
```

Pravidla pro tento patch:
- `therapist_entered`: jen pokud existuje skutečný terapeutický UI payload / explicitní záznam; UI formulář se teď nepřidává, takže pravděpodobně zatím nenastane.
- `auto_derived`: evaluator odvodil výsledek z progressu / checklistu / průběhových dat.
- `missing`: není skutečný ani odvozený výsledek.

Pro missing stav používat explicitní strukturu, ne prázdné `{}`:

```json
{
  "schema": "post_session_result.v1",
  "provenance": "missing",
  "status": "missing",
  "entered_by": null,
  "entered_at": null
}
```

### 3. `karel-did-session-evaluate`: zpřísnění `evidenceValidity`

Nahradit současné optimistické pravidlo.

Nové pravidlo:
- `high`: většina bloků hotová, například `completedBlocks / totalBlocks >= 0.8`, a zároveň existuje turn-by-turn/transcript nebo dostatečné observations / `therapist_entered` result.
- `moderate`: částečný průběh a alespoň jeden silnější podpůrný zdroj: observations, turn-by-turn, transcript nebo `therapist_entered post_session_result`.
- `low`: 0–1 blok, nebo chybí turn-by-turn / transcript / observations, nebo `post_session_result` je pouze `auto_derived`, nebo není jasné, co se skutečně stalo.

Konkrétní invariant:
- 1/5 bez turns, transcriptu, observations a bez `therapist_entered` result musí být `low`, nikdy `moderate`.

### 4. `karel-team-deliberation-iterate` + UI: `needs_followup_question`

Rozšířit `last_plan_change_state` na hodnoty:
- `unchanged`
- `revised`
- `deferred`
- `needs_followup_question`

Upravit inferenci tak, aby pokud vstup terapeutky neumožňuje plán bezpečně uzavřít a vyžaduje doplňující otázku, ukládala:

```json
"last_plan_change_state": "needs_followup_question"
```

V `DeliberationRoom` tuto hodnotu zobrazit v klinickém kontraktu s čitelným štítkem. Nezakládat nový workflow ani novou obrazovku.

### 5. `karel-part-session-prepare`: statický sanitizer child-facing openeru

Přidat post-generation validator pro AI opener. Zakázané výrazy / koncepty:
- `risk_gate`
- `contraindication`
- `contraindikace`
- `stop rule`
- `stop_rules`
- `diagnostický záměr`
- `terapeutický plán`
- `Hanička má`
- `Káťa má`
- `supervize`
- `program_draft`
- `plan_markdown`
- `readiness red`
- `klinická hypotéza`
- `evidence`
- `interní poznámky pro terapeutky`

Pokud validator najde zakázaný obsah, nepoužít AI opener a vrátit deterministický fallback:

```text
Ahoj, {část}. Dnes na tebe netlačím.
Chci jen krátce zjistit, jestli je teď bezpečné být spolu pár minut.

Stačí mi říct jedno z těchto:
„jde to“, „nejde to“, nebo „nevím“.

První otázka:
{first_question}
```

Pokud `first_question` chybí, použít bezpečnou default otázku bez interního klinického obsahu.

## Migrace

Nepředpokládám novou migraci. Stávající sloupce jsou JSONB a už existují. Patch řeší missing/provenance explicitně uvnitř JSON.

## Ověření po patchi

Ověřit bez spouštění produkčního sezení / finalizeru / daily-cycle / Drive queue:
- `analysis_json.confirmed_facts` neobsahuje `session_arc` ani `child_perspective`.
- `session_arc` / `child_perspective` jsou mimo confirmed facts.
- `post_session_result.provenance` existuje.
- auto-derived výsledek je označený jako `auto_derived`.
- missing výsledek je označený jako `missing`.
- 1/5 bez silné evidence dává `evidenceValidity = low`.
- `last_plan_change_state` umí `needs_followup_question`.
- child-facing opener validator fallbackuje při interním obsahu.
- red readiness guard zůstává funkční v UI i backend signoffu.
- `iterate` stále nevytváří 05A write z neschváleného draftu.

## Výstup po implementaci

Poslat pouze:
- změněné soubory
- zda byla potřeba migrace
- jak teď vypadá `analysis_json.confirmed_facts`
- kam se přesunuly AI shrnutí / interpretace
- jak funguje `post_session_result.provenance`
- nové pravidlo `evidenceValidity`
- jak funguje `needs_followup_question`
- jak funguje child-facing opener validator
- výsledky checků
- co zůstává mimo scope