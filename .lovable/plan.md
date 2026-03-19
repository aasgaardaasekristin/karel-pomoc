
# Vylepšení DID režimu – Komplexní plán

## Stav: ✅ IMPLEMENTOVÁNO (fáze 1-8 + Nová architektura fáze 1-2 + Opravy plánu)

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
- Aktualizuje 06_Strategicky_Vyhled (7 sekcí)
- Detekce neaktivních částí (7+ dní)
- Týdenní report na email (mamka + Káťa)

### ✅ 11. Automatická 24h záloha (Fáze 3)
- Při vstupu do DID režimu Dashboard kontroluje poslední denní cyklus z DB
- Pokud > 24h od posledního, automaticky spouští `karel-did-daily-cycle`
- Toast notifikace o průběhu a dokončení

### ✅ 12. Perplexity integrace v DID režimu (Fáze 3)
- Tlačítko "Hledat metody" dostupné ve VŠECH DID podrežimech
- `karel-did-research` přijímá `partName` pro kontextově specifické vyhledávání
- Perplexity sonar-pro hledá DID terapeutické metody

### ✅ 13. Audio tandem režim (Fáze 4)
- `karel-audio-analysis` rozšířen o DID-specifický tandem kontext

### ✅ 14. Vizualizace systému (Fáze 5)
- `DidSystemMap.tsx` – interaktivní mapa částí s barvami podle aktivity

### ✅ 15. Automatická detekce vzorců (Fáze 5)
- `karel-did-patterns` edge function – analyzuje 30 dní dat
- `DidPatternPanel.tsx` – UI pro zobrazení vzorců, alertů a trendů

### ✅ 16. PDF Export DID Reportu (Fáze 6)
- `src/lib/didPdfExport.ts` – generování kompletního PDF reportu

### ✅ 17. Nová architektura 00_CENTRUM (Fáze 7)
- **05_Operativni_Plan** (6 sekcí) nahrazuje starý 05_Terapeuticky_Plan
  - Sekce: Aktivní části, Plán sezení, Aktivní úkoly, Koordinace, Rizika, Karlovy poznámky
  - Denní cyklus jej kompletně přepisuje
- **06_Strategicky_Vyhled** (7 sekcí) nahrazuje složku 06_Terapeuticke_Dohody
  - Sekce: Vize systému, Střednědobé cíle, Dlouhodobé cíle, Strategie práce s částmi, Odložená témata, Archiv splněných cílů, Karlova strategická reflexe
  - Týdenní cyklus přepisuje, měsíční provádí hloubkovou revizi
- Koncept individuálních souborů dohod v podsložkách zrušen
- Zpětná kompatibilita se starými názvy dokumentů zachována

### ✅ 18. Accountability Engine + Personalizované vedení (Fáze 8)
- **Accountability Engine** v denním cyklu:
  - Načtení nesplněných úkolů z `did_therapist_tasks`
  - Povinný blok [ACCOUNTABILITY] s hodnocením 1-10
  - Automatická eskalace priority u úkolů starších 3 dní
  - Podmíněná "pozvánka na poradu" v emailech
- **Proaktivní dotazování** v chat promptech:
  - Runtime injection nesplněných úkolů do `karel-chat` při režimu mamka/kata
  - Karel se aktivně ptá: "Hani/Káťo, jak dopadlo [úkol]?"
- **Personalizované vedení terapeutů**:
  - Profil Hanky (denní péče, Písek, emoční zázemí)
  - Profil Káti (koordinace na dálku, Budějovice, škola Townshend, senzorická terapie)
  - Adaptační algoritmus – Karel se učí silné/slabé stránky
  - Karlovy vzpomínky z dětství pro budování důvěry
- **Mechanismus porad** – Karel svolává strukturované sezení při:
  - Úkol nesplněn 3+ dny
  - Terapeutky nekomunikovaly 5+ dní
  - Strategický nesoulad nebo stagnace cílů
- **Aktualizované edge funkce**: karel-chat, karel-did-daily-cycle, karel-did-weekly-cycle, karel-did-monthly-cycle, karel-did-drive-write, karel-did-session-prep

### ✅ 19. Karlův ranní brief (Fáze 9)
- `karel-did-morning-brief` edge function
- pg_cron schedule: `0 6 * * *` UTC (7:00 CET)
- Načte: nesplněné úkoly, motivační profily, aktivitu za 24h, operativní plán z Drive
- AI generuje personalizovaný brief pro Hanku i Káťu paralelně (Gemini Flash Lite)
- Formát: Priorita dne, 3 top úkoly, personalizovaný tip, motivace
- Email přes Resend oběma terapeutkám

### ✅ 20. Smart Activity Recommender (Fáze 9)
- Rozšíření `karel-chat` runtime injection
- Parsuje TALENT záznamy ze sekce H karet v didInitialContext
- Extrahuje talenty/zájmy z kontextu pomocí regex (formát TALENT|ÚROVEŇ|AKTIVITA)
- Injektuje personalizovaná doporučení do system promptu
- Karel proaktivně navrhuje rozvíjející aktivity na míru talentu každé části

