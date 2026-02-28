
# Vylepšení DID režimu – Komplexní plán

## Shrnutí vize

Transformace DID režimu z manuálního copy-paste workflow (NotebookLM) na plně automatizovaný systém s přímým přístupem ke Google Drive složce **Kartotéka_DID**, automatickým čtením/zápisem karet, deníků a dokumentů, automatickým odesíláním emailů a novými tlačítky pro dítě (deník, vzkaz mamce, vzkaz Káti).

---

## Hlavní změny

### 1. Odstranění Document Gate (NotebookLM)

Aktuálně uživatelka musí ručně kopírovat dokumenty z NotebookLM. Nově Karel automaticky načte potřebné dokumenty z Drive složky **Kartotéka_DID** při vstupu do podrežimu.

- Smazání komponenty `DidDocumentGate.tsx`
- Po výběru podrežimu Karel rovnou zahájí chat
- Nová edge funkce `karel-did-drive-read` načte ze složky Kartotéka_DID relevantní dokumenty (Seznam částí, Mapa systému, kartu části pokud je známá)

### 2. Nová edge funkce: `karel-did-drive-read`

Čte soubory ze složky **Kartotéka_DID** na Google Drive:
- Najde složku Kartotéka_DID (podobně jako backup hledá KARTOTEKA)
- Načte obsah souborů: `00_Seznam_casti.txt`, `01_Hlavni_mapa_systemu.txt`
- Volitelně načte kartu konkrétní části nebo deník podle jména
- Vrátí textový obsah do frontendu, který ho vloží do `didInitialContext`

### 3. Nová edge funkce: `karel-did-drive-write`

Zapisuje/aktualizuje dokumenty ve složce **Kartotéka_DID**:
- Aktualizace karty části, deníku části, handover reportů, supervizních poznámek
- Vytvoření nové karty/deníku pro nově detekovanou část
- Využívá stejný pattern jako `karel-gdrive-backup` (findFile + uploadOrUpdate)

### 4. Tlačítko "Záloha" v DID režimu

Nové tlačítko v UI (vedle "Ukončit rozhovor"), které:
- Zavolá `karel-did-drive-write` s aktuálním obsahem konverzace
- Karel analyzuje chat a aktualizuje relevantní dokumenty v Kartotéka_DID
- Pokud nebylo stisknuto 24h, záloha proběhne automaticky (edge funkce + cron nebo kontrola při dalším vstupu)

### 5. Rozšíření podrežimů (4 tlačítka místo 3)

Aktuální podrežimy: mamka, cast, general. Nově:
1. **Část mluví s Karlem** (cast) -- beze změny účelu
2. **Mamka mluví s Karlem** (mamka) -- supervize
3. **Káťa mluví s Karlem** (kata) -- NOVÝ podrežim pro Kátu
4. **Obecná porada o DID** (general) -- beze změny

### 6. Nová tlačítka v podrežimu "cast" (dítě)

Při aktivním rozhovoru s částí se zobrazí:
- **Zapsat do deníku** -- Karel připraví deníkový zápis, po odsouhlasení dítětem uloží na Drive
- **Vzkaz mamce** -- Karel pomůže dítěti formulovat vzkaz, odešle emailem mamce
- **Vzkaz Káti** -- totéž pro Kátu

Tlačítko "Ukončit hovor" zůstává -- po kliknutí:
1. Karel vygeneruje handover + aktualizace karet
2. Automaticky odešle email mamce (shrnutí rozhovoru, doporučení, plán na večer)
3. Automaticky odešle email Káti (upravená verze)
4. Přepne do režimu "mamka" a čeká

### 7. Automatické emaily po ukončení rozhovoru s částí

Rozšíření edge funkce `karel-email-report`:
- Email mamce: 9bodová struktura (kdo byl přítomen, stav, téma, dynamika, dohody, SOS, dlouhodobé cíle, plán na večer, otázky)
- Email Káti: upravená verze s ohledem na její roli
- Triggernuto automaticky po "Ukončit hovor" v cast režimu

