

# Oprava: Asistence se zasekne — spinning loader navždy

## Příčina

Zjištěno z network logu: požadavek na `karel-chat` skončil s `Error: Failed to fetch`. Kód v `requestLiveReply` nemá:

1. **Žádný timeout** — fetch čeká nekonečně. Pokud edge function spadne, reader.read() nikdy nevrátí `done: true`
2. **Žádný AbortController** — nelze přerušit visící request
3. **Žádný retry** — při selhání se zobrazí toast, ale `isLoading` zůstane true pokud catch nezachytí chybu správně (edge case: reader.read() vyhodí po network drop)
4. **Streaming reader může viset** — pokud server přestane posílat data uprostřed streamu (edge function timeout po 60s), `reader.read()` visí navždy bez signálu `done`

Navíc: `buildContext()` posílá celý JSON plán sezení v `didInitialContext` (v tomto případě ~6KB) což je OK, ale zvyšuje pravděpodobnost timeoutu edge funkce.

## Řešení

### 1. `LiveSessionPanel.tsx` — AbortController + timeout + retry

**`requestLiveReply`:**
- Přidat `AbortController` s 90s timeout
- Při timeout: abort request, zobrazit jasnou zprávu ("Karel neodpověděl včas, zkus to znovu")
- Přidat 1 automatický retry při network error (Failed to fetch, AbortError z timeoutu)
- Po finálním selhání: resetovat `isLoading` na false, zobrazit tlačítko "Zkusit znovu" v chatu

**Streaming read loop:**
- Přidat per-chunk timeout (30s) — pokud `reader.read()` nevrátí nic 30s, abort
- Pokud stream selže uprostřed ale máme partial content, ponechat co máme a přidat "(odpověď byla přerušena)"

### 2. `LiveSessionPanel.tsx` — "Zkusit znovu" tlačítko

- Pokud poslední zpráva je user message a `isLoading === false` (= selhání), zobrazit tlačítko "Zkusit znovu" které zavolá `requestLiveReply` se stávajícími messages
- Alternativně: přidat ref `lastFailedMessages` pro retry

### 3. Edge function `karel-chat` — supervision mode fast-path

- Pro `mode === "supervision"` přeskočit pomalé operace (Google Drive fetch, Perplexity, task injection) které jsou relevantní jen pro DID
- Supervision mode by měl jít rovnou na AI gateway bez zbytečných DB/API callů
- To dramaticky sníží latenci a pravděpodobnost timeoutu

## Soubory
- `src/components/report/LiveSessionPanel.tsx` — AbortController, timeout, retry, retry tlačítko
- `supabase/functions/karel-chat/index.ts` — supervision fast-path (přeskočit DID-only bloky)

## Technické detaily
```text
requestLiveReply flow (nový):
  ┌─ AbortController (90s global timeout)
  ├─ fetch() with signal
  ├─ retry 1x on network error
  ├─ reader.read() with per-chunk 30s race
  ├─ on partial success: keep content + "(přerušeno)"
  └─ on total failure: isLoading=false + retry button
```

