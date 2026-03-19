

## Oprava duplikace textu + systém zpětné vazby pro úkoly

### Bug: Duplikace textu v rozbaleném úkolu

**Problém:** Řádek 224 zobrazuje `task.task` jako titulek. Řádek 251 v expanded view znovu zobrazuje `task.task` + `task.note`. Výsledek: text se opakuje.

**Oprava:** V expanded view (řádky 248-257) zobrazit POUZE `task.note` jako doplňující instrukci. Pokud `note` neexistuje a `task` je krátký, nezobrazovat nic navíc. Titulek nahoře stačí.

### Nový systém zpětné vazby Karel ↔ Terapeutky

**Koncept:** Každý úkol získá historii interakcí (feed) — terapeutka píše update o průběhu, Karel (AI) reaguje personalizovanou zpětnou vazbou. Toto probíhá přímo v rozbalení úkolu.

**Databáze:** Nová tabulka `did_task_feedback`:
```sql
create table public.did_task_feedback (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.did_therapist_tasks(id) on delete cascade not null,
  author text not null,          -- 'hanka', 'kata', 'karel'
  message text not null,
  created_at timestamptz default now()
);
alter table public.did_task_feedback enable row level security;
create policy "authenticated full access" on public.did_task_feedback
  for all to authenticated using (true) with check (true);
```

**Edge function `karel-task-feedback`:** Terapeutka napíše update → frontend volá edge function → Karel AI generuje personalizovanou odpověď na základě:
- Obsahu úkolu a poznámky
- Aktuálního stavu plnění (status badge)
- Motivačního profilu terapeutky (z `did_motivation_profiles`)
- Karel odpovídá profesionálně, konkrétně, motivačně — uznání pokroku, doporučení dalšího kroku, případně jemné urgence

Karel zároveň tiše aktualizuje profilační data (spolehlivost, reakční doba, rozpoložení) v `did_motivation_profiles` — žádná zmínka o tom v odpovědi.

**UI změny v `DidTherapistTaskBoard.tsx`:**
1. **Expanded view:** Odstranit duplikaci textu. Zobrazit pouze `note` jako instrukci pod titulkem.
2. **Feed historie:** Pod instrukcí zobrazit chronologický feed zpráv z `did_task_feedback` — bubliny s autorem (H/K/Karel) a časem.
3. **Input pole:** Stávající input přejmenovat na "Jak to jde? Napiš update..." — odeslání vytvoří záznam v `did_task_feedback` jako terapeutka a asynchronně spustí Karlovu odpověď.
4. **Karlova odpověď:** Zobrazí se v feedu jako bublina od Karla (jiná barva).

### Tok dat

```text
Terapeutka píše update → did_task_feedback (author=hanka)
                        → karel-task-feedback edge fn
                        → AI generuje odpověď + tiše updatuje profil
                        → did_task_feedback (author=karel)
                        → UI reload zobrazí obě zprávy
```

### Soubory k úpravě/vytvoření
1. **DB migrace** — tabulka `did_task_feedback`
2. **`supabase/functions/karel-task-feedback/index.ts`** — nová edge function pro AI odpověď
3. **`src/components/did/DidTherapistTaskBoard.tsx`** — oprava duplikace + feed UI + volání edge fn

