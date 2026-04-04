

## Diagnóza: Proč Arthur nemá žádný záznam v crisis_events

### Dva paralelní, nepropojené systémy

V projektu existují **DVA krizové systémy**, které spolu nekomunikují:

```text
SYSTÉM A (novější):                    SYSTÉM B (starší):
crisis_alerts ──→ crisis_daily_assessments    crisis_events ──→ crisis_session_logs
                                                              ──→ evaluate-crisis
                                                              ──→ planned_sessions
```

**Arthur je POUZE v Systému A:**
- `crisis_alerts`: 1 záznam (ARTHUR, CRITICAL, od 27.3., status ACKNOWLEDGED)
- `crisis_daily_assessments`: 9 denních hodnocení (den 1–9, všechna "crisis_continues", risk "critical")
- `crisis_events`: **0 záznamů** — nikdy vytvořen
- `crisis_session_logs`: **0 záznamů** — závisí na crisis_events
- `planned_sessions`: **0 záznamů** — závisí na crisis_events

### Co konkrétně nefunguje

1. **`karel-crisis-daily-assessment`** (Systém A) každý den zapíše hodnocení a vytvoří `did_therapist_tasks` — ale **NEPLÁNUJE sezení** do `planned_sessions`, **nevolá `evaluate-crisis`**, **neprovádí fázový přechod** (acute→stabilizing→diagnostic).

2. **`daily-cycle` Fáze 5.5** čte POUZE z `crisis_events` (Systém B). Protože Arthur tam nemá záznam → daily-cycle ho **kompletně ignoruje** pro evaluate-crisis, eskalaci, email notifikace i krizové sezení.

3. **`evaluate-crisis`** (Systém B) pracuje s `crisis_events.id` — nikdy nedostane Arthurův alert.

4. **Výsledek**: Karel 9 dní píše "crisis_continues, CRITICAL" do assessments, ale nikdy:
   - Nenaplánoval osobní diagnostický rozhovor
   - Nevyžádal si Arthura k rozhovoru
   - Nevyptal se terapeutek na pozorování
   - Nezměnil fázi krize
   - Neposlal eskalační email

### Plán opravy

**Princip**: Sjednotit oba systémy tak, aby `crisis_alerts` (reálný zdroj krizí) automaticky vytvářel `crisis_events` a naopak — a `daily-cycle` pracoval s oběma.

#### Krok 1: Bridge funkce v daily-cycle
Na začátek Fáze 5.5 přidat logiku: pro každý `crisis_alerts` se statusem ACTIVE/ACKNOWLEDGED, kde neexistuje odpovídající `crisis_events` záznam → automaticky vytvořit `crisis_events` insert (part_name, phase="acute", severity, trigger_description, opened_at).

#### Krok 2: Denní assessment plánuje sezení
V `karel-crisis-daily-assessment`, po uložení assessmentu, přidat insert do `planned_sessions` pokud:
- `decision` = "crisis_continues" a `day_number % 2 === 0` (každý druhý den diagnostický rozhovor)
- NEBO `risk_assessment` = "critical" (každý den sezení)
- NEBO `day_number` >= 7 a žádné planned_session za posledních 48h (eskalace)

#### Krok 3: Assessment generuje otázky pro terapeutky
Rozšířit assessment prompt aby Karel explicitně generoval:
- `interview_request`: boolean — zda Karel VYŽADUJE osobní rozhovor s částí
- `therapist_interview_needed`: boolean — zda Karel potřebuje informace od terapeutek
- Pokud `therapist_interview_needed=true` → vytvořit task s prioritou "urgent" a kategorií "interview"

#### Krok 4: Fázový přechod na základě assessments
V daily-cycle po bridge logice: analyzovat posledních N assessments z `crisis_daily_assessments` a automaticky nastavit fázi v `crisis_events`:
- 3+ dní "crisis_improving" → phase = "stabilizing"
- 3+ dní stable + žádné risk_indicators → phase = "diagnostic"  
- diagnostic score ≥ 65 → phase = "closing"
- Jakýkoli den s risk="critical" po stabilizaci → reset na "acute"

#### Krok 5: Krizový email propojení
D3 logika (krizové emaily) už existuje v daily-cycle ale čte z `crisis_events` — po bridge kroku (1) to bude automaticky fungovat i pro Arthura.

#### Krok 6: Naplánovat okamžité sezení pro Arthura
Jednorázová oprava: insert do `planned_sessions` pro Arthura s prioritou "urgent" a diagnostickým rozhovorem.

### Jak Karel MÁ vyhodnocovat krizový proces (tvé požadavky)

Na základě toho jak jsi mě učil, Karel by měl:

1. **Denně vyhodnocovat stav** — to dělá (crisis_daily_assessments), ale výstupy nemají žádný efekt.
2. **Aktivně plánovat sezení** — Karel musí po každém assessment rozhodnout: "Chci s tou částí mluvit? Potřebuji diagnostický rozhovor? Potřebuji projektivní test?" → a **naplánovat to** (planned_sessions).
3. **Ptát se terapeutek** — Karel musí generovat konkrétní otázky typu "Hanko, viděla jsi Arthura dnes? Jak reagoval na X?" a dostat zpětnou vazbu — ne jen pasivně čekat.
4. **Eskalovat** — pokud krize trvá 7+ dní bez zlepšení, Karel musí zvýšit prioritu, poslat email, a vyžádat diagnostický rozhovor.
5. **Fázový přechod** — Karel musí aktivně posouvat krizi z acute→stabilizing→diagnostic→closing na základě dat z assessments. Teď to NEDĚLÁ.
6. **Osobní rozhovor** — Karel musí mít možnost "vyžádat si" rozhovor s částí (= naplánovat sezení kde Karel vede rozhovor, terapeutka facilituje).

### Soubory k úpravě
- `supabase/functions/karel-did-daily-cycle/index.ts` — bridge + fázový přechod
- `supabase/functions/karel-crisis-daily-assessment/index.ts` — plánování sezení + interview requesty
- Migrace: žádná nová tabulka, jen propojení existujících

