

## Komplexní architektonický audit a plán refaktoru Karel DID systému

---

### ČÁST 1: Rozdělit monolitický `karel-did-daily-cycle` (4555 řádků)

**Problém:** Jedna funkce dělá 10 věcí sekvenčně. Selhání kroku 2 (Drive token) zastaví kroky 3-10. Email na řádku ~4006 nikdy nepřijde, pokud selže cokoli před ním.

**Navrhovaná architektura — 4 samostatné funkce:**

```text
┌─────────────────────────────────────────────────────┐
│  DŘÍVE: karel-did-daily-cycle (4555 řádků, vše)     │
│  ────────────────────────────────────────────────── │
│  1. Drive auth + čtení/zápis karet                  │
│  2. Normalizace                                     │
│  3. Sběr DB dat                                     │
│  4. AI analýza + CENTRUM                            │
│  5. Profilace částí                                  │
│  6. EMAIL (závislý na 1-5)                           │
│  7. Auto-meeting, feedback, cleanup                  │
└─────────────────────────────────────────────────────┘

          ↓ rozdělit na ↓

┌────────────────────────────┐  ┌──────────────────────┐
│ karel-did-daily-cycle      │  │ karel-did-daily-email │
│ (~3500 řádků)              │  │ (~400 řádků, NOVÁ)   │
│ Drive karty + CENTRUM +    │  │ POUZE DB data →      │
│ profilace + feedback +     │  │ AI email → Resend    │
│ cleanup                    │  │ 0 Drive calls        │
│ BEZ emailu                 │  │ Nezávislá na 1.      │
└────────────────────────────┘  └──────────────────────┘
          cron: 06:00, 14:00           cron: 06:15, 14:15
          catch-up: 15:30, 17:00       catch-up: 16:00, 17:30
```

---

### ČÁST 2: Nová funkce `karel-did-daily-email`

**Datové zdroje (výhradně DB, 0 Drive calls):**
- `did_threads` — 24h, všechny sub_modes (cast, mamka, kata)
- `did_conversations` — 24h
- `karel_hana_conversations` — 24h
- `research_threads` — 24h
- `did_part_registry` — aktuální stav
- `did_therapist_tasks` — otevřené + nedávno splněné
- `did_meetings` — otevřené
- `did_update_cycles` — poslední weekly + monthly `report_summary` (střednědobý/dlouhodobý kontext)
- `client_sessions`, `crisis_briefs`, `karel_episodes` — 24h
- `did_pulse_checks` — 7d
- `did_motivation_profiles` — pro adaptivní tón emailu
- `did_task_feedback` — 24h (audit Karlovy komunikace)

**Klíčová logika:**
1. Rozdělit 24h vlákna na "včera odpoledne/večer" vs "dnes" (Prague timezone)
2. Načíst `report_summary` z posledního weekly a monthly cyklu jako střednědobý kontext
3. Cross-mode audit: projít VŠECHNY režimy komunikace za 24h
4. AI generování personalizovaného emailu pro Hanku a Káťu (reuse stávajícího promptu z řádků 4029-4163)
5. Odeslání přes Resend
6. Záznam do `did_daily_report_dispatches` (dedup max 1/den/osoba)

**Záruky:**
- Email se pošle i když Drive token expiroval
- Email se pošle i když daily-cycle vůbec neběžel
- Email se pošle i když AI analýza karet selhala

---

### ČÁST 3: Sloučit "Aktualizovat kartotéku" a "Zrcadlit do Drive"

**Audit současného stavu:**

| Funkce | Tlačítko | Co dělá | Kde je |
|--------|----------|---------|--------|
| `handleManualUpdate` | "Aktualizovat kartotéku" | Volá `karel-did-daily-cycle` → Drive karty + CENTRUM + registry sync | DidActionButtons (v terapeutickém vlákně), DidSprava (dashboard) |
| `handleMirrorToDrive` | "Zrcadlit do Drive" | Volá `karel-memory-mirror` → DB entity/vzorce/strategie + Drive PAMET_KAREL + KARTOTEKA_DID | HanaChat (Správa popover) |

**Problém:** Obě funkce dělají podobnou věc — redistribuují nová data z konverzací do Drive a DB. Ale:
- `karel-did-daily-cycle` (manuální trigger) zapisuje do KARTOTEKA_DID karet a CENTRUM dokumentů
- `karel-memory-mirror` zapisuje do PAMET_KAREL (semantic, procedural, episodes) + KARTOTEKA_DID karet + CENTRUM + ZALOHA

**`karel-memory-mirror` je komplexnější** — dělá vše co daily-cycle + navíc PAMET_KAREL.

**Řešení:**
1. **Zachovat JEDNO tlačítko: "Aktualizovat kartotéku"** — ale přepojit na `karel-memory-mirror` místo `karel-did-daily-cycle`
2. **Odstranit "Zrcadlit do Drive"** z HanaChat jako samostatné tlačítko (mirror se stane součástí "Aktualizovat kartotéku")
3. **V DidActionButtons** (tlačítko ve vlákně terapeutek) přepojit `onManualUpdate` na volání mirror engine
4. **V DidSprava** přepojit "Aktualizovat kartotéku" na mirror engine
5. **`karel-did-daily-cycle`** zůstane jen pro cron (automatický Drive sync) — manuální trigger z UI půjde přes mirror