### 8. Automatické přepnutí do supervize po ukončení hovoru s částí

Po ukončení hovoru s částí Karel:
1. Uloží zálohu na Drive
2. Odešle emaily
3. Automaticky přepne `didSubMode` na "mamka" s kontextem z právě ukončeného hovoru
4. Mamka najde Karla připraveného s analýzou a doporučeními

### 9. Aktualizace system promptu

Přepis `childcarePrompt` v `systemPrompts.ts`:
- Odstranění všech referencí na NotebookLM a manuální kopírování
- Karel ví, že má přímý přístup k dokumentům (kontext bude v `didInitialContext`)
- Nové instrukce pro Kátu podrežim
- Instrukce pro automatické emaily
- Rozšířené instrukce pro skrytou diagnostiku, variabilní hry, Perplexity vyhledávání
- Zákaz vymýšlení citací (stejné pravidlo jako v research režimu)

### 10. Perplexity integrace v DID režimu

Když Karel potřebuje vyhledat metody/techniky/výzkumy pro konkrétní část:
- Využije existující Perplexity API (stejný pattern jako `karel-research`)
- Buď inline v chatu, nebo jako součást analýzy po ukončení hovoru
- Nová helper funkce v `karel-chat/index.ts` pro volání Perplexity z chat kontextu

---

## Technické kroky implementace

### Backend (Edge Functions)

1. **`supabase/functions/karel-did-drive-read/index.ts`** -- nová funkce
   - Vstup: `{ documents: ["00_Seznam_casti", "01_Hlavni_mapa", "DID_001_Karta_Gustik", ...] }`
   - Najde složku Kartotéka_DID na Drive
   - Přečte a vrátí obsah požadovaných .txt souborů

2. **`supabase/functions/karel-did-drive-write/index.ts`** -- nová funkce
   - Vstup: `{ updates: [{ fileName: "...", content: "...", mode: "append" | "replace" }] }`
   - Zapíše/aktualizuje soubory ve složce Kartotéka_DID

3. **Úprava `supabase/functions/karel-chat/index.ts`** -- přidání inline Perplexity volání pro DID režim

4. **Úprava `supabase/functions/karel-chat/systemPrompts.ts`** -- přepis childcarePrompt + přidání kataPrompt

5. **Úprava `supabase/functions/karel-email-report/index.ts`** -- podpora pro DID emaily (mamka + Káťa, strukturovaný formát)

### Frontend (React)

6. **Smazání `src/components/did/DidDocumentGate.tsx`**

7. **Úprava `src/components/did/DidSubModeSelector.tsx`** -- přidání 4. tlačítka "Káťa mluví s Karlem"

8. **Nová komponenta `src/components/did/DidActionButtons.tsx`** -- tlačítka Deník/Vzkaz mamce/Vzkaz Káti/Záloha

9. **Úprava `src/pages/Chat.tsx`**:
   - Odstranění Document Gate flow
   - Po výběru podrežimu automaticky načíst dokumenty z Drive a nastavit do `didInitialContext`
   - Přidání DID action buttons v cast režimu
   - Logika pro automatické přepnutí do mamka režimu po ukončení hovoru
   - Tlačítko Záloha

10. **Úprava `src/contexts/ChatContext.tsx`** -- přidání `DidSubMode = "kata"` do typů

---

## Bezpečnostní aspekty

- Drive přístup přes existující OAuth2 (refresh token) -- žádné nové secrets
- Emaily přes existující Resend integraci
- RLS na did_conversations zůstává beze změny
- Veškerá citlivá data zůstávají na Drive (ne v DB)

## Priorita implementace

1. Drive read/write funkce (základ pro vše ostatní)
2. Odstranění Document Gate + automatické načítání
3. Nová tlačítka (deník, vzkaz, záloha)
4. Automatické emaily po ukončení hovoru
5. Podrežim Káťa
6. Perplexity integrace v DID
7. Aktualizace system promptu
