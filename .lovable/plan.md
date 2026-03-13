

## Plán: Rozklikávací dlouhodobé úkoly + Drive write-back fronta + strategické vylepšení Karla

### 1. Rozklikávací Dlouhodobé úkoly

**Problém**: Sekce "Dlouhodobé" zobrazuje úkoly jako jednořádkový `truncate` text bez možnosti rozkliknutí. Chybí detail, poznámky a odkaz na Drive.

**Řešení**: Přeměnit pasivní řádky na expandovatelné karty (jako DNES/ZÍTRA). Po kliknutí se rozbalí:
- Plný text úkolu (bez truncate)
- Pole `note` — podrobné zadání co má kdo udělat
- Pole `source_agreement` — odkaz na Drive dokument kde najdou další info
- Možnost přidat poznámku (jako u TaskCard)
- Zachovat tlačítka promote ↑ a koš 🗑

**Soubor**: `DidTherapistTaskBoard.tsx` — nahradit statické `<div>` v sekci Dlouhodobé plnohodnotnou `TaskCard` komponentou (nebo její upravenou verzí).

---

### 2. Drive Write-Back fronta (pending writes cache)

**Problém**: Když Karel vytvoří úkol v DB ale ještě to nezapsal na Drive, informace se "ztratí" do příští automatizace.

**Řešení**: Nová DB tabulka `did_pending_drive_writes` — jednoduchá fronta zápisů:

```sql
CREATE TABLE did_pending_drive_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,           -- co zapsat
  target_document TEXT NOT NULL,   -- kam (05_Operativni_Plan, karta části, atd.)
  write_type TEXT DEFAULT 'append', -- append | update_section
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',   -- pending | processing | done | failed
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  user_id UUID REFERENCES auth.users(id) DEFAULT auth.uid()
);
```

- Při vytvoření úkolu v nástěnce → automaticky vložit řádek do fronty
- Při dalším cyklu (denní/týdenní/manuální aktualizace) Karel nejprve zpracuje frontu a zapíše vše do příslušných dokumentů na Drive
- Edge funkce `karel-did-daily-cycle` a `karel-did-weekly-cycle` dostanou krok "flush pending writes"
- UI indikátor ve frontě: malý badge "3 čekají na zápis" u tlačítka Obnovit

**Soubory**: 
- Migrace: nová tabulka + RLS
- `DidTherapistTaskBoard.tsx`: při přidání úkolu → insert do fronty
- `DidDashboard.tsx`: badge s počtem pending writes
- Edge funkce cyklů: flush krok

---

### 3. Strategické návrhy pro zvýšení efektivity Karla jako supervizora

Zde jsou konkrétní návrhy implementovatelných funkcí:

#### A) **Týdenní „Pulse Check" — rychlý dotazník pro terapeutky**
- 1× týdně Karel pošle krátký 3-otázkový formulář (škála 1–5): "Jak se cítíš v týmu?", "Máš jasno v prioritách?", "Potřebuješ od Karla něco jiného?"
- Odpovědi se ukládají, Karel sleduje trendy a adaptuje styl vedení
- *Implementace*: nová edge funkce + jednoduchý formulář v UI

#### B) **Adaptivní motivační profily**
- Karel si pro každou terapeutku vede "motivační profil" (co funguje: pochvala / deadline / konkrétní instrukce)
- Po každém splnění/nesplnění úkolu se profil aktualizuje
- Při generování přehledu a denních e-mailů Karel volí tón podle profilu
- *Implementace*: nový sloupec v DB nebo dedikovaný dokument na Drive

#### C) **"Bod zlomu" — automatický alert při stagnaci**
- Pokud 3+ úkoly visí nesplněné > 5 dní NEBO terapeutka nereaguje > 3 dny → Karel automaticky eskaluje: speciální blok v denním e-mailu s přímou výzvou
- Eskalace má 3 úrovně: jemné připomenutí → přímý dotaz → návrh mimořádné porady
- *Implementace*: logika v `karel-did-daily-cycle`, nový sloupec `escalation_level` v tasks

#### D) **Vzájemná viditelnost — "Co dělá kolegyně"**
- V dashboardu sekce kde Hanka vidí stav Kátiiných úkolů a naopak
- Buduje pocit týmu a přirozený peer pressure
- *Implementace*: filtr v UI task boardu per terapeutka

#### E) **Měsíční "Retrospektiva" — automatická zpětná vazba**
- 1× měsíčně Karel generuje krátký report: kolik úkolů splněno/nesplněno, průměrná doba splnění, nejúspěšnější oblasti, doporučení
- Posílá se jako příloha k měsíčnímu e-mailu
- *Implementace*: nová edge funkce `karel-did-monthly-retrospective`

#### F) **"Karel's Insight" — proaktivní postřehy v chatu**
- Při zahájení chatu Karel nejen připomíná nesplněné úkoly, ale nabízí konkrétní postřeh: "Všiml jsem si, že úkoly kolem Arthura se plní rychleji než kolem Tundrupka — chceš o tom mluvit?"
- *Implementace*: rozšíření system promptu v `karel-chat` o analýzu vzorců z task DB

---

### Implementační pořadí (v tomto message)

1. **Rozklikávací Dlouhodobé** — úprava UI v `DidTherapistTaskBoard.tsx`
2. **Drive write-back fronta** — migrace + úprava task boardu + badge
3. **Eskalační logika (bod C)** — přidání `escalation_level` do tasks + logika v daily cycle

Návrhy A, B, D, E, F jsou strategické a mohou být implementovány postupně v dalších iteracích.

