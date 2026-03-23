

# Urychlení živé asistence — snížení latence

## Analýza problému

Aktuální flow posílá při **každé zprávě**:
1. **Obrovský system prompt** (~4000+ tokenů) — plný `basePrompt` (124 řádků osobnosti Karla) + `supervisionPrompt` — většina je irelevantní pro live asistenci (tréninkové simulace, kvízy, SOAP zápis...)
2. **Celou historii zpráv** bez limitu — po 10 výměnách to je tisíce tokenů
3. **buildContext()** — plán sezení posílaný jako `didInitialContext` pokaždé znovu

Výsledek: AI gateway musí zpracovat obrovský input → pomalý time-to-first-token (15-30s).

## Řešení (3 optimalizace)

### 1. Dedikovaný lehký system prompt pro live asistenci

Místo posílání celého `supervisionPrompt` (basePrompt + supervize + trénink + simulace) vytvořit nový mode `"live-session"` s kompaktním promptem (~800 tokenů místo ~4000):
- Pouze: kdo jsi, jak odpovídat v live, formátování
- Žádné: archetypy, tréninkové simulace, kvízy, SOAP, vztah k mamce

**Soubor:** `supabase/functions/karel-chat/systemPrompts.ts` — přidat `liveSession` prompt
**Soubor:** `supabase/functions/karel-chat/index.ts` — rozšířit fast-path na `mode === "live-session"`

### 2. Omezit historii zpráv na posledních 16

V `LiveSessionPanel.tsx` při volání `requestLiveReply` oříznout `messagesForAI` na posledních 16 zpráv. Starší kontext je zachycen v plánu sezení.

**Soubor:** `src/components/report/LiveSessionPanel.tsx`

### 3. Použít rychlejší model pro live

Přepnout z `gemini-3-flash-preview` na `google/gemini-2.5-flash` pro live asistenci — nižší latence, stále kvalitní výstup pro krátké odpovědi.

**Soubor:** `supabase/functions/karel-chat/index.ts` — v live-session fast-path použít `gemini-2.5-flash`

## Očekávaný efekt

- Snížení input tokenů o ~70% → time-to-first-token z 15-30s na 3-8s
- Rychlejší model → nižší latence generování
- Zachování kvality — live prompt je cílený na konkrétní úkol

## Soubory ke změně
- `supabase/functions/karel-chat/systemPrompts.ts` — nový `liveSession` prompt
- `supabase/functions/karel-chat/index.ts` — nový mode `"live-session"` ve fast-path, rychlejší model
- `src/components/report/LiveSessionPanel.tsx` — posílat `mode: "live-session"`, oříznout historii na 16 zpráv

