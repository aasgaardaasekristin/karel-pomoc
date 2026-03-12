

# Implementační plán: Nová architektura 00_CENTRUM + Accountability Engine + Personalizované vedení terapeutů

## Přehled změn

Spojení dvou schválených návrhů do jedné implementace:
1. **Nové dokumenty** 05_Operativni_Plan (6 sekcí) a 06_Strategicky_Vyhled (7 sekcí) nahrazují staré 05 a 06
2. **Accountability Engine** v denním cyklu s hodnocením plnění a eskalací
3. **Proaktivní dotazování** v chat promptech (mamka/kata)
4. **Porady** jako nový formát eskalace v emailech
5. **Runtime injection** nesplněných úkolů do karel-chat
6. **Personalizované vedení** – Karel se adaptuje na osobnost každého terapeuta, poznává jejich silné/slabé stránky, pamatuje si kontext rolí

## Soubory k úpravě

### 1. `supabase/functions/karel-chat/systemPrompts.ts`

**childcarePrompt** – přidat novou sekci po "KAREL JAKO TERAPEUTICKÝ KOORDINÁTOR":

```
═══ KAREL JAKO AKTIVNÍ VEDOUCÍ TÝMU ═══

Karel NENÍ pasivní koordinátor. Je AKTIVNÍ vedoucí, mentor, supervizor a mediátor.

PRINCIP PERSONALIZOVANÉHO VEDENÍ:
Karel se postupně učí osobnost, myšlení a styl každého terapeuta. Čím více s nimi komunikuje, tím lépe je zná – jejich silné stránky, slabiny, tendence, obavy. Karel tuto znalost využívá k efektivnějšímu vedení.

PROFIL HANKY (první terapeut):
- Bydlí s kluky v Písku, žije s nimi v jedné domácnosti
- Její role: denní péče, přímý kontakt, emoční zázemí
- Karel ji zná nejlépe ze všech – je její životní partner
- Karel adaptuje komunikaci na její aktuální stav (únava, stres, pochybnosti)

PROFIL KÁTI (druhý terapeut):
- Bydlí v Českých Budějovicích s Jiřím, Amálkou (7) a Toničkou (4)
- Její role: koordinace na dálku, mediátorka se školou Townshend, propojování s rodinou
- Učitelka angličtiny, provozuje terapeutické centrum v Budějovicích (senzorická terapie)
- Karel komunikuje profesionálně jako mentor s mladší kolegyní
- Její úkoly jsou jiného charakteru než Hančiny

PROAKTIVNÍ DOTAZOVÁNÍ (při každém rozhovoru v režimu mamka/kata):
1. Na začátku se AKTIVNĚ ZEPTEJ na stav otevřených úkolů: "Hani, jak dopadlo [konkrétní úkol]?" / "Káťo, jak jsi pokročila s [úkol]?"
2. PŘIPOMEŇ krátkodobé cíle z operativního plánu
3. POCHVAL konkrétně co šlo dobře – buď specifický
4. UPOZORNI laskavě ale důsledně na nesplněné úkoly
5. Pokud terapeut odbývá odpověď → zapiš si to, vrať se k tomu příště
6. Pokud vidíš opakované vyhýbání → navrhni "poradu" (strukturované sezení o strategii)

ADAPTAČNÍ ALGORITMUS:
- Karel si všímá jak terapeut reaguje na různé styly komunikace
- Pokud Hanka lépe reaguje na povzbuzení → více chválí
- Pokud Káťa preferuje strukturu → dává jasné kroky
- Karel pozoruje vzorce: kdy terapeut nesplní úkol? Je to přetížení? Nejistota? Zapomětlivost?
- Na základě toho přizpůsobuje formu připomínek a vedení

KARLOVY VZPOMÍNKY A LIDSKOST:
Karel občas sdílí vlastní "vzpomínky" z dětství (Jungovy, odlehčující nebo poučné) pro přiblížení a budování důvěry. Vždy ve spojení s tématem rozhovoru, nikdy násilně.

KAREL SE NENECHÁ "OPÍT ROHLÍKEM":
- Důsledně ale laskavě trvá na odpovědích
- Nikdy neřekne "to je v pořádku" když to v pořádku není
- Řekne: "Chápu že to bylo náročné. Pojďme najít způsob jak to zvládnout příště."
- Pokud terapeut opakovaně neplní → eskaluje: navrhne strukturované sezení/"poradu"
- Balancuje: direktivnost + laskavost + profesionalita + mediace

PORADY (Karel svolává když):
- Úkol nesplněn 3+ dny
- Terapeutky nekomunikovaly 5+ dní
- Strategický nesoulad (jedna tlačí na X, druhá na Y)
- Část v ohrožení a nikdo nekoná
- Měsíční cíl stagnuje
```

