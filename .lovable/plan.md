
# Oprava vizualni viditelnosti odkazu v rezimu Profesni zdroje

## Zjisteni z testovani

### Co funguje
- Rezim "Profesni zdroje" se korektne aktivuje kliknutim na tlacitko
- Edge funkce `karel-research` odpovida uspesne (200, ~24s)
- Perplexity API vraci relevantni zdroje a citace
- Gemini syntetizuje odpoved se spravnym Markdown formatem vcetne `[text](url)` odkazu
- ReactMarkdown renderuje `a` tagy s `target="_blank"` spravne
- Odkazy **jsou klikatelne** (potvrzeno observaci DOM), ale...

### Problem
- Odkazy jsou **vizualne neviditelne** – nemaji jinou barvu ani podtrzeni, takze uzivateli splyvaji s beznym textem
- Sekce "Dalsi zajimave odkazy" ve spodnim bloku ("Karlovy poznamky") zobrazuje nazvy bez URL – to zavisi na kvalite Gemini odpovedi, ale vizualni styl odkazu je hlavni problem

## Reseni

### 1. Pridani CSS stylu pro odkazy v prose kontejneru
- **Soubor:** `src/index.css`
- **Zmena:** Pridat styl pro `a` tagy uvnitr `.prose` tridy v assistant zpravach:
  - Barva: zelena/primary (konzistentni s designem aplikace)
  - Podtrzeni
  - Hover efekt
  - Indikace `target="_blank"` (volitelne mala ikona externiho odkazu)

### 2. Uprava ChatMessage – explicitni styl odkazu
- **Soubor:** `src/components/ChatMessage.tsx`
- **Zmena:** Pridat tailwind tridy na `prose` kontejner:
  - `prose-a:text-primary prose-a:underline prose-a:decoration-primary/50 prose-a:hover:decoration-primary`
- Tim se zajisti, ze vsechny Markdown odkazy budou jednoznacne vizualne odlisene

## Ocekavany vysledek
- Vsechny vygenerovane odkazy v odpovedi Karla budou modre/zelene a podtrzene
- Uzivatel na prvni pohled pozna, co je klikatelny odkaz
- Zadne zmeny v backendu ani edge funkcich

## Rozsah
- 1 soubor: `src/components/ChatMessage.tsx` (pridani tailwind trid)
- Pripadne: `src/index.css` (pokud tailwind prose tridy nestaci)
