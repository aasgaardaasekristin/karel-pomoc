

# Implementace zbývajících bodů auditu: Evidence Validator, Semantic Similarity Gate, Forced CENTRUM Rewrite

## Co zbývá implementovat (body 1, 3, 5 z auditu)

### Bod 1: Evidence Validator pro [CENTRUM:] bloky
**Problém:** AI může napsat do Dashboardu/Plánu tvrzení, která nemají oporu v datech (halucinace na úrovni CENTRUM dokumentů).

**Řešení:** Přidat do AI promptu povinný formát `[SRC:thread_id|msg_idx]` ke každému klinickému tvrzení v [CENTRUM:] blocích. Po AI odpovědi programaticky validovat, že každý `[SRC:]` tag odkazuje na existující thread/konverzaci z vstupních dat. Tvrzení bez validního SRC se odfiltrují před zápisem.

**Implementace:**
- Rozšířit system prompt o povinnost přikládat `[SRC:cast|Arthur|msg3]` ke každému faktu v [CENTRUM:] blocích
- Přidat post-AI validační funkci `validateCentrumEvidence()` která:
  - Parsuje `[SRC:...]` tagy z CENTRUM bloků
  - Ověří, že odkazovaný zdroj (thread part_name + sub_mode) existuje v reportThreads/reportConversations
  - Odstraní věty/odstavce bez validního SRC tagu
  - Loguje rejekce do konzole
- Aplikovat validaci na Dashboard a Operativní plán i na fallback bloky

### Bod 3: Sémantický Similarity Gate přes AI
**Problém:** KHASH + substring dedup zachytí jen textově identické duplicity. Sémanticky stejné informace psané jinými slovy proklouznou.

**Řešení:** Před zápisem do sekce karty volat Lovable AI (gemini-2.5-flash-lite – nejrychlejší/nejlevnější) s dotazem: "Je nová informace X sémanticky stejná jako nějaký existující záznam v sekci Y?" → YES/NO odpověď. Při YES se zápis zablokuje.

**Implementace:**
- Nová funkce `semanticDedupCheck(newContent, existingContent)` → `boolean` (true = duplicita)
- Volá AI gateway s krátkým promptem: porovnej nosné myšlenky, vrať JSON `{isDuplicate: true/false, reason: "..."}`
- Tool calling pro strukturovaný výstup (ne parsování textu)
- Integrovat do `updateCardSections()` – po KHASH kontrole, před zápisem
- Timeout 5s, fallback na KHASH-only pokud AI neodpoví
- Logovat výsledky: `[SEMANTIC-DEDUP] Section E for "Arthur": DUPLICATE (reason: ...)`

### Bod 5: Tvrdé přepsání CENTRUM + post-write verifikace
**Problém:** CENTRUM dokumenty (Dashboard, Operativní plán) se aktualizují jen když AI vygeneruje příslušný blok. Fallback existuje, ale je minimalistický.

**Řešení:**
- Vylepšit fallback pro Dashboard: místo "AI blok chyběl" generovat plnohodnotný deterministický dashboard z DB dat (registry, threads, tasks, episodes)
- Vylepšit fallback pro Operativní plán: full rewrite z DB dat (nesplněné úkoly, aktivní části, plány sezení)
- Přidat post-write verifikaci: po zápisu přečíst dokument zpět a ověřit, že klíčové sekce existují

**Implementace:**
- Rozšířit `centrumDashboardUpdated === false` větev o plnohodnotný deterministický dashboard:
  - Sekce 1: Stav systému z `did_part_registry` (aktivní/spící/warning)
  - Sekce 2: Kritické výstrahy z `did_therapist_tasks` (3+ dny)
  - Sekce 3: Aktivita za 24h z DB počtů
  - Sekce 5: Priority z pendingTasks
- Rozšířit `centrumOperativniUpdated === false` větev o kompletní rewrite:
  - Aktivní části z registry
  - Plány sezení z threads
  - Nesplněné úkoly
  - Koordinační poznámky
- Přidat `verifyCentrumWrite()`: po zápisu přečte dokument zpět, zkontroluje délku a klíčová slova

## Technický souhrn

Vše se implementuje v jednom souboru: `supabase/functions/karel-did-daily-cycle/index.ts`

- ~3 nové funkce: `validateCentrumEvidence()`, `semanticDedupCheck()`, `verifyCentrumWrite()`
- Rozšíření system promptu o SRC tagging
- Vylepšení obou FALLBACK větví
- Žádné DB změny potřeba

## Priorita implementace
1. Evidence validator (zabrání halucinacím v CENTRUM)
2. Vylepšené CENTRUM fallbacky (garantuje vždy aktuální Dashboard/Plán)
3. Sémantický similarity gate (zabrání duplicitám jinými slovy)

