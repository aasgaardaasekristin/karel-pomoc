

# Oprava sekce „Analýzy karty" — kompletní zobrazení + počet sezení

## Problém
1. Sekce „Analýzy karty" se zobrazuje **jen když existují data** — prázdná je neviditelná
2. Zobrazuje se pouze `clientProfile` — chybí **Diagnostika** a **Co příště**
3. Chybí informace o **počtu sezení v době vytvoření** analýzy

## Řešení

### 1. DB migrace — nový sloupec `sessions_count`
Přidat do `client_analyses` sloupec `sessions_count INT` pro uložení počtu sezení v okamžiku vytvoření analýzy.

### 2. `CardAnalysisPanel.tsx` — ukládat `sessions_count`
V fire-and-forget insertu (řádek 107) přidat `sessions_count: data.sessionsCount` do insertu.

### 3. `Kartoteka.tsx` — sekce „Analýzy karty"
- **Vždy zobrazit** sekci (i prázdnou s textem „Zatím žádné analýzy — vygeneruj ji v záložce Analýza")
- V accordion položce zobrazit **všechny 3 části** z uloženého JSON:
  - **Profil**: `clientProfile` + `therapeuticProgress`
  - **Diagnostika**: `diagnosticHypothesis` (primární, diferenciální, důkazy)
  - **Co příště**: `nextSessionRecommendations` (zaměření, techniky, testy)
- V hlavičce každé analýzy: `Analýza č. X – DD.MM.YYYY (Y sezení)`

## Soubory
- **Migrace** — `ALTER TABLE client_analyses ADD COLUMN sessions_count INT`
- **`src/components/report/CardAnalysisPanel.tsx`** — insert s `sessions_count`
- **`src/pages/Kartoteka.tsx`** — rozšířený accordion obsah + vždy viditelná sekce

