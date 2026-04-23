
# Oprava live sezení: pole není „odříznuté screenshotem“, ale skutečně se k němu nejde doscrollovat

## Co je skutečný problém

Podle kódu jsou tam teď dva layout bugy zároveň:

### 1. Live sezení je v některých vstupech zavřené do nízkého kontejneru
V `DidContentRouter.tsx` a `DidDashboard.tsx` je `DidDailySessionPlan` obalené v:

```tsx
<div className="max-h-[22rem] overflow-auto pr-1">
```

Když `DidDailySessionPlan` přepne do `currentLivePlan`, vyrenderuje už celý `DidLiveSessionPanel`, ale pořád uvnitř tohoto omezeného boxu. To znamená: live sezení se snaží zobrazit „celou místnost“ uvnitř 22rem výšky.

### 2. Uvnitř `DidLiveSessionPanel` nemá overflow správného vlastníka
V `DidLiveSessionPanel.tsx` jsou mimo hlavní scroll tyto bloky:
- header,
- rozbalený plán,
- lišta Poznámka / Fotka / Nahrávat,
- hint karty `KarelInSessionCards`,
- input dole.

Zároveň messages část má:

```tsx
<ScrollArea className="flex-1 min-h-[14rem] ...">
```

To je problém, protože:
- `min-h-[14rem]` brání smrštění,
- nad i pod ní jsou další `shrink-0` bloky,
- rodičovský dialog/container má `overflow-hidden`,
- výsledkem je, že spodní input fyzicky vypadne pod viewport a není kam scrollovat.

To přesně odpovídá tomu, co popisuješ: ne že bys něco uřízla screenshotem, ale scroll owner je špatně navržený.

## Co upravím

### A. Opravím vstupní kontejnery, aby live sezení nebylo zavřené v `max-h-[22rem]`
Změním render v:
- `src/components/did/DidContentRouter.tsx`
- `src/components/did/DidDashboard.tsx`

Tak, aby:
- omezení `max-h-[22rem] overflow-auto` platilo jen pro seznam/plány,
- ale když se otevře skutečné live sezení, renderovalo se mimo tento capped box.

Prakticky: `DidDailySessionPlan` dostane full-height prostor jen v live režimu.

### B. Přestavím `DidLiveSessionPanel` na správný „3-zónový“ layout
V `src/components/did/DidLiveSessionPanel.tsx` upravím strukturu na:

```text
[sticky header]
[scrollovatelný střed]
[sticky input dole]
```

Konkrétně:
- root: `h-full min-h-0 flex flex-col overflow-hidden`
- header: `shrink-0`
- střední oblast: jediný vlastník scrollu, `flex-1 min-h-0 overflow-hidden`
- input dole: `shrink-0 sticky/bottom-safe`

### C. Zruším blokování layoutu přes `min-h-[14rem]`
Messages scroll z:
```tsx
flex-1 min-h-[14rem]
```
na:
```tsx
flex-1 min-h-0
```

Tím se oblast zpráv může zmenšit podle reálného prostoru a input zůstane vidět.

### D. Přesunu hint karty do scrollovatelného středu
`KarelInSessionCards` teď sedí mezi messages a inputem jako samostatný nescrollující blok. Přesunu je do stejné scroll oblasti jako zprávy, aby už nevytlačovaly input pod spodní hranu.

### E. Zmenším „požrání výšky“ nahoře
Aby byl layout stabilní i na 888×744:
- `planExpanded` nastavím defaultně na `false`,
- rozbalený plán ponechám scrollovatelný uvnitř sebe,
- horní tool-strip zůstane kompaktní,
- greeting zpráva může zůstat, ale už nebude schopná vytlačit input mimo obraz.

### F. Přidám tvrdou jistotu, že input je vždy vidět
Po mountu live panelu:
- focus do textarea,
- scroll do spodní části aktivní scroll oblasti,
- při příchodu nových hint karet se nebude měnit pozice inputu.

## Soubory k úpravě

1. `src/components/did/DidLiveSessionPanel.tsx`
   - přestavba layoutu,
   - odstranění `min-h-[14rem]`,
   - přesun hint karet do scroll středu,
   - sticky input dole,
   - defaultně sbalený plán.

2. `src/components/did/DidContentRouter.tsx`
   - zrušit `max-h-[22rem]` wrapper pro live režim.

3. `src/components/did/DidDashboard.tsx`
   - stejné oddělení list režimu vs live režimu.

Volitelně zkontroluji i:
4. `src/components/did/DidDailySessionPlan.tsx`
   - zda není vhodné explicitně rozlišit compact list vs full live render už přímo zde.

## Jak poznám, že je oprava hotová

Na viewportu 888×744 musí platit:

1. Po otevření live sezení je **textové pole dole viditelné hned**.
2. Pokud je nahoře dlouhý obsah, **scrolluje se střed**, ne celý panel naslepo.
3. Hint karty ani rozbalený plán už **nevytlačí input mimo obraz**.
4. Stejně to funguje:
   - v live sezení otevřeném z „Dnes“,
   - i v live sezení otevřeném z poradního dialogu.
5. Terapeutka nemusí „hádat“, kde psát; input je fyzicky pořád na očích.

## Bez backend změn
Tahle oprava je čistě UI/layout. Bez migrací, bez změn databáze, bez změn backend funkcí.