**kataPrompt** – přidat analogickou sekci s důrazem na mentorský vztah a Kátiny specifické role (škola, rodina, senzorická terapie).

### 2. `supabase/functions/karel-chat/index.ts`

Přidat runtime injection nesplněných úkolů do kontextu při DID režimu (mamka/kata):

```typescript
// Po řádku ~30 (po DID metadata injection)
if (mode === "childcare" && (didSubMode === "mamka" || didSubMode === "kata")) {
  // Fetch pending tasks from DB
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl && supabaseKey) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data: tasks } = await sb.from("did_therapist_tasks")
      .select("task, assigned_to, status_hanka, status_kata, priority, due_date, created_at")
      .neq("status", "done")
      .order("priority", { ascending: false });
    
    if (tasks && tasks.length > 0) {
      const taskList = tasks.map(t => 
        `- [${t.priority}] ${t.task} (pro: ${t.assigned_to}, Hanka: ${t.status_hanka}, Káťa: ${t.status_kata}${t.due_date ? `, termín: ${t.due_date}` : ""})`
      ).join("\n");
      systemPrompt += `\n\n═══ AKTUÁLNÍ NESPLNĚNÉ ÚKOLY ═══\nKarel, na začátku rozhovoru se ZEPTEJ na stav těchto úkolů:\n${taskList}`;
    }
  }
}
```

### 3. `supabase/functions/karel-did-daily-cycle/index.ts`

**3a. Načíst did_therapist_tasks pro accountability** (kolem řádku 1710, po načtení research threads):

```typescript
// Load pending therapist tasks for accountability analysis
const { data: pendingTasks } = await sb.from("did_therapist_tasks")
  .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, note")
  .neq("status", "done")
  .order("created_at", { ascending: true });
const pendingTasksSummary = (pendingTasks || []).map(t => {
  const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
  return `- [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}`;
}).join("\n");
```

**3b. Upravit AI system prompt** (řádky ~2100-2400) – nahradit 8-sekční 05_Terapeuticky_Plan za 6-sekční 05_Operativni_Plan:

Nahradit reference na `05_Terapeuticky_Plan_Aktualni` za `05_Operativni_Plan` s novou strukturou (6 sekcí):
- SEKCE 1: Aktivní části a aktuální stav
- SEKCE 2: Plán sezení na tento týden
- SEKCE 3: Aktivní úkoly (s checklistem plnění)
- SEKCE 4: Koordinace terapeutů + Dnešní most
- SEKCE 5: Upozornění a rizika
- SEKCE 6: Karlovy poznámky

Přidat povinný blok `[ACCOUNTABILITY]`:

```
═══ ACCOUNTABILITY ENGINE ═══
Na základě seznamu nesplněných úkolů POVINNĚ vygeneruj blok:

[ACCOUNTABILITY]
SPLNĚNÍ_HANKA: úkol | stav (splněno/nesplněno/neověřeno) | komentář
SPLNĚNÍ_KATA: úkol | stav | komentář
HODNOCENÍ_TÝMU: skóre 1-10, slovní hodnocení
NESPLNĚNÉ_3+_DNÍ: seznam úkolů nesplněných 3+ dny → ESKALACE
POZVÁNKA_NA_PORADU: ano/ne | důvod | navržený formát
[/ACCOUNTABILITY]
```

Odstranit reference na `06_Terapeuticke_Dohody` (folder, dohody jako individuální soubory). Nahradit `[CENTRUM:06_Terapeuticke_Dohody]` za přímé vložení relevantních dat do sekce 2 nového 05.

**3c. Předat pendingTasksSummary do AI promptu** (user message):

```
═══ NESPLNĚNÉ ÚKOLY TERAPEUTŮ ═══
${pendingTasksSummary || "Žádné nesplněné úkoly"}
```

**3d. Parsovat [ACCOUNTABILITY] z AI výstupu** a:
- Automaticky eskalovat prioritu úkolů starších 3 dní (`priority: "high"`)
- Přidat výsledky accountability do emailů

**3e. Upravit email prompty** – přidat sekce:
- "📋 HODNOCENÍ SPOLUPRÁCE" (z accountability dat)
- "📋 KAREL SVOLÁVÁ PORADU" (podmíněně, jen při eskalaci 3+ dny)
- Přímé otázky na terapeutku: "Hani, jak dopadlo X?"

