Zjistil jsem příčinu: aktivita nejspíš nezmizela z databáze, ale Herna se přepnula na novější/prázdné vlákno a novější schválený plán.

V datech jsou teď dvě dnešní Herny pro Tundrupka:

```text
1) Nové prázdné vlákno
   thread: e031a91f-b3e3-488c-b905-48b9703b60b5
   plan:   7a1f48d5-f1a2-4cfe-90b0-7ca153cd2001
   zprávy: 1
   čas:    18:51

2) Původní aktivní vlákno s celou konverzací
   thread: c0f53d31-c62a-42c5-b932-de4def806f59
   plan:   6dab7338-8f9b-4168-af83-ff14e00e89c1
   zprávy: 55
   čas:    17:52
```

Takže stará aktivita pravděpodobně není smazaná. Jen se UI/loader po posledních zásazích chytil novějšího prázdného plánu/vlákna, takže to vypadá, jako by předchozí Herna nikdy neproběhla.

## Co opravím

### 1. Obnovím zobrazení původní aktivity
Nastavím Herna loader tak, aby při výběru dnešního plánu nedal slepě přednost nejnovějšímu schválenému plánu, pokud existuje starší aktivní vlákno se skutečnou konverzací.

Pravidlo bude:

```text
Pokud existuje dnešní karel_part_session pro stejnou část a má více než opener,
Herna má pokračovat v něm, ne otevírat prázdné nové vlákno.
```

### 2. Opravím výběr plánu v `DidKidsPlayroom.tsx`
V `loadApprovedPlan` přidám bezpečný resolver:
- nejdřív vezme `workspace_thread` z URL nebo `sessionStorage`, pokud existuje,
- pokud neexistuje, vyhledá dnešní aktivní vlákna `sub_mode = karel_part_session`,
- upřednostní vlákno se zprávami a poslední aktivitou,
- z jeho `workspace_id` vezme správný plán,
- teprve když žádné aktivní vlákno není, vybere nejnovější schválený plán.

Tím se původní 55zprávová aktivita znovu objeví.

### 3. Opravím `karel-part-session-prepare`
Funkce teď hledá existující vlákno jen podle přesného `plan_id`. Když vznikl nový schválený plán, vytvořila novou prázdnou Hernu, i když dnešní Herna Tundrupka už běžela.

Změním idempotenci takto:

```text
A) pokud plan_id už má vlákno, vrať ho
B) jinak pro stejnou část a dnešní den najdi poslední neukončené / aktivní vlákno s messages > 1
C) pokud existuje, vrať původní vlákno a nepřepisuj jeho messages
D) nové vlákno vytvoř jen tehdy, když žádná reálná dnešní aktivita neexistuje
```

### 4. Nechám historii nedotčenou
Nebudu mazat ani přepisovat původní zprávy. Cílem je pouze znovu napojit UI na správný záznam.

### 5. Doplním ochranu proti „zmizení“ po dalších opravách
Do loaderu přidám fallback: pokud vybraný thread má jen opener, ale existuje starší dnešní thread se stejnou částí a více zprávami, UI zobrazí starší aktivní thread.

## Technické změny

- `src/components/did/DidKidsPlayroom.tsx`
  - rozšířit načítání o `workspace_id`, `workspace_type`, `started_at`, `last_activity_at`, `messages`,
  - při výběru plánu zohlednit existující aktivní vlákno,
  - při načtení threadu uložit jeho `workspace_id` zpět do `sessionStorage`, aby se Herna dál držela stejného plánu.

- `supabase/functions/karel-part-session-prepare/index.ts`
  - změnit lookup existující Herny: kromě přesného `workspace_id=plan_id` hledat také dnešní aktivní vlákno pro stejnou část,
  - preferovat thread s reálnou aktivitou (`jsonb_array_length(messages) > 1`),
  - nevytvářet duplicitní prázdnou Hernu, pokud už dnešní Herna proběhla.

## Očekávaný výsledek

Po opravě se Herna znovu otevře na původní konverzaci Tundrupka s 55 zprávami. Nové prázdné vlákno nebude uživateli vytlačovat rozpracovanou aktivitu. Karel bude moct pokračovat v programu, ale z historicky správného místa, ne z čistého začátku.