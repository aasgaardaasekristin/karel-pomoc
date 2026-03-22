

# Analýza karty: vizuální progress + terapeutický plán procesu

## Shrnutí
Tři oblasti změn: (1) vizuální feedback při analýze, (2) nový flow pro generování/editaci/schválení celkového terapeutického plánu procesu, (3) zobrazení plánu v záložce Karta + persistentní uložení.

## Změny

### 1. DB migrace: přidat `clients.therapy_plan`
```sql
ALTER TABLE public.clients ADD COLUMN therapy_plan text DEFAULT '';
```

### 2. Nová edge funkce `karel-therapy-process-plan`
- Vstup: `clientId`, `cardAnalysis` (výsledek analýzy karty), volitelně `modifications` (požadavky terapeuta na úpravy)
- Načte klienta, sezení, úkoly, existující `therapy_plan` z DB
- Pošle na Gemini 2.5 Pro prompt pro sestavení celkového plánu psychoterapeutického procesu:
  - Cíle terapie (krátkodobé, střednědobé, dlouhodobé)
  - Doporučený terapeutický směr/přístup
  - Metody a techniky
  - Fáze terapie s milníky
  - Rizika a kontraindikace
  - Kritéria úspěchu/ukončení
- Vrací JSON + markdown verzi plánu
- Pokud `modifications` je přítomné, prompt říká "uprav existující plán podle požadavků terapeuta"

### 3. `CardAnalysisPanel.tsx` — rozšíření
**A) Vizuální progress při analýze:**
- Přidat animovaný indeterminate progress bar + rotující stavové zprávy ("Čtu kartu klienta...", "Analyzuji sezení...", "Konzultuji zdroje...", "Sestavuji klinický obraz...")
- Místo pouhého `Loader2` spinneru zobrazit plnou progress sekci

**B) Přejmenovat "PLÁN SEZENÍ" → "TERAPEUTICKÝ PLÁN PROCESU":**
- Label + tlačítko "Sestavit plán procesu"
- Spodní action button: "Sestavit terapeutický plán procesu"

**C) Plan generation flow (nové stavy):**
- `planState`: `idle` → `generating` → `review` → `saving` → `saved`
- `generating`: volá `karel-therapy-process-plan`, zobrazí progress
- `review`: zobrazí vygenerovaný plán v markdown + textarea pro poznámky terapeuta
  - Tlačítko "Požádat o úpravy" → přegeneruje s `modifications`
  - Tlačítko "Schválit a uložit" → uloží do DB + Drive záloha
- `saving`: uloží `therapy_plan` do `clients` tabulky, zavolá `karel-gdrive-backup` fire-and-forget pro zálohu do `ZALOHA/{clientId}/Plan_procesu_{clientId}_{datum}.txt`
- `saved`: zobrazí potvrzení

**D) Props rozšíření:**
- Přidat `existingTherapyPlan?: string` prop (z `clients.therapy_plan`)
- Přidat `onPlanSaved?: (plan: string) => void` callback

### 4. `Kartoteka.tsx` — propojení
**A) Rozšířit Client type** o `therapy_plan: string`

**B) Záložka Karta** — na konec (za Poznámky) přidat sekci "Terapeutický plán procesu":
- Zobrazí se jen pokud `selectedClient.therapy_plan` není prázdný
- Renderuje markdown obsah plánu
- Malé tlačítko "Aktualizovat plán" → přepne na záložku Analýza

**C) Propojit `CardAnalysisPanel`:**
- Předat `existingTherapyPlan={selectedClient.therapy_plan}`
- Předat `onPlanSaved` callback → aktualizuje `selectedClient` v lokálním stavu

### 5. Kontext pro Karla — rozšířit edge funkce
V `karel-card-analysis` a `karel-client-session-prep` přidat do kontextu:
```
${client.therapy_plan ? `\nTERAPEUTICKÝ PLÁN PROCESU:\n${client.therapy_plan.slice(0, 1000)}` : ""}
```
Tím Karel při analýze i přípravě sezení ví, jaký je dlouhodobý cíl.

### 6. Drive záloha
Záloha plánu procesu využije existující pattern z `karel-gdrive-backup` — fire-and-forget volání z klienta přes `supabase.functions.invoke("karel-session-drive-backup")` s mode `therapy-plan`. Alternativně: přímé volání `uploadOrUpdate` v rámci nové edge funkce. Použije se folder `ZALOHA/{clientId}/` a soubor `Plan_procesu_{clientId}_{YYYY-MM-DD}.txt`.

## Soubory
- **Migrace**: `ALTER TABLE clients ADD COLUMN therapy_plan text DEFAULT ''`
- **Nový**: `supabase/functions/karel-therapy-process-plan/index.ts`
- **Editovaný**: `src/components/report/CardAnalysisPanel.tsx`
- **Editovaný**: `src/pages/Kartoteka.tsx`
- **Editovaný**: `supabase/functions/karel-card-analysis/index.ts` (1 řádek kontextu)
- **Editovaný**: `supabase/functions/karel-client-session-prep/index.ts` (1 řádek kontextu)

## Co se NEMĚNÍ
- `ClientSessionPrepPanel` (plán sezení zůstává v "Připravit sezení")
- `LiveSessionPanel` (asistence)
- Datový model sessions/tasks

