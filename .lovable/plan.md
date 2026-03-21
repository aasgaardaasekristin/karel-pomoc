

# Auto-generování úkolů po ukončení sezení

## Proč právě tento krok

Session finalizace v `DidLiveSessionPanel` už **parsuje sekci `## ÚKOLY`** z AI reportu (řádky 386-388) a ukládá je jako JSON do `did_part_sessions.tasks_assigned`. Ale **nikdy je nepropíše do `did_therapist_tasks`** — úkoly existují v zápisu, ale neobjeví se na nástěnce. Terapeutky je musí ručně přepisovat. Tohle je jasný gap, který uzavře smyčku: sezení → analýza → handoff → úkoly na nástěnce.

## Plán

### 1. Rozšířit parsování úkolů v handleEndSession

Aktuální kód parsuje jen textové řádky. Upravit prompt v sekci `## ÚKOLY` tak, aby Karel vracal strukturovaný formát:
```
- [hanka|kata|both] [today|tomorrow|longterm] Konkrétní úkol
```

Parsovat tyto řádky na objekty `{ task, assignee, category }`.

### 2. Automatický insert do did_therapist_tasks

Po uložení session (řádky 390-409) přidat blok, který:
- Pro každý parsovaný úkol provede dedup check (stejně jako v `TaskSuggestButtons.tsx` — ilike na prvních 30 znaků)
- Pokud úkol neexistuje, insertne do `did_therapist_tasks` s:
  - `task`, `assigned_to`, `category`
  - `source_agreement: "Sezení s [partName]"`
  - `priority` odvozená z category (today=high, tomorrow=normal, longterm=low)
  - `detail_instruction` s kontextem ze sezení

### 3. Toast s počtem vytvořených úkolů

Po insertu zobrazit toast: "Vytvořeno X úkolů na nástěnce".

## Soubor k úpravě

- `src/components/did/DidLiveSessionPanel.tsx` — jediný soubor

## Bez nových závislostí, bez DB migrace

Využívá existující tabulku `did_therapist_tasks` a existující parsovací logiku. Prompt se mírně upraví pro strukturovanější výstup.

