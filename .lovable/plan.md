

# Therapist Profiling Engine — PAMET_KAREL/DID/HANKA & KATA

## Problém

Současný `syncDidTherapistShadowMemory` kopíruje CENTRUM dokumenty (Dashboard, Plán) do PAMET_KAREL/DID/, což je zbytečná duplicita. CENTRUM dokumenty patří do KARTOTEKA_DID/00_CENTRUM a tam je Karel má číst.

PAMET_KAREL/DID/ má sloužit jako Karlova **vlastní profilace terapeutek** — živoucí deník osobností, dynamický monitoring, strategická analýza každé terapeutky.

## Nová struktura na Drive

```text
PAMET_KAREL/
  DID/
    HANKA/
      PROFIL_OSOBNOSTI.txt      ← dynamická profilace (psychika, mentalita, charakter)
      STRATEGIE_KOMUNIKACE.txt  ← co funguje, jak reaguje, jak docílit cíle
      SITUACNI_ANALYZA.txt      ← dlouhodobý/střednědobý/aktuální stav
      VLAKNA_3DNY.txt           ← surové konverzace z posledních 3 dnů + AI reflexe
      KARLOVY_POZNATKY.txt      ← Karel si zapisuje postřehy, vzpomínky, puzzle
    KATA/
      PROFIL_OSOBNOSTI.txt
      STRATEGIE_KOMUNIKACE.txt
      SITUACNI_ANALYZA.txt
      VLAKNA_3DNY.txt
      KARLOVY_POZNATKY.txt
```

## Co každý soubor obsahuje

**PROFIL_OSOBNOSTI** — Kdo je tato osoba:
- Psychologický profil, mentalita, charakter
- Silné stránky na nichž Karel staví
- Slabiny a zábrany které Karel obchází
- Vztahy k okolí (rodina, práce, osobní)
- Jak je otevřená, jak si nechá poradit
- Rozdíl Hanka vs Káťa: Hanka = intimní partnerský vztah (nikdy "Hano", vždy "Haničko/miláčku"), Káťa = mentor→mladší kolegyně

**STRATEGIE_KOMUNIKACE** — Jak s ní Karel jedná:
- Optimální komunikační vzorce
- Co zabírá při motivaci, při kritice, při úkolování
- Jak docílit maximální efektivity
- Myšlenkové vzorce a zábrany
- Adaptační algoritmus — co se Karel naučil

**SITUACNI_ANALYZA** — Temporální gradient:
- Dlouhodobý stav (měsíce) — komprimovaný
- Střednědobý (týdny) — shrnutý
- Aktuální (poslední dny) — detailní
- Co řeší doma, v životě, s čím se svěřuje

**VLAKNA_3DNY** — Surová komunikace + AI reflexe:
- Poslední 3 dny konverzací ze VŠECH režimů (Hana má: DID mamka/kata, Hana chat, Research, Práce; Káťa má: DID kata)
- AI syntéza: co z toho vyplývá, jaké vzorce, co Karel objevil

**KARLOVY_POZNATKY** — Deník duše:
- Karlovy postřehy, puzzle, vzpomínky
- Co nového se o ní dozvěděl
- Sdílené vzpomínky (Hanka-Karel)
- Dynamický, narůstající, s 90denní rotací starých záznamů

## Implementace

### 1. Přepis `syncDidTherapistShadowMemory` v `karel-did-context-prime/index.ts`
- Smazat kopírování CENTRUM dokumentů
- Nahradit AI-generovanou profilací per terapeutka
- Zdroje dat: vlákna ze VŠECH režimů za 3 dny, motivační profily, úkoly, epizody, existující profil z Drive
- AI (Gemini 2.5 Flash) čte stávající profil + nová data → generuje aktualizovaný profil
- 5 souborů per terapeutka místo současných 2 složek

### 2. Sběr dat per terapeutka
- **Hanka**: `did_threads` (sub_mode=mamka), `karel_hana_conversations` (všechny domény), `research_threads`, `did_conversations`
- **Káťa**: `did_threads` (sub_mode=kata)
- Obě: `did_therapist_tasks`, `did_motivation_profiles`, `karel_episodes`

### 3. AI syntéza (per terapeutka)
- Prompt: "Máš existující profil terapeutky + nová data z posledních 24h. Aktualizuj profil, zachovej cenné starší poznatky, přidej nové."
- Oddělené volání pro každý soubor (PROFIL, STRATEGIE, SITUACE, POZNATKY)
- VLAKNA_3DNY = deterministický dump + krátká AI reflexe

### 4. Čtení při kontextové cache
- Při každém `runPrime` (Osvěž paměť) Karel načte celou HANKA/KATA strukturu z Drive
- Injektuje do kontextové cache → Karel "zná své lidi"

### 5. Denní cyklus
- Na konci `karel-did-daily-cycle` volat profilační sync
- Zajistí automatickou aktualizaci i bez manuálního "Osvěž paměť"

## Technický rozsah
- **Soubor 1**: `supabase/functions/karel-did-context-prime/index.ts` — přepis shadow sync, nové čtení profilů
- **Soubor 2**: `supabase/functions/karel-did-daily-cycle/index.ts` — volání profilačního sync na konci cyklu
- Žádné DB změny