**Logická kontrola:**
- Mirror zapisuje do PAMET_KAREL (entity, vzorce, strategie) → ✅ komplexnější než daily-cycle
- Mirror zapisuje do KARTOTEKA_DID karet → ✅ stejné jako daily-cycle
- Mirror zapisuje do CENTRUM dokumentů → ✅ stejné jako daily-cycle
- Mirror zapisuje do ZALOHA → ✅ navíc oproti daily-cycle
- Mirror NEMÁ registry sync (backfill C-F) → potřeba přidat do mirror flow nebo ponechat jako separátní fázi po dokončení

---

### ČÁST 4: Přesunout administrativní funkce do Správy (ozubené kolečko)

**Audit — co je na dashboardu a co by mělo být ve Správě:**

| Komponenta | Aktuálně | Doporučení | Důvod |
|------------|----------|------------|-------|
| `DidSystemOverview` (Přehled Karla) | Dashboard hlavní | ✅ Zůstává — denní operativní info |
| `DidTherapistTaskBoard` (Úkoly) | Dashboard | ✅ Zůstává — denní práce |
| `DidAgreementsPanel` (Týdenní analýza) | Dashboard | ✅ Zůstává — strategická info |
| `DidMonthlyPanel` (Měsíční analýza) | Dashboard | ✅ Zůstává — strategická info |
| `DidPulseCheck` | Dashboard | ✅ Zůstává — rychlý dotazník |
| `DidColleagueView` | Dashboard | ✅ Zůstává — týmový přehled |
| `DidRegistryOverview` (Přehled registru) | Dashboard | ⚠️ **Přesunout do Správy** — administrativní nástroj, ne denní operativa |
| `DidKartotekaHealth` (Zdraví kartotéky) | Dashboard | ⚠️ **Přesunout do Správy** — diagnostický nástroj |
| `DidSystemMap` (Mapa systému) | Dashboard dole | ⚠️ **Zvážit** — vizualizace je užitečná, ale ne denní nástroj |

**Ve Správě (DidSprava) již jsou:**
- Aktualizovat kartotéku
- Audit zdraví kartotéky (spouštěč, ne panel)
- Přeformátovat karty
- Bootstrap DID paměti
- Nastavení vzhledu

**Doporučení:**
1. Přesunout `DidKartotekaHealth` panel do Správy jako nový tab "Zdraví"
2. Přesunout `DidRegistryOverview` do Správy jako nový tab "Registr"
3. Tím se dashboard zjednoduší na operativní přehled (Overview + Tasks + Weekly + Monthly + Pulse + Colleague)

---

### ČÁST 5: Vylepšení spolehlivosti a inteligence

**5a. Retence dat — audit:**
- `did_threads` se NEMAZOU — zůstávají neomezeně → ⚠️ **Potenciální problém** za 6-12 měsíců (tisíce vláken)
- **Řešení:** Přidat archivační logiku do daily-cycle — vlákna starší 30 dní s `is_processed = true` přesunout do archivní tabulky nebo soft-delete. Karel musí nejdřív extrahovat klíčové poznatky do episodické paměti/entit.

**5b. Duplicitní Drive helpers:**
- `getAccessToken()`, `findFolder()`, `readFileContent()`, `listFilesInFolder()` jsou zkopírované ve 4+ edge funkcích
- **Řešení:** Extrahovat do `supabase/functions/_shared/drive.ts` — sdílená utilita

**5c. Oprava runtime bugů:**
- `finalReportText is not defined` (17.3.) — proměnná je deklarovaná na řádku 2250 ale při early return (řádek 2259) se nestihne naplnit
- **Řešení:** V nové `karel-did-daily-email` tento problém neexistuje (email je nezávislý)

**5d. Cross-mode intelligence:**
- `karel-did-system-overview` již dělá cross-mode scan správně (Hana, research, DID konverzace)
- `karel-did-daily-email` musí replikovat stejný cross-mode scan + přidat weekly/monthly kontext
- **Vylepšení:** Přidat do email promptu explicitní instrukci "Projdi VŠECHNY režimy komunikace za 24h a identifikuj skryté souvislosti napříč režimy"

---

### Soubory k vytvoření/editaci

1. **NOVÝ:** `supabase/functions/karel-did-daily-email/index.ts` — samostatná email funkce (~400 řádků)
2. **EDIT:** `supabase/functions/karel-did-daily-cycle/index.ts` — odstranit email blok (řádky 4003-4165)
3. **EDIT:** `supabase/config.toml` — přidat `[functions.karel-did-daily-email]`
4. **SQL:** Nové cron joby pro `karel-did-daily-email` (06:15, 14:15, 16:00, 17:30 CET)
5. **EDIT:** `src/pages/Chat.tsx` — přepojit `handleManualUpdate` na `karel-memory-mirror` místo `karel-did-daily-cycle`
6. **EDIT:** `src/components/hana/HanaChat.tsx` — odstranit samostatné tlačítko "Zrcadlit do Drive" (funkce se stane součástí "Aktualizovat kartotéku")
7. **EDIT:** `src/components/did/DidDashboard.tsx` — přesunout `DidKartotekaHealth` a `DidRegistryOverview` do Správy
8. **EDIT:** `src/components/did/DidSprava.tsx` — přidat nové taby "Zdraví" a "Registr" pro přesunuté komponenty

### Priority implementace
1. **Kritická:** Nová `karel-did-daily-email` + cron joby (řeší měsíční problém s maily)
2. **Vysoká:** Odstranit email blok z `karel-did-daily-cycle`
3. **Střední:** Sjednotit "Aktualizovat kartotéku" / "Zrcadlit do Drive" na mirror engine
4. **Nízká:** Přesun panelů do Správy, sdílení Drive helpers

