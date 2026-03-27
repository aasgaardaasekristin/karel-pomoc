

## Oprava krizového detektoru – plán

### Diagnóza problému

Identifikovány **DVA** problémy:

1. **Časový nesoulad (root cause)**: Migrace `crisis_alerts` proběhla v 12:50 UTC, ale Arthurova konverzace skončila v 12:02 UTC. Detektor nemohl reagovat, protože v době konverzace ještě neexistoval.

2. **Špatná tabulka pro krizové vlákno**: Krizový detektor na řádku 824 vytváří krizové vlákno v `did_conversations`, ale frontend čte vlákna z `did_threads`. Krizové vlákno by se tedy nikdy nezobrazilo v UI.

### Plán oprav (5 úkolů)

#### ÚKOL 1 – Opravit krizový detektor v `karel-chat/index.ts`
- Řádek 824: Změnit `sbCrisis.from("did_conversations").insert(...)` na `sbCrisis.from("did_threads").insert(...)`
- Přizpůsobit sloupce pro `did_threads` schéma: `part_name`, `sub_mode: "crisis"`, `messages` (JSONB pole), `thread_label`, `last_activity_at`
- Detektor samotný (řádky 631-704) je v pořádku — čte `messages` z request body, ne z databáze

#### ÚKOL 2 – Vytvořit `crisis-retroactive-scan` Edge Function
- Nová funkce `supabase/functions/crisis-retroactive-scan/index.ts`
- Načte všechna vlákna z `did_threads WHERE sub_mode = 'cast'`
- Pro každé vlákno vezme posledních 15 zpráv z JSONB `messages`
- Použije identický krizový detection prompt jako `karel-chat` (řádky 653-685)
- Při detekci krize: INSERT do `crisis_alerts`, `crisis_tasks`, vytvoření krizového vlákna v `did_threads`

#### ÚKOL 3 – Deploy a spuštění retroaktivního skenu
- Deploy obou funkcí (`karel-chat` opravený + `crisis-retroactive-scan` nový)
- Zavolat `crisis-retroactive-scan` přes HTTP POST
- Zobrazit výsledek

#### ÚKOL 4 – Ověření SQL dotazy
- `SELECT * FROM crisis_alerts;`
- `SELECT * FROM crisis_tasks;`
- Ověřit neprázdné výsledky

#### ÚKOL 5 – Přegenerovat Karlův přehled
- Zavolat `karel-daily-dashboard`
- Zobrazit celý text – musí obsahovat krizový blok o Arthurovi

### Technické detaily

**did_threads schéma** (pro krizové vlákno):
```text
part_name: "ARTHUR"          (text, NOT NULL)
sub_mode: "crisis"           (text)
messages: [{role, content, timestamp}]  (jsonb)
thread_label: "🔴 KRIZOVÁ INTERVENCE – ARTHUR – 27.3.2026"
last_activity_at: now()
is_processed: false
```

**Retroaktivní sken** – zpracuje `messages` JSONB pole přímo z `did_threads`, ne z request body. Formát zpráv v JSONB: `[{role: "user"|"assistant", content: "..."}]`

