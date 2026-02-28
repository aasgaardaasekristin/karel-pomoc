
# Vylepšení DID režimu – Komplexní plán

## Stav: ✅ IMPLEMENTOVÁNO (fáze 1-7)

## Co bylo provedeno

### ✅ 1. Drive read/write funkce
- `supabase/functions/karel-did-drive-read/index.ts` – čte dokumenty ze složky Kartoteka_DID
- `supabase/functions/karel-did-drive-write/index.ts` – zapisuje/aktualizuje dokumenty

### ✅ 2. Odstranění Document Gate + automatické načítání
- Smazána `DidDocumentGate.tsx`
- Po výběru podrežimu Karel automaticky načte dokumenty z Drive
- Loading indikátor během načítání

### ✅ 3. Nová tlačítka (deník, vzkaz, záloha)
- `DidActionButtons.tsx` – Zapsat do deníku, Vzkaz mamce, Vzkaz Káti, Záloha na Drive, Ukončit rozhovor
- Tlačítka se zobrazují kontextově (deník/vzkazy jen v cast režimu)

### ✅ 4. Automatické emaily po ukončení hovoru
- `karel-email-report` rozšířen o typy: did_handover, did_message_mom, did_message_kata
- Automatický email po ukončení rozhovoru s částí

### ✅ 5. Podrežim Káťa
- Přidán 4. podrežim "Káťa mluví s Karlem" (kata)
- Vlastní system prompt (kataPrompt)
- Typ přidán do ChatContext

### ✅ 6. Aktualizace system promptu
- Kompletní přepis childcarePrompt – odstranění NotebookLM referencí
- Nový kataPrompt pro Káťu
- Zákaz vymýšlení citací
- Instrukce pro automatické emaily a Drive integraci

### ✅ 7. Automatické přepnutí do supervize
- Po ukončení hovoru s částí Karel automaticky přepne do režimu mamka

## Zbývá (budoucí iterace)

### 🔲 Perplexity integrace v DID režimu
- Inline volání Perplexity z karel-chat pro DID kontext
- Automatické vyhledávání metod/technik pro konkrétní části

### 🔲 Automatická 24h záloha
- Kontrola při vstupu do DID režimu, zda byla záloha provedena v posledních 24h
- Pokud ne, automatická záloha

### 🔲 Audio tandem tlačítko
- Nahrávání audio ze sezení mamky s dítětem
- Karel analyzuje a dává rady v reálném čase