### ✅ 21. Drive Auto-Cleanup (Fáze 9)
- Rozšíření `karel-did-monthly-cycle` o auditní krok
- Skenuje VŠECHNY podsložky kartotéky na Drive
- Detekuje: .txt/.md soubory (nekonvertované), duplicitní karty, prázdné dokumenty
- Výsledky zahrnuty v měsíčním emailovém reportu jako "📋 Návrh na úklid"
- Karel nic nesmaže — pouze navrhuje (bezpečnost)
- API response obsahuje `cleanupIssues` pole

## NOVÁ ARCHITEKTURA — DID jako živoucí kognitivní systém

### ✅ Nová Fáze 1: DID Context Prime + Online smyčka
- `karel-did-context-prime` edge function — plastická situační cache
- Paralelní harvest: Drive (00_CENTRUM, karty částí), DB (vlákna, epizody, sémantika, úkoly), Perplexity
- AI syntéza kontextu přes Gemini 2.5 Flash
- Injekce do `karel-chat` místo statického didInitialContext
- Auto-prime z frontendu při otevření vlákna (cast/mamka/kata)
- Detekce stavu systému: KLIDNÝ/AKTIVNÍ/ZVÝŠENÁ_AKTIVITA/VYSOKÁ_AKTIVITA

### ✅ Nová Fáze 2: DID epizodická paměť + cross-mode sběr
- `karel-did-episode-generate` edge function
- Automatické generování strukturovaných epizod z DID vláken (domain: "DID")
- DID-specifické tagy: part:Arthur, submode:cast, therapist:Hanka, topic:*, technique:*
- Cross-mode sken: prohledávání `karel_hana_conversations` pro DID zmínky
- AI klasifikace (YES/NO) zda Hana konverzace obsahuje klinicky relevantní DID info
- Integrace do denní konsolidace (`karel-daily-consolidation`)
- Frontend: automatický trigger při ukončení hovoru (handleDidEndCall) i odchodu z vlákna (handleLeaveThread)
- Fire-and-forget pattern — neblokuje UI

### ✅ Nová Fáze 3: Part Registry + Live DID Session
- **`did_part_registry` tabulka** — rychlý lookup stavu všech částí DID systému
  - Sloupce: part_name, status, cluster, role, age_estimate, language, last_seen_at, emotional state, triggers, strengths
  - RLS policies pro authenticated users
  - Auto-populace z `karel-did-episode-generate` (upsert po každém vytvořeném epizodě)
  - Sleduje total_episodes, total_threads, health_score
- **Live DID Session panel** (`DidLiveSessionPanel.tsx`)
  - Real-time coaching terapeutky při práci s konkrétní částí
  - Audio segmentové nahrávání + analýza (přes karel-audio-analysis)
  - DID-specifický kontext v system promptu (věk části, jazyk, triggers, switching detekce)
  - Výběr části před zahájením sezení
  - Automatický zápis po ukončení
  - Přístup přes Dashboard → "Live DID sezení"

### 🔄 Nová Fáze 4: DID Memory Bootstrap
- **`karel-did-memory-bootstrap` edge function** — jednorázové nasátí kartotéky z Drive
  - Fáze `scan`: Načte 01_AKTIVNI_FRAGMENTY, 02_SPICI, 03_ARCHIV z Drive
  - Fáze `process_one`: Parsuje sekce karty (A-M), extrahuje metadata
  - Upsert do `did_part_registry`: jméno, věk, status, cluster, role, jazyk, triggers, strengths
  - Generování epizod z obsahu karet (domain: "DID", tags: bootstrap)
  - Populace `karel_semantic_entities` pro DID části (typ: "did_cast")
  - Live progress indikátor v dashboardu (např. "5/23 Arthur")
  - Tlačítko "Bootstrap DID paměti" v DidDashboard
  - Batch zpracování pro prevenci timeoutů

### ⏳ Nová Fáze 5: Dashboard v2 z Registry
- `DidDashboard` napojit na `did_part_registry` místo Drive
- Rychlý přehled emočních stavů, zdraví karet, posledního kontaktu
- Filtry: aktivní/spící/archivované části
- Kliknutí na část → detail s historií epizod

### ⏳ Nová Fáze 6: Cross-therapist koordinace
- Automatické sdílení poznatků mezi Hankou a Káťou
- Karel detekuje relevantní info z jedné konverzace a injektuje do druhé
- Smart notifications: "Hanka dnes zjistila X o Arthurovi"
- Integrace do ranního briefu

### ⏳ Nová Fáze 7: Switching Detection
- AI detekce přepínání částí v reálném čase během Live Session
- Analýza jazykových vzorců, tónu, slovní zásoby
- Alert terapeutce + automatický zápis do registry
- Aktualizace `did_part_registry.last_seen_at` v reálném čase

### ⏳ Nová Fáze 8: DID Supervision Report
- Měsíční supervizní report z registry + epizod + vzorců
- PDF generování s grafem aktivity částí
- Email pro externího supervizora
- Anonymizovaná verze pro sdílení
