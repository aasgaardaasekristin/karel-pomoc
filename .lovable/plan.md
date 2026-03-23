

# Oprava: Uložení analýzy Jiřího Trpitele selhalo + UI vyskočil z karty

## Zjištění
1. V DB je 0 analýz pro Jiřího Trpitele — save skutečně selhal
2. Pro Františka save fungoval — kód samotný je funkční, problém je specifický pro tento případ
3. Dva oddělené problémy: **(A)** save tiše selže, **(B)** UI resetuje výběr klienta

## Příčina A — Selhání uložení
`client_analyses` je řádně v typech Supabase, ale kód používá `as any` cast, čímž obchází typovou kontrolu. Kombinace `.insert().select().single()` s `as any` může v některých případech vrátit `error` objekt, který projde kontrolou `if (error) throw error` ale `data` je null. Případně `sanitizeResultForSave` může vrátit objekt kde `clientProfile` je prázdný string — pak `summary` bude `""` ale to by nemělo selhat.

Hlavní podezření: race condition — pokud uživatel přepne klienta nebo tab během generování analýzy, `clientId` prop se změní, ale `result` stále odpovídá starému klientovi. Insert pak vloží data s nekonzistentním `client_id`.

## Příčina B — Vyskočení z karty
`CardAnalysisPanel` je renderován podmíněně na `selectedClient`. Pokud během 15-30s generování analýzy dojde k jakémukoliv re-renderu, který resetuje `selectedClient` na null (např. přes context change z `ActiveSessionsContext`), celý panel se odmountuje a výsledek je ztracen. `result` state se ztrácí, save tlačítko zmizí.

## Řešení

### 1. `CardAnalysisPanel.tsx`
- Odstranit `as any` z `client_analyses` queries — tabulka je v typech
- Zachytit `clientId` do ref při spuštění analýzy, aby save použil správné ID i po přepnutí
- Přidat explicitní `console.error` s detailem chyby do catch bloku
- Přidat guard: pokud `result` existuje ale `clientId` se změnil od generování, upozornit uživatele

### 2. `Kartoteka.tsx`
- Přidat stabilizaci `selectedClient` — neresetovat na null pokud je aktivní async operace (analýza běží)
- Odebrat `as any` z `client_analyses` queries i zde

## Soubory
- `src/components/report/CardAnalysisPanel.tsx`
- `src/pages/Kartoteka.tsx`

