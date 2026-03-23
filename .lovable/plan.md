

# Oprava formátu analýz v Kartě

## Příčina
Edge funkce `karel-card-analysis` vrací odpověď, kde `clientProfile` obsahuje konverzační text + celý JSON v markdown bloku (````json ... ````). Kód v `CardAnalysisPanel.tsx` pracuje s `result` objektem správně (po parsování v edge funkci), ale při ukládání do DB se celý result serializuje přes `JSON.stringify(result)` — jenže `result.clientProfile` už obsahuje ten surový text s embedded JSONem.

Výsledek: v Kartotéce `JSON.parse(a.content)` projde, ale `parsed.clientProfile` obsahuje obrovský text se závorkami a JSON bloky. Sekce Diagnostika a Co příště jsou prázdné, protože skutečná data jsou zanořená v tom stringovém poli `clientProfile`.

## Řešení — dvě opravy

### 1. `Kartoteka.tsx` — robustní parsování + tabový formát
- Při parsování `a.content` přidat fallback: pokud `parsed.clientProfile` obsahuje ````json```` blok, extrahovat z něj JSON a přeparsovat
- Nahradit současný accordion obsah (řádky 712-785) za **stejné Tabs** jako v `CardAnalysisPanel.tsx`:
  - `Profil | Diagnostika | Co příště`
  - Identický rendering: primární hypotéza s Badge jistoty, diferenciální dg jako Badge, podpůrné důkazy jako bullet list, zaměření, techniky, testy, otázky
- Zachovat hlavičku accordionu s číslem, datem, počtem sezení a tlačítkem smazat

### 2. `CardAnalysisPanel.tsx` — čistší ukládání
- V `handleSaveToCard` před `JSON.stringify(result)` ověřit, zda `result.clientProfile` obsahuje embedded JSON blok
- Pokud ano, extrahovat čistý JSON a uložit ten místo surového textu
- Tím se zajistí, že nové analýzy se uloží čistě

## Soubory
- `src/pages/Kartoteka.tsx` — parsování + tabový UI
- `src/components/report/CardAnalysisPanel.tsx` — sanitizace před uložením

