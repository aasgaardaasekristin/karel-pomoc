

# Fáze 1: DID Context Prime + Online smyčka

## Odpovědi na tvé otázky

**Drive kartoteka_DID** — nemusíš nic měnit. Karel si sám přečte stávající strukturu (00_CENTRUM, karty částí, 01_Index). Žádná reorganizace Drive není potřeba.

**PAMET_KAREL pro DID** — Karel si vytvoří podsložky sám programově (pokud neexistují). Nemusíš nic duplikovat ručně. V rámci Fáze 4 (bootstrap) Karel založí `PAMET_KAREL/DID/` se soubory `MAPA_SYSTEMU.json`, `VZTAHY.json`, `VZORCE.json` — analogicky k `_SEMANTIC` složce pro Hanu.

**Live sezení pro DID** — zahrneme to do Fáze 3 nebo jako samostatnou pod-fázi. Adaptujeme `LiveSessionPanel` (chat + audio segmenty + real-time rady) pro DID kontext — Karel bude mít kontext z karty konkrétní části, bude radit terapeutce (Hance/Káťě) v reálném čase při práci s částí.

---

## Co implementuje Fáze 1

### 1. Nová edge function: `karel-did-context-prime`

Kopíruje architekturu `karel-hana-context-prime` (543 řádků), ale sestavuje DID-specifickou cache:

**Datové zdroje (paralelní harvest):**
- Drive: `00_CENTRUM` (Dashboard, Operativní plán, Strategický výhled), karta konkrétní části (pokud zadána), `PAMET_KAREL/DID/` (pokud existuje)
- DB: `did_threads` (posledních 10), `did_conversations` (posledních 10), `karel_hana_conversations` (sken pro DID zmínky), `karel_episodes` WHERE domain='DID', `karel_semantic_*`, `karel_strategies` WHERE domain='DID', `did_therapist_tasks`
- Perplexity: DID-specifické novinky

**Výstup:** JSON `{ contextBrief: string, partCard?: string, systemState: string }`

**Spouštění:** Automaticky při otevření DID vlákna (cast/mamka/kata) + manuálně z dashboardu

### 2. Úprava `karel-chat/index.ts`

Nahradit statický `didInitialContext` z UI dynamickým voláním `karel-did-context-prime`:
- Když `mode === "childcare"` → backend volá context-prime (interní fetch)
- Výsledek se injektuje do system promptu místo raw `didInitialContext`
- UI stále může posílat `didInitialContext` jako fallback, ale backend ho obohatí

### 3. Online smyčka (2-krokový processing)

Přidat do `karel-chat` pro DID režim stejný pattern jako `karel-hana-chat`:
1. **Krok 1 (analýza):** Flash Lite klasifikuje vstup — detekce aktivní části, emoční stav, domain
2. **Krok 2 (odpověď):** Hlavní model odpovídá s plnou situační cache

### 4. DID epizody po sezení

Po ukončení vlákna (nebo po 30min neaktivity) automaticky vygenerovat strukturovanou epizodu do `karel_episodes` s:
- `domain: 'DID'`
- DID-specifická metadata v `tags`: `['part:Arthur', 'submode:cast', 'therapist:Hanka']`
- `participants`: jména aktivních částí

### 5. Frontend: auto-prime při otevření vlákna

V `DidEntryScreen` / thread open → automatický fetch na `karel-did-context-prime` (500ms po mount, jako u Hany) → toast "Karel se připravuje..."

---

## Soubory k vytvoření/úpravě

| Soubor | Akce |
|--------|------|
| `supabase/functions/karel-did-context-prime/index.ts` | NOVÝ — hlavní context-prime pro DID |
| `supabase/functions/karel-chat/index.ts` | UPRAVIT — backend volání context-prime místo raw didInitialContext |
| `supabase/config.toml` | **NE** (auto-managed) |
| `src/components/did/DidEntryScreen.tsx` | UPRAVIT — auto-prime při otevření |
| `src/hooks/useDidThreads.ts` | UPRAVIT — epizoda po ukončení vlákna |

Žádné DB migrace v této fázi — využíváme stávající tabulky (`karel_episodes`, `karel_semantic_*`, `did_threads`).

