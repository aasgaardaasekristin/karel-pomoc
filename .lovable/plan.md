

## Analýza a plán oprav

### 1. Semafor — stale closure bug

**Příčina**: `handleToggleTraffic(task, who)` čte `task` z renderového closure. Mezi dvěma kliknutími React může dodat stale objekt — `task.status_hanka` je stále `"not_started"` místo `"in_progress"`, takže `NEXT_STATUS["not_started"] = "in_progress"` místo očekávaného `"done"`.

**Oprava**: Přidat `tasksRef = useRef(tasks)` a v handleru místo `task` parametru číst aktuální stav z `tasksRef.current.find(t => t.id === taskId)`. Tím se zajistí, že se vždy čte poslední optimistický stav.

**Soubor**: `DidTherapistTaskBoard.tsx` — `handleToggleTraffic`

---

### 2. Sekce ZÍTRA zmizela

**Příčina**: V DB jsou 2 úkoly s `category: "tomorrow"`, ale oba mají `status: "done"` (splněné). Filtr `active = tasks.filter(t => !isAllDone(t))` je vyřadí → `tomorrowTasks` je prázdné → sekce se nevykreslí. To je korektní chování — není co zobrazit. Žádný bug, jen všechny úkoly na zítra byly označené jako splněné.

Nicméně sekce by měla být viditelná i prázdná (s textem "Žádné úkoly na zítra"), aby uživatel viděl, že kategorie existuje a mohl přidat nové.

**Oprava**: Zobrazit sekci ZÍTRA vždy (pokud existují jakékoliv úkoly, i splněné), nebo zobrazit prázdný stav.

---

### 3. Mapa systému — nesprávné počty

**Příčina**: Data JSOU přesná, ale zavádějící. V DB existuje pouze **1 vlákno** typu `cast` (Arthur, poslední aktivita 2. března = 11 dní zpět → status "warning" ⚠️). Žádné vlákno pro Tundrupka, Gustíka, Raketu atd. Proto: 0 aktivních, 0 spí, 1 ⚠️.

Problém je, že mapa čerpá POUZE z `did_threads WHERE sub_mode = 'cast'`. Ostatní části (Tundrupek, Gustík, Raketa) nemají vlastní vlákna, přestože Karel o nich píše v přehledu.

**Oprava**: Rozšířit zdroj dat pro mapu — kromě `did_threads` parsovat jména částí i z Karlova přehledu (`overviewText`). Dashboard předá do `DidSystemMap` jak DB vlákna, tak části zmíněné v přehledu (s fallback statusem "sleeping" pokud nemají vlákno). Tím se mapa naplní všemi známými částmi.

**Soubory**: `DidDashboard.tsx` (parsování částí z přehledu + merge s DB daty), `DidSystemMap.tsx` (beze změn, jen dostane víc dat)

---

### Souhrn změn

| Soubor | Změna |
|--------|-------|
| `DidTherapistTaskBoard.tsx` | `useRef` pro latest tasks; handler čte z ref místo closure |
| `DidTherapistTaskBoard.tsx` | Sekce ZÍTRA viditelná i bez aktivních úkolů |
| `DidDashboard.tsx` | Parsování jmen částí z Karlova přehledu + merge s DB daty pro mapu |

