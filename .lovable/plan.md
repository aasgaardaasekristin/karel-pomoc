
# Vylepšení DID režimu – Komplexní plán

## Stav: ✅ IMPLEMENTOVÁNO (fáze 1-6)

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

### ✅ 8. Thread-per-part architektura (Fáze 1)
- DB tabulky `did_threads` + `did_update_cycles` s RLS
- Hook `useDidThreads` pro CRUD na vláknech
- `DidDashboard` – přehled aktivity částí (aktivní/spí/varování)
- `DidThreadList` – seznam aktivních vláken s 24h pamětí
- `DidPartIdentifier` – "Kdo teď mluví?" s výběrem/zadáním jména
- Nový DID flow: Dashboard → Submode → Thread List → Part ID → Chat
- Auto-save vláken do DB každých 5s

### ✅ 9. Denní cyklus (14:00 CET)
- `karel-did-daily-cycle` edge function
- pg_cron schedule: `0 13 * * *` UTC (14:00 CET)
- 5 kroků: sběr → AI analýza → Drive update (sekce E/G/J/K/L) → email → uvolnění paměti
- Manuální spuštění tlačítkem "Aktualizovat nyní"

### ✅ 10. Týdenní cyklus (Fáze 2)
- `karel-did-weekly-cycle` edge function
- pg_cron schedule: `0 9 * * 0` UTC (neděle 10:00 CET)
- Čte VŠECHNY karty z Drive, analyzuje aktivitu za celý týden
- Aktualizuje dlouhodobé sekce H (vzorce), I (inter-part vztahy), M (dlouhodobé cíle)
- Aktualizuje mapu systému při změnách
- Detekce neaktivních částí (7+ dní)
- Týdenní report na email (mamka + Káťa)
- Manuální spuštění tlačítkem "Týdenní analýza"

### ✅ 11. Automatická 24h záloha (Fáze 3)
- Při vstupu do DID režimu Dashboard kontroluje poslední denní cyklus z DB
- Pokud > 24h od posledního, automaticky spouští `karel-did-daily-cycle`
- Toast notifikace o průběhu a dokončení
- Indikátor `isAutoBackupRunning` v Dashboardu

### ✅ 12. Perplexity integrace v DID režimu (Fáze 3)
- Tlačítko "Hledat metody" dostupné ve VŠECH DID podrežimech (včetně cast)
- `karel-did-research` přijímá `partName` pro kontextově specifické vyhledávání
- Perplexity sonar-pro hledá DID terapeutické metody, techniky, výzkumy
- Gemini syntetizuje výsledky do praktického formátu s funkčními odkazy
- Přísný zákaz halucinování citací

### ✅ 13. Audio tandem režim (Fáze 4)
- `karel-audio-analysis` rozšířen o DID-specifický tandem kontext
- Při nahrávání v DID režimu se automaticky přenáší: jméno části, podrežim, kontext z kartotéky
- Analýza zaměřená na: komunikaci s částí, validaci, přepínání, dysregulaci
- Konkrétní rady pro mamku: co říct, co neříkat, stabilizační aktivity
- Zpráva v chatu zobrazuje jméno části u audio analýzy

### ✅ 16. PDF Export DID Reportu (Fáze 6)
- `src/lib/didPdfExport.ts` – generování kompletního PDF reportu
- Sekce: přehled částí, historie synchronizačních cyklů, AI analýza vzorců, nedávné rozhovory
- Tabulky s autoTable plugin (jsPDF + jspdf-autotable)
- Tlačítko "PDF Report" integrováno do DID Dashboardu
- Automatické stránkování a záhlaví/zápatí

## Zbývá (budoucí iterace)

### ✅ 14. Vizualizace systému (Fáze 5)
- `DidSystemMap.tsx` – interaktivní mapa částí s barvami podle aktivity
- Barevné kódování: zelená (aktivní), šedá (spí), žlutá (varování 7+ dní)
- Hover tooltip s detailním časem poslední aktivity
- Chronologie aktivity seřazená podle posledního kontaktu
- Collapsible panel integrovaný do Dashboardu

### ✅ 15. Automatická detekce vzorců (Fáze 5)
- `karel-did-patterns` edge function – analyzuje 30 dní dat z vláken a cyklů
- AI detekce opakujících se témat, emočních a behaviorálních vzorců
- Systém upozornění s třemi úrovněmi (info/watch/concern)
- Detekce pozitivních trendů
- `DidPatternPanel.tsx` – UI pro zobrazení vzorců, alertů a trendů
- On-demand spuštění tlačítkem z Dashboardu
