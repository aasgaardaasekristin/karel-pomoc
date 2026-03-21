

# Post-session reflexe terapeutky

## Proč tento krok

Aktuální flow po ukončení sezení: AI analýza → uložení → auto-úkoly → handoff note → hotovo. Chybí **subjektivní pohled terapeutky** — co cítila, co ji překvapilo, co by příště udělala jinak. Tato data jsou klíčová pro supervizi, detekci přenosu/protipřenosu a zlepšování terapeutického přístupu. Implementačně je to přímočaré — dialog po ukončení sezení, uložení do existující tabulky `did_part_sessions`.

## Co se změní

### 1. Reflexní dialog po ukončení sezení

Místo okamžitého volání `onEnd(report)` se po úspěšné finalizaci zobrazí modální dialog se 3 otázkami:

- **Emoce terapeutky** — jak se cítila během sezení (multiselect z předpřipravených: klidná, nejistá, frustrovaná, dojatá, vyčerpaná, nadějná, úzkostná, překvapená)
- **Co tě překvapilo?** — volný text (1-2 věty)
- **Co bys příště udělala jinak?** — volný text (1-2 věty)

Tlačítko "Přeskočit" umožní dialog zavřít bez vyplnění.

### 2. Uložení do did_part_sessions

Reflexe se uloží jako update do právě vytvořeného záznamu (`savedSessionId`):
- `karel_notes` se rozšíří o sekci `\n\n## REFLEXE TERAPEUTKY\n...`
- Žádná DB migrace — využije existující textové pole

### 3. Obohacení handoff note

Pokud terapeutka vyplní reflexi PŘED generováním handoff note, její postřehy se zahrnou do promptu pro handoff — kolegyně tak dostane i subjektivní pohled.

## Soubor k úpravě

- `src/components/did/DidLiveSessionPanel.tsx` — přidání reflexního dialogu a úprava flow v `handleEndSession`

## Bez DB migrace, bez nových závislostí

Využije existující sloupce v `did_part_sessions` a UI komponenty (Dialog, Button, Badge).

## Technické detaily

- Nový state: `showReflection: boolean`, `reflectionData: { emotions: string[], surprise: string, nextTime: string }`
- Po úspěšné finalizaci se nastaví `showReflection = true` místo okamžitého `onEnd()`
- Dialog používá `<Dialog>` z shadcn/ui
- Po odeslání/přeskočení se zavolá `onEnd(report)`
- Pořadí flow se změní: finalize → save session → auto-tasks → **reflexe dialog** → handoff note → onEnd