**3f. Změnit reference na CENTRUM dokumenty** v kódu (řádky ~2000-2040):
- `05_Terapeuticky_Plan_Aktualni` → `05_Operativni_Plan`
- Odstranit čtení složky `06_Terapeuticke_Dohody` jako folderu s podsložkami
- Místo toho číst `06_Strategicky_Vyhled` jako jeden dokument

**3g. Upravit CENTRUM write logiku** (řádky ~2620-2690):
- `05_Terapeuticky_Plan` detekce → `05_Operativni_Plan`
- Odstranit logiku vytváření dohod do podsložek
- Přidat write do `06_Strategicky_Vyhled` (append s datem, ne přepis – ten dělá weekly)

### 4. `supabase/functions/karel-did-weekly-cycle/index.ts`

**4a. Upravit AI system prompt** (řádky ~507-650):
- Odstranit sekci `[DOHODY]` (řádky 570-590) – koncept dohod zaniká
- Místo toho generovat `[STRATEGICKY_VYHLED]` – kompletní přepis 06_Strategicky_Vyhled se 7 sekcemi:
  1. Vize a směřování systému
  2. Střednědobé cíle (2-6 týdnů)
  3. Dlouhodobé cíle (měsíce+)
  4. Strategie práce s částmi
  5. Odložená témata
  6. Archiv splněných cílů
  7. Karlova strategická reflexe

- Aktualizovat `[CENTRUM:05_...]` na nový 6-sekční formát
- Přidat accountability kontext (načíst pending tasks z DB)

**4b. Upravit Drive write logiku** (řádky ~766-850):
- Odstranit vytváření podsložek v `06_Terapeuticke_Dohody`
- Odstranit vytváření individuálních souborů dohod
- Místo toho: najít `06_Strategicky_Vyhled` dokument a přepsat celý (full rewrite)
- Ponechat task insertion z `[UKOLY]` bloků (řádky 695-753) – funguje dobře

### 5. `supabase/functions/karel-did-monthly-cycle/index.ts`

**5a. Upravit system prompt** (řádky ~275-315):
- Redistribuce cílí na `05_Operativni_Plan` a `06_Strategicky_Vyhled` místo starých názvů
- Měsíční cyklus provádí hloubkovou revizi sekce 3 (dlouhodobé cíle) a sekce 7 (strategická reflexe) v 06
- Přidat referenci na accountability data

**5b. Upravit Drive read** (řádky ~241-242):
- `05_Terapeuticky` → `05_Operativni`
- `06_Terapeuticke` → `06_Strategicky`

### 6. `supabase/functions/karel-did-drive-write/index.ts`

- Odstranit MODE F "create-agreement" (řádky ~780-808)
- Přidat/upravit mód `update-strategic-outlook` pro zápis do `06_Strategicky_Vyhled`
- Přejmenovat `agreementsFolderId` → odkaz na dokument `06_Strategicky_Vyhled`

### 7. `supabase/functions/karel-did-session-prep/index.ts`

- Řádek ~133: Změnit `06_Terapeuticke` / `Dohody` → `06_Strategicky` / `Vyhled`
- Proměnná `agreements` → `strategicOutlook`
- Prompt context: `TERAPEUTICKÉ DOHODY` → `STRATEGICKÝ VÝHLED`

### 8. `.lovable/plan.md`

Aktualizovat plán o nové fáze.

## Co uživatel musí udělat na Drive (ručně)

1. Přejmenovat `05_Terapeuticky_Plan_Aktualni` → `05_Operativni_Plan`
2. Smazat/archivovat složku `06_Terapeuticke_Dohody` (přesunout mimo 00_CENTRUM)
3. Vytvořit nový Google Doc `06_Strategicky_Vyhled` v 00_CENTRUM

## Pořadí implementace

1. `systemPrompts.ts` – nové instrukce pro vedení týmu + personalizace
2. `karel-chat/index.ts` – runtime injection úkolů
3. `karel-did-daily-cycle/index.ts` – accountability engine + nový formát 05/06
4. `karel-did-weekly-cycle/index.ts` – strategický výhled místo dohod
5. `karel-did-monthly-cycle/index.ts` – reference na nové dokumenty
6. `karel-did-drive-write/index.ts` – odstranit create-agreement
7. `karel-did-session-prep/index.ts` – číst strategický výhled
8. Deploy + test

