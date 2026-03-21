

# Chybějící fáze – 3 mezery k doplnění

## 1. Mirror neoznačuje vlákna jako zpracovaná

**Problem:** `karel-memory-mirror` (tlačítko „Aktualizovat kartotéku") zpracuje vlákna a zapíše do karet, ale **neoznačí je jako `is_processed=true`**. To znamená, že stejná vlákna budou znovu zpracována při dalším spuštění – a také znovu v `daily-cycle`.

Pouze `daily-cycle` má logiku pro marking (`is_processed: true, processed_at: ...`), ale Mirror ji nemá.

**Fix:** Na konec Mirror jobu přidat označení zpracovaných vláken (`did_threads` update `is_processed=true`) pro vlákna sub_mode='cast', která byla zahrnuta do analýzy.

---

## 2. Mirror nespouští Perplexity rešerši per-část (Sekce D)

**Problem:** Požadavek říká: „Karel prohledá internet a najde vhodné terapeutické techniky pro danou část." Mirror ale nemá žádný Perplexity/sonar call. Rešerše existuje pouze v `reformat-cards` (jednorázová) a `daily-cycle` (ale tam je obecná, ne per-část).

**Fix:** Po AI Pass 2 (který generuje card updates) přidat per-část Perplexity volání:
- Query: `"DID terapeutické metody pro [jméno části] – [hlavní téma z vlákna]"`
- Výsledek injektovat do sekce D a do `[CENTRUM:05_Operativni_Plan]` bloků
- Použít stávající Perplexity API key

---

## 3. Mirror netriggeruje task sync po dokončení

**Problem:** Požadavek říká, že po denním cyklu se automaticky spustí synchronizace úkolů do Drive sheetu. Mirror (manuální spuštění) ale `sync-therapist-tasks` nevolá.

**Fix:** Na konec Mirror jobu přidat fetch na `karel-did-drive-write` s mode `sync-therapist-tasks`, stejně jako to dělá `centrum-sync`.

---

## Technické kroky

### Krok A: Mirror – marking processed threads
V `karel-memory-mirror/index.ts`, po úspěšném zápisu karet:
- Sebrat ID všech zpracovaných `cast` vláken
- `supabase.from("did_threads").update({ is_processed: true, processed_at: now }).in("id", threadIds)`

### Krok B: Mirror – Perplexity per-část rešerše
V `karel-memory-mirror/index.ts`, po AI Pass 2:
- Pro každou část, které se card update týká, zavolat Perplexity sonar s cíleným dotazem
- Výsledek přidat do sekce D obsahu karty před zápisem na Drive
- Timeoutovat na 15s per volání, fail-safe (skip on error)

### Krok C: Mirror – auto task sync
Na konec `karel-memory-mirror/index.ts`:
- Fetch `karel-did-drive-write` s `{ mode: "sync-therapist-tasks" }`
- Fire-and-forget (nekritické, log warning on fail)

