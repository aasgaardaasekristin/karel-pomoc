

# Plán: Karlova temporální orientace, role guard, task cleanup a inline odpovědi

## Problém

1. **7 218 pending úkolů** — 13 edge funkcí vkládá úkoly bez efektivní deduplikace
2. **Temporální dezorientace** — úkoly z 5. dubna (Jeseníky, iCloud) se zobrazují jako aktuální
3. **Role confusion** — Karel úkoluje terapeutky svou vlastní prací (sestavit scénář, projít kartu, připravit věty)
4. **Žádný staleness filtr v UI** — `KarelDailyPlan` načítá všechny pending úkoly bez omezení stáří
5. **Chybí inline odpovědní mechanismus** — terapeutky nemohou odpovědět přímo u otázky v přehledu

## Řešení

### A. DB cleanup migrace
```sql
-- 1. Expirovat všechny pending úkoly starší 72h
UPDATE did_therapist_tasks 
SET status = 'expired' 
WHERE status IN ('pending','active','in_progress') 
  AND created_at < now() - interval '72 hours';

-- 2. Smazat hotové úkoly starší 14 dní (už existuje v cyklu, ale jednorázově vyčistit)
DELETE FROM did_therapist_tasks 
WHERE status = 'done' AND created_at < now() - interval '14 days';
```

### B. UI staleness filtr (`KarelDailyPlan.tsx`)
- Přidat `.gte("created_at", threeDaysAgo)` do query na `did_therapist_tasks` (řádek 97-102)
- Snížit limit z 12 na 5
- Přidat deduplikaci podle textu úkolu (první 40 znaků)

### C. Karlův přehled — informační deficit mód
Když Karel nemá čerstvá data (žádné interviews za 72h, žádné čerstvé vlákna), místo generické věty zobrazí:

1. **Co ví naposledy** — shrnutí z posledních známých dat (i starších) s explicitním časovým údajem: „Naposledy jsem komunikoval s Arthurem před 12 dny. Tehdy..."
2. **Lehký tlak/motivace** — „Uplynulo X dní bez aktualizace. Potřebuji vědět, jak se situace vyvíjí."
3. **Konkrétní otázky s inline odpovědním polem** — pro každou otázku `<Textarea>` přímo v briefingu:
   - „Jak se Arthur chová od [datum]?"
   - „Proč jste nereagovali na mé dotazy?"
   - „Jaká je aktuální situace s dětmi?"
4. **Okamžité zpracování odpovědi** — po odeslání:
   - Uloží jako `did_threads` záznam (part_name: "Karel", sub_mode odpovídající terapeutce)
   - Toast: „Děkuji, zpracuji to při příštím cyklu"
   - Karel pozitivně reaguje na každou odpověď

### D. Role guard v edge funkcích
V `system-rules.ts` (PRAVIDLO 9) je role guard již definován, ale edge funkce ho nedodržují. Oprava:

1. **`karel-did-daily-cycle`** — do promptu pro generování úkolů přidat explicitní temporal context:
   ```
   Dnešní datum: ${today}. Události starší 5 dnů považuj za historické.
   ```
2. **`karel-analyst-loop`** + **`karel-daily-dashboard`** + **`karel-crisis-daily-assessment`** — před insert přidat anti-dup check:
   ```typescript
   const existing = await sb.from("did_therapist_tasks")
     .select("id").eq("task", taskText)
     .in("status", ["pending","active"]).limit(1);
   if (existing.data?.length) continue;
   ```
3. **Role guard injection** — do promptů všech 13 edge funkcí, které generují úkoly, vložit:
   ```
   PRAVIDLO: Karel NIKDY neúkoluje terapeutky přípravou materiálů, plánů, technik ani analytickou prací. 
   Karel tyto materiály PŘIPRAVUJE SÁM. Úkoly pro terapeutky: potvrdit účast, sdělit pozorování, 
   odpovědět na otázku, provést konkrétní intervenci při sezení.
   ```

### E. Inline odpovědní formuláře v briefingu
Nový komponent `InlineQuestionField` v `KarelDailyPlan.tsx`:
- Každá Karlova otázka bude mít vlastní `<Textarea>` + tlačítko odeslat
- Po odeslání: insert do `did_threads` s labelem otázky
- Karel jemně pozitivně potvrdí: „Děkuji, Haničko. Tuto informaci ihned zapracuji."
- Pokud terapeutka napíše „nevím jak zjistit..." → Karel nabídne pomoc (link na rozhovor s Karlem s předvyplněným kontextem)

## Soubory k úpravě
1. **DB migrace** — jednorázový cleanup 7218 starých tasků
2. `src/components/did/KarelDailyPlan.tsx` — 72h filtr, dedup, informační deficit mód, inline odpovědi
3. `supabase/functions/_shared/system-rules.ts` — doplnit temporal awareness pravidlo
4. `supabase/functions/karel-analyst-loop/index.ts` — anti-dup check před insert
5. `supabase/functions/karel-daily-dashboard/index.ts` — anti-dup check
6. `supabase/functions/karel-crisis-daily-assessment/index.ts` — anti-dup check
7. `supabase/functions/karel-did-daily-cycle/index.ts` — temporal context do promptu

## Pořadí
1. DB cleanup migrace (okamžitý efekt)
2. UI staleness filtr + dedup v KarelDailyPlan
3. Informační deficit mód + inline odpovědi
4. Anti-dup guard ve 3 hlavních edge funkcích
5. Role guard + temporal context v system-rules a denním cyklu

## Akceptace
- Dashboard zobrazuje max 5 úkolů, všechny z posledních 72h
- Žádné duplicity v textu úkolů
- Když Karel nemá čerstvá data, říká co ví naposledy a ptá se s inline formulářem
- Odpovědi terapeutek se okamžitě ukládají do DB
- Žádné úkoly kde Karel deleguje svou analytickou/přípravnou práci na terapeutky

