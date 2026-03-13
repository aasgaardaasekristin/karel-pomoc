

## Plán: Kartotéka Health Check + Auto-Prep Before Chat + Talent & Growth Profile (Sekce H)

### Návrh 1: Kartotéka Health Check — automatický audit integrity karet

**Nová DB tabulka** `did_kartoteka_health`:
- `id`, `user_id`, `part_name`, `health_score` (0-100), `missing_sections` (text[]), `stale_sections` (text[]), `total_sections`, `filled_sections`, `last_checked` (timestamptz), `created_at`
- RLS: authenticated users read/insert/update own records

**Nová Edge Function** `karel-did-kartoteka-health`:
- Přečte VŠECHNY karty z Drive (01_AKTIVNI + 03_ARCHIV)
- Pro každou kartu parsuje sekce A-M pomocí `parseCardSections()`
- Vyhodnotí: prázdné sekce ("zatím prázdné"), stub data (< 20 znaků), sekce starší 14 dní (parsuje `[YYYY-MM-DD]` timestamps)
- Health score = (filled_sections / 13) * 100, penalizace za stale sections
- Upsert výsledky do DB
- Automaticky vygeneruje úkoly typu "Doplnit sekci I u Arthura" do `did_therapist_tasks`

**Nový UI panel** `DidKartotekaHealth.tsx`:
- Zobrazuje se v dashboardu pod Colleague View
- Seznam karet seřazený dle health score (nejhorší nahoře)
- Barevné indikátory: 🔴 <50%, 🟡 50-79%, 🟢 ≥80%
- Kliknutí rozbalí detail: které sekce chybí, které jsou zastaralé
- Tlačítko "Auditovat kartotéku" pro manuální spuštění

**Soubory:**
- Migrace: nová tabulka + RLS
- `supabase/functions/karel-did-kartoteka-health/index.ts` (nová)
- `src/components/did/DidKartotekaHealth.tsx` (nová)
- `src/components/did/DidDashboard.tsx` (integrace panelu)

---

### Návrh 2: Auto-Prep Before Chat — Karel si automaticky načte kartu

**Problém:** Když terapeut vybere sub-mode (mamka/kata) nebo část (cast), Karel čeká na manuální "Příprava na sezení". Context se načítá jen z centrum docs.

**Řešení:** Rozšířit stávající flow v `Chat.tsx`:
- Při výběru části v `handlePartSelected()` — **již funguje** (řádky 527-541 a 560+): systém načítá `karel-did-drive-read` na pozadí
- **Nové:** Při výběru mamka/kata sub-mode v `handleSubModeSelect()` automaticky:
  1. Načíst poslední 3 vlákna z DB pro daného terapeuta (`did_threads` where sub_mode = mamka/kata)
  2. Načíst pending tasks pro daného terapeuta z `did_therapist_tasks`
  3. Načíst motivation profile z `did_motivation_profiles`
  4. Injektovat to vše do `didInitialContext` PŘED prvním message
- Tím Karel VŽDY vstoupí do rozhovoru plně připraven — s přehledem úkolů, posledních rozhovorů a motivačním profilem

**Soubory:**
- `src/pages/Chat.tsx` — rozšíření handleSubModeSelect pro mamka/kata auto-prep
- Žádná nová edge funkce — využijeme supabase client přímo z UI

---

### Návrh 3: Talent & Growth Profile — obohacení Sekce H karet

**Problém:** Sekce H ("Dlouhodobé cíle") je generická. Chybí systematický profil talentů a edukační plán.

**Řešení:** Rozšířit AI instrukce v denním a týdenním cyklu:

**V denním cyklu** (`karel-did-daily-cycle`):
- Přidat do system promptu instrukci pro sekci H:
  - "Pokud z rozhovoru vyplyne nová schopnost, zájem nebo talent části, zapiš ji do sekce H ve formátu: `TALENT: [oblast] | ÚROVEŇ: [začátečník/pokročilý/expert] | AKTIVITA: [co dělat pro rozvoj] | ZDROJ: [odkud info]`"
  - "Dlouhodobé cíle formuluj nejen terapeuticky, ale i edukačně — jak využít talent části pro její rozvoj a uplatnění"

**V týdenním cyklu** (`karel-did-weekly-cycle`):
- Rozšířit sekci F v AI promptu ("TALENTY A POTENCIÁL ČÁSTÍ"):
  - "Pro každou část s identifikovaným talentem navrhni 2-3 konkrétní aktivity s Perplexity výzkumem"
  - "Formát: TALENT_PLAN: [část] | [talent] | [3 konkrétní aktivity] | [zdroje]"
- Perplexity research query rozšířit o: "educational activities for DID alters with specific talents (music, physics, art)"

**Soubory:**
- `supabase/functions/karel-did-daily-cycle/index.ts` — rozšíření system promptu (sekce H instrukce)
- `supabase/functions/karel-did-weekly-cycle/index.ts` — rozšíření AI promptu (talent mapping + Perplexity query)

