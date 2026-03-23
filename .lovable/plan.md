

# Oprava systému "Plán sezení na dnes" — implementační plán

## Současný stav (z auditu kódu)

- **Tabulka `did_daily_session_plans`**: Nemá UNIQUE constraint (už odstraněn dříve), ale **chybí sloupce** `generated_by`, `completed_at`, `part_tier`, `session_lead`, `session_format`
- **Cron job ID 23**: Schedule `50 11 * * *` (13:50 CET) — potřeba přepsat na `0 5 * * *`
- **Edge funkce**: Nefiltruje sleeping části (řádek 152-181 scoring), při override DELETUJE starý plán (řádek 304-307), čte kartu + operativní plán z Drive ale NE celé 00_CENTRUM dokumenty
- **UI**: Načítá `.maybeSingle()` (max 1 plán), chybí smazat/dokončit/přegenerovat tlačítka

## Změny

### 1. Migrace: přidat sloupce

```sql
ALTER TABLE did_daily_session_plans 
  ADD COLUMN IF NOT EXISTS generated_by text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS part_tier text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS session_lead text NOT NULL DEFAULT 'hanka',
  ADD COLUMN IF NOT EXISTS session_format text NOT NULL DEFAULT 'osobně';
```

### 2. Cron job: reschedule (via data INSERT tool)

- DELETE job ID 23
- INSERT new: `0 5 * * *` (5:00 UTC ≈ 6:00 CET)

### 3. Edge funkce `karel-did-auto-session-plan/index.ts`

**Striktní tier filtrování:**
- Po scoring: vyřadit VŠECHNY části s `tier === "sleeping"` (ne jen CAP)
- Pokud nezbude žádná část → vrátit `{ success: false, reason: "no_active_parts" }` + log
- Fallback na "oldest sleeping" ODSTRANĚN

**Existující plán check:**
- `.select("id, generated_by")` kde `generated_by = 'auto'` a dnešní datum
- Manuální override: INSERT nový (NE delete starého)

**Čtení karet + 00_CENTRUM (DOPLNĚK A):**
- Rozšířit Drive čtení: po nalezení karty části, načíst i klíčové 00_CENTRUM dokumenty (Dashboard, Index, Instrukce, Mapa vztahů) — truncate každý na 1500 chars
- Tyto dokumenty přidat do userContent pro AI

**Perplexity search (DOPLNĚK B):**
- Již existuje (`searchPerplexity` řádek 221-246) — rozšířit dotaz o diagnózu/potřeby z karty části
- Timeout 25s (už nastaveno)

**Role Hanka/Káťa:**
- Přidat do systémového promptu instrukci `VEDE: HANKA/KÁŤA`
- Parsovat z AI odpovědi a uložit do nových sloupců `session_lead` + `session_format`

**generated_by + part_tier:** Uložit při INSERT

### 4. UI `DidDailySessionPlan.tsx`

**Data loading:**
- `.maybeSingle()` → `.select("*").eq("plan_date", today).order("created_at", { ascending: false })`
- State: `plans: SessionPlan[]`

**Interface rozšíření:**
- Přidat `generated_by`, `completed_at`, `session_lead`, `session_format` do `SessionPlan`

**Zobrazení fronty:**
- Nejnovější pending plán nahoře (rozbalitelný)
- Done/skipped plány pod ním (sbalené, šedé) — NEMIZÍ po refreshi
- Badge s `session_lead`: "VEDE: Hanka (osobně)" / "VEDE: Káťa (chat)"

**Nová tlačítka u každého plánu:**
- ✅ Dokončeno → UPDATE `status='done', completed_at=now()`
- 🗑 Smazat → `window.confirm()` → DELETE z DB
- 🔄 Přegenerovat → nový INSERT (starý zůstane)

**Globální tlačítko:** "➕ Vygenerovat nový plán" vždy viditelné

**Live session:** Napojit na první pending plán

**Text 13:50 → 6:00:** Update informační text

## Soubory k úpravě

1. **DB migrace** — 5 nových sloupců
2. **Cron job** — reschedule job 23 na `0 5 * * *`
3. **`supabase/functions/karel-did-auto-session-plan/index.ts`** — tier filtr, ne-delete, 00_CENTRUM čtení, Perplexity rozšíření, role Hanka/Káťa, generated_by
4. **`src/components/did/DidDailySessionPlan.tsx`** — pole plánů, smazat, dokončit, přegenerovat, session_lead badge

## Co se NEZMĚNÍ
- Live session flow (DidLiveSessionPanel) — jen napojení na první pending plán
- Drive write logika
- Urgency scoring algoritmus (jen striktní filtr sleeping)
- Preference dialog

