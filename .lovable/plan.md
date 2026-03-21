

# Fáze 6: Koordinace terapeutů

## Stav — co už existuje

Velká část infrastruktury pro koordinaci je na místě:
- **DidColleagueView** — statistiky úkolů (progress bar, streak, styl)
- **DidMeetingPanel** — plnohodnotné porady s Karlem jako moderátorem
- **did_therapist_tasks** — per-therapist status tracking (status_hanka, status_kata)
- **did_pulse_checks** — týdenní emoční pulse
- **did_motivation_profiles** — motivační profily a streaky
- **DidDailySessionPlan + DidLiveSessionPanel** — živé sezení s AI analýzou

## Co chybí

Klíčový gap: **terapeutky nevidí, co dělala kolegyně na sezení**. Session záznamy (`did_part_sessions`) existují v DB, ale nemají UI pro sdílení. Po ukončení sezení s Arthurem Hanka neví, co Káťa s ním dělala minule.

## Plán implementace

### 1. Rozšířit DidColleagueView o "Poslední sezení kolegyně"

Stávající panel zobrazuje jen úkoly. Přidáme sekci s posledními 3-5 sezeními kolegyně z `did_part_sessions`:
- Část, datum, terapeutka
- Zkrácený `ai_analysis` (prvních 150 znaků)
- Kliknutím rozbalení celé analýzy
- Data se načtou z existující tabulky — žádná nová DB migrace

### 2. Nový komponent: DidSessionHandoff

Po ukončení živého sezení (`handleLiveSessionEnd`) automaticky vygenerovat stručnou handoff zprávu pro kolegyni:
- Karel shrne sezení do 3-5 bullet pointů zaměřených na to, co kolegyně potřebuje vědět
- Uloží se do nového sloupce `handoff_note` v `did_part_sessions`
- V dashboardu se zobrazí jako badge/notifikace u DidColleagueView

**DB migrace:** Přidat sloupec `handoff_note text default ''` do `did_part_sessions`.

### 3. Rozšířit DidDailySessionPlan o kontext předchozího sezení

Při zobrazení plánu dne přidat pod plán sekci "Poslední sezení s [část]":
- Kdo vedl (Hanka/Káťa), kdy, jaká byla AI analýza
- Handoff note od kolegyně (pokud existuje)
- Data z `did_part_sessions` — dotaz na poslední záznam pro `selected_part`

### 4. Koordinační alerty v dashboardu

Nový mini-komponent `DidCoordinationAlerts` nad stávajícím DidColleagueView:
- Karel automaticky detekuje situace vyžadující koordinaci:
  - Obě terapeutky pracovaly se stejnou částí v posledních 48h
  - Část měla vysokou emoční intenzitu (z `did_part_registry.last_emotional_intensity >= 4`)
  - Existuje nesplněný úkol starší 5 dnů pro danou část
- Zobrazí jako kompaktní alert s doporučením (max 2-3 alerty)
- Data čistě z existujících tabulek — žádné nové edge funkce

## Technické detaily

**Soubory k vytvoření:**
- `src/components/did/DidSessionHandoff.tsx` — zobrazení handoff note v dashboardu
- `src/components/did/DidCoordinationAlerts.tsx` — alerty vyžadující koordinaci

**Soubory k úpravě:**
- `src/components/did/DidColleagueView.tsx` — přidat sekci posledních sezení kolegyně
- `src/components/did/DidDailySessionPlan.tsx` — přidat kontext předchozího sezení pod plán
- `src/components/did/DidDashboard.tsx` — přidat DidCoordinationAlerts
- `src/components/did/DidLiveSessionPanel.tsx` — po ukončení vygenerovat handoff note

**DB migrace:**
- Přidat `handoff_note text default ''` do `did_part_sessions`

**Žádné nové edge funkce** — handoff note generuje stávající `karel-chat` s upraveným promptem přímo v klientském kódu při ukončení sezení.

