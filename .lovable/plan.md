
Problém jsem dohledal: komponenta `SessionAnalysisView` v `src/pages/Kartoteka.tsx` už existuje, ale do `client_sessions.ai_analysis` se na více místech stále ukládá jen `rec.summary` nebo prostý text, ne celý JSON objekt. Proto se u některých záznamů formátování projeví a u jiných ne, a u aktuálního záznamu je navíc vidět, že se do UI dostává surový JSON string, který parser fakticky nepobral tak, jak měl.

Co upravit:

1. Opravit `SessionAnalysisView` v `src/pages/Kartoteka.tsx`
- přidat robustnější normalizaci vstupu:
  - trim
  - první `JSON.parse(text)`
  - pokud selže a text začíná `{` nebo obsahuje ```json, odstranit code fences přes přesně domluvený regex
  - pokud parse selže i pak, zkusit ještě renderovat `cleaned` přes markdown fallback místo původního textu
- přidat bezpečné větvení pro případy, kdy `summary` existuje, ale ostatní pole jsou objekt/array/string v různých variantách
- upravit vizuál tak, aby nikdy nevypadal jako raw dump:
  - sekce v kartách
  - menší nadpisy
  - seznamy místo JSON bloků
  - žádné `JSON.stringify(...)` ve fallback větvích pro jednotlivé položky

2. Opravit zdroj dat v `src/components/report/SessionIntakePanel.tsx`
- při ukládání do `client_sessions.ai_analysis` ukládat celý výstup jako JSON string, ne jen `rec.summary`
- tedy uložit strukturu obsahující:
  - `transcription`
  - `summary`
  - `analysis`
  - `diagnosticHypothesis`
  - `therapeuticRecommendations`
  - `nextSessionFocus`
  - `questionnaire`
  - `clientTasks`
- tím se nové záznamy budou v Kartotéce renderovat konzistentně přes `SessionAnalysisView`

3. Zachovat kompatibilitu se starými záznamy
- staré textové záznamy dál zobrazovat přes markdown fallback
- záznamy zabalené do ```json ošetřit druhým parse pokusem po odstranění backticků
- záznamy z live asistence, které ukládají čistý text (`karel-session-finalize` / `LiveSessionPanel` flow), ponechat jako textový fallback, dokud se případně nesjednotí i tento pipeline

4. Důvod, proč to teď působí „pořád stejně“
- fix byl jen na vrstvě zobrazení
- ale ukládání z intake flow pořád rozsekává strukturovaný AI výstup do samostatných sloupců a do `ai_analysis` ukládá jen část obsahu
- navíc fallback ve view stále může ukázat surový obsah, když parse neproběhne přesně podle očekávání

Technické poznámky:
- `react-markdown` už v projektu je, není potřeba nic přidávat
- `src/pages/Kartoteka.tsx` už `SessionAnalysisView` používá
- hlavní skutečná oprava je kombinace:
  - lepší parser/render v `Kartoteka.tsx`
  - změna ukládání v `SessionIntakePanel.tsx`

Soubory k úpravě:
- `src/pages/Kartoteka.tsx`
- `src/components/report/SessionIntakePanel.tsx`
