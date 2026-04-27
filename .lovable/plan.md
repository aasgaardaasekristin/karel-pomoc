Oprava pravidla je jednoznačná: Herna nikdy nesmí být bez programu. Každé spuštění ranního Karlova přehledu / denního plánování musí vytvořit dva oddělené výstupy:

```text
Karlův přehled / denní cyklus
├─ Sezení na dnes
│  └─ therapist-led program pro Haničku/Káťu
└─ Herna na dnes
   └─ samostatný Karel-led playroom_plan pro přímý kontakt s dítětem/částí
```

## Co změním

1. Upravím generování denního programu tak, aby se při každém běhu vytvořil i samostatný program Herny
   - V `karel-did-auto-session-plan` se už zakládá Karel-direct kandidát, ale dnes je to jen slabý záznam s krátkým markdownem a bez plného `playroom_plan`.
   - Nahradím to povinnou tvorbou plnohodnotného `playroom_plan` v `urgency_breakdown.playroom_plan`.
   - Program Herny bude obsahovat klinicko-praktický návrh pro terapeutky: cíl, proč právě tato část, bezpečnostní rámec, 3–5 remote-native herních bloků, stop signály, fallback, hranice, co Karel nesmí dělat, kritéria ukončení a praktické instrukce pro vstup.
   - Nebude to child-facing opener. Child-facing text vznikne až při vstupu do herny.

2. Oddělím výběr a obsah Herny od „Sezení na dnes“
   - `session_actor: "therapist_led"` zůstane pro dnešní sezení.
   - `session_actor: "karel_direct"`, `ui_surface: "did_kids_playroom"`, `lead_entity: "karel"` bude povinné pro Hernu.
   - Herna nebude číst `plan_markdown` terapeutického sezení jako svůj program.
   - Pokud jsou cílové části stejné, pořád vzniknou dva odlišné programy: jeden pro terapeutky a jeden pro Karla v Herně.

3. Odstraním možnost „Herna nemá vlastní program“ jako normální stav
   - Současná UI hláška „Herna nemá vlastní schválený program“ zůstane jen jako nouzová diagnostická chyba pro poškozená historická data, ne jako očekávaný workflow.
   - Pro dnešní den má systém program Herny buď najít, nebo ho automaticky doplnit přes opravný backendový ensure krok.
   - Vstup do Herny bude dál blokovaný, pokud program není schválený terapeutkami, ale nebude vycházet z předpokladu, že program může chybět.

4. Zpřísním schvalovací workflow Herny
   - V Pracovně se musí zobrazit karta „Herna na dnes“ odděleně od „Sezení na dnes“.
   - Terapeutky budou schvalovat konkrétní playroom program, nikoli terapeutické sezení.
   - Stav bude: `awaiting_therapist_review` → `approved` → `ready_to_start` / `in_progress` → `evaluated`.
   - Tlačítko „Vstup do herny“ se ukáže jen u Karel-direct plánu s existujícím `playroom_plan` a schválením.

5. Doplním safety-net pro historické a rozbité dnešní záznamy
   - Pokud existuje dnešní Karel-direct záznam bez `playroom_plan`, backend ho neopustí jako „bez programu“.
   - Doplní mu plnohodnotný `playroom_plan` z dostupných dat: registry, recent threads, session memory, did_daily_context / Pantry A a případně profile data.
   - To je oprava integrity, ne náhradní režim bez programu.

6. Napojím Hernu při spuštění na její vlastní program
   - `karel-part-session-prepare` bude při `plan_id` validovat:
     - plán je Karel-direct,
     - `ui_surface` je `did_kids_playroom`,
     - `playroom_plan` existuje,
     - je schválený.
   - Do child-facing openeru půjde jen bezpečný výtah z playroom programu, nikoli terapeutické interní poznámky.

7. Zpřísním `karel-chat` pro live Hernu
   - Herna dostane hidden runtime kontext výhradně z `playroom_plan`, nikoli ze „Sezení na dnes“.
   - Poslední vstup dítěte / příloha bude povinný rozhodovací bod odpovědi.
   - Runtime chyby a 503 fallback zůstanou technicky označené tak, aby se nikdy nebraly jako klinický obsah.

8. Upravím reporting
   - „Včerejší herna“ bude samostatná sekce založená na Playroom payloadu a playroom review.
   - „Vyhodnocení včerejšího sezení“ zůstane samostatně pro therapist-led session.
   - Evaluace Herny bude odkazovat na schválený `playroom_plan`, nikoli na terapeutický `plan_markdown`.

## Technické změny

- `supabase/functions/karel-did-auto-session-plan/index.ts`
  - přidat builder plnohodnotného `playroom_plan`,
  - změnit `deriveKarelDirectContract` / `ensureKarelDirectCandidate`, aby vždy ukládaly samostatný Herna program,
  - idempotentně opravovat dnešní Karel-direct záznamy bez `playroom_plan`.

- `supabase/functions/karel-part-session-prepare/index.ts`
  - tvrdá validace Karel-direct Playroom contractu,
  - používat `playroom_plan` jako jediný zdroj pro Hernu,
  - child opener generovat pouze z bezpečného výtahu.

- `supabase/functions/karel-chat/index.ts`
  - pro `karel_part_session`/Herna načítat a injektovat schválený `playroom_plan`,
  - nikdy neinjektovat terapeutický program sezení jako program Herny,
  - auditovat model, submode, contract version a fallback status.

- `src/components/did/DidDailySessionPlan.tsx`
  - jasně oddělit kartu „Sezení na dnes“ a „Herna na dnes“,
  - u Herny zobrazit schvalovací klinicko-praktický program,
  - odstranit jazyk, který naznačuje, že Herna normálně může nemít program.

- `supabase/functions/karel-did-session-evaluate/index.ts` a `src/components/did/DidDailyBriefingPanel.tsx`
  - zachovat rozdělení „Včerejší herna“ vs. „Vyhodnocení včerejšího sezení“,
  - pro Hernu používat pouze Playroom payload / `playroom_plan`.

## Datová integrita

Použiju stávající tabulku `did_daily_session_plans`, protože už obsahuje lifecycle, schvalování, audit a vazby na evaluaci. Herna v ní ale bude rozlišena tvrdým contractem:

```text
urgency_breakdown.session_actor = "karel_direct"
urgency_breakdown.ui_surface = "did_kids_playroom"
urgency_breakdown.lead_entity = "karel"
urgency_breakdown.playroom_plan = { ...plný samostatný program Herny... }
```

Tím se zabrání tomu, aby Herna spadla zpět na `plan_markdown` terapeutického sezení.