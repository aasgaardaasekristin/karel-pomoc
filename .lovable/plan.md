

## Analýza nalezených chyb a plán oprav

### 1. Gramatika v pozdravu (`karel-did-system-overview`)

**Problém**: `Krásné ${dayName}ní ráno` vytváří nesprávné tvary: "pátekní" místo "páteční", "středaní" místo "středeční" atd. Český jazyk vyžaduje nepravidelné přídavné tvary pro každý den.

**Oprava**: Vytvořit mapu `dayName → adjective` (pondělní, úterní, středeční, čtvrteční, páteční, sobotní, nedělní) a použít ji ve variantách pozdravu. Také odstranit variantu s `${dayName}ní` a nahradit správným `${dayAdj}`.

---

### 2. Traffic light kolečka přeskakují na jiné úkoly

**Problém**: Po kliknutí na traffic light se zavolá `handleToggleTraffic`, která updatuje DB a pak volá `loadTasks()`. Funkce `loadTasks` znovu načte a přeřadí úkoly (`order by created_at desc`). Protože React re-renderuje celý seznam, a React key je `task.id`, samotné přiřazení je správné. **Skutečný problém** je race condition: `loadTasks()` je voláno **bez await** na řádku 243 (`loadTasks();` po `await supabase.update`). Pokud uživatel klikne rychle, předchozí `loadTasks` ještě nedoběhlo a nové `setTasks` se promíchají.

**Oprava**:
- Přidat optimistický update stavu: ihned po kliknutí na traffic light aktualizovat lokální `tasks` state, pak teprve volat DB update na pozadí.
- Přidat `await` na `loadTasks()` v `handleToggleTraffic`.
- Případně přidat debounce/lock aby se zabránilo rychlým vícenásobným kliknutím.

---

### 3. Úkoly na ZÍTRA se mažou místo toggle

**Problém**: Sekce ZÍTRA používá identický `TaskCard` jako DNES. Pokud se úkoly "mažou" po kliknutí, je to pravděpodobně důsledek toho samého race condition — rychlé kliknutí na traffic light → `loadTasks` přeřadí → úkol zmizí z kategorie "tomorrow" (protože `status` se změní nekonzistentně a úkol spadne do jiné kategorie nebo se `completed_at` nastaví). Oprava traffic light race condition vyřeší i toto.

---

### 4. Mapa systému: nesprávné počty (0 aktivních, 1 spí, 1 ⚠️)

**Problém**: Statistiky v `DidSystemMap` korektně počítají z pole `parts`. Problém je v `DidDashboard.loadDashboardData()` — status "active" se přiřazuje jen pokud `diff < oneDay` (24h). Pokud poslední aktivita části je starší než 24h ale mladší než 7 dní, status = "sleeping". To je záměrné, ale uživatel říká, že to nekoresponduje se skutečností.

**Oprava**: Ověřit logiku a případně rozšířit "active" na 48h nebo zobrazit přesnější popis ("aktivní dnes" vs "aktivní tento týden"). Ale hlavní issue je že text říká "0 aktivních" přestože části existují — to znamená, že žádná část neměla aktivitu za posledních 24h, což je možné. Ponechám logiku, ale zlepším zobrazení statistik aby bylo jasné co to znamená.

---

### 5. Mapa systému: koš nefunguje (vnořené `<button>`)

**Problém**: Celá karta části je `<button>`, uvnitř je další `<button>` pro koš. HTML standard zakazuje vnořené buttony → prohlížeč je nesprávně interpretuje → `e.stopPropagation()` nefunguje spolehlivě → `confirm()` se nespustí nebo se klik "spolkne". Console log potvrzuje: "Function components cannot be given refs" warning pro vnořené elementy.

**Oprava**: Změnit vnější element z `<button>` na `<div>` s `role="button"` a `tabIndex={0}` + `onClick`, aby se předešlo problému s vnořenými buttony. Vnitřní koš zůstane jako `<button>`.

---

### Souhrn změn (4 soubory)

| Soubor | Změna |
|--------|-------|
| `supabase/functions/karel-did-system-overview/index.ts` | Oprava gramatiky: mapa `dayName → adjective` pro české přídavné tvary dnů |
| `src/components/did/DidTherapistTaskBoard.tsx` | Optimistický update traffic light + await na loadTasks + lock proti rychlým kliknutím |
| `src/components/did/DidSystemMap.tsx` | Vnější `<button>` → `<div role="button">` pro opravu vnořených buttonů a fungujícího koše |
| `src/components/did/DidDashboard.tsx` | Drobná úprava statistik v mapě (optional, pokud potřeba) |

