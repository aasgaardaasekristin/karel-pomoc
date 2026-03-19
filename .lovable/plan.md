

# Oprava: Karel neví kdo s ním mluví + barva tlačítka "Ukončit hovor"

## Nalezený bug

### Příčina č. 1: `didPartName` se nikdy neinjektuje do system promptu
- Frontend posílá `didPartName: activeThread.partName` (řádek 1421 v Chat.tsx)
- Edge funkce `karel-chat/index.ts` ho přijme na řádku 14: `const { ... didPartName ... } = await req.json()`
- **Ale nikdy ho nepoužije.** Žádný řádek v celém souboru nepřidá `didPartName` do `systemPrompt`.
- Proto Karel neví, kdo s ním mluví, a ptá se znovu "Jsi to ty, Artur?"

### Příčina č. 2: `threadLabel` / `enteredName` se neposílá
- Frontend posílá jen `didPartName: activeThread.partName` (canonical = "Arthur")
- Ale neposílá `threadLabel` ("Tundrupek") ani `enteredName` ("tundrupek")
- Karel tedy nemá info, jakým jménem se část představila

### Příčina č. 3: System prompt říká "polož 2-4 otázky na identifikaci"
- Řádky 389-396 v `systemPrompts.ts` instruují Karla, aby se na začátku vždy ptal "Jak ti mám říkat?", "Jsi nahoře nebo dole?" atd.
- To je správné pro obecný případ, ale ŠPATNĚ pokud už část byla detekována z registru — tehdy Karel ví kdo mluví a musí rovnou navázat

## Plán opravy

### 1. `karel-chat/index.ts` — injektovat identitu části do system promptu
- Po řádku ~38 (kde se injektuje `didSubMode`), přidat nový blok:
  - Pokud `didSubMode === "cast"` a existuje `didPartName`:
    - Injektovat do system promptu: `"IDENTIFIKOVANÁ ČÁST: [partName]. Tato část byla detekována z registru. Karel VÍ kdo s ním mluví. NEPTEJ SE na jméno znovu."`
  - Pokud existuje i `didThreadLabel` (nově posílaný):
    - Injektovat: `"Část se představila jako: [threadLabel]. Interně jde o část [partName]."`

### 2. `Chat.tsx` řádek 1421 — posílat i `threadLabel` a `enteredName`
- Rozšířit request body o:
  ```
  didThreadLabel: activeThread.threadLabel
  didEnteredName: activeThread.enteredName
  ```

### 3. `systemPrompts.ts` řádky 389-396 — podmínit identifikační otázky
- Upravit text sekce "IDENTIFIKACE ČÁSTI": 
  - "Pokud systém poskytl IDENTIFIKOVANOU ČÁST, Karel VÍ kdo mluví a NEPTÁ SE na jméno. Rovnou navazuje s plnou návazností z karty."
  - "Orientační otázky použij POUZE pokud nebyla poskytnuta identifikace části."

### 4. `DidActionButtons.tsx` — změnit barvu tlačítka "Ukončit hovor"
- Nahradit `variant="destructive"` (červená/oranžová) za jemnější styl
- Použít `variant="outline"` s tlumenou červenou/šedou: `className="... border-muted-foreground/30 text-muted-foreground hover:bg-muted"`
- Výsledek: tlačítko bude vizuálně subtilnější, ne "pěst na oko"

## Soubory k úpravě

| Soubor | Změna |
|--------|-------|
| `supabase/functions/karel-chat/index.ts` | Injektovat `didPartName` + `didThreadLabel` do system promptu pro cast mode |
| `src/pages/Chat.tsx` | Posílat `didThreadLabel` a `didEnteredName` v request body |
| `supabase/functions/karel-chat/systemPrompts.ts` | Podmínit identifikační otázky — neptát se když je část známá |
| `src/components/did/DidActionButtons.tsx` | Změnit barvu "Ukončit hovor" na jemnější |

