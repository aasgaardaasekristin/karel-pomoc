

# Oprava: Karel v reálném čase neasistuje při vedení sezení bod-po-bodu

## Diagnóza (proč to teď nefunguje)

1. **Karel nedostává kontext „který bod programu právě běží"**  
   `LiveProgramChecklist` posílá nahoru jen volný text („Pozorování k bodu…"). Edge funkce `karel-live-session-feedback` přijímá `program_block`, ale UI ho **nikdy neposílá** → Karel netuší, že má vyrobit 8 asociačních slov, navrhnout barvy, nadiktovat instrukci.

2. **Prompt v `karel-live-session-feedback` je defenzivní**  
   Říká Karlovi: „max 2 věty, žádné nadpisy, klidně řekni 'Bez zásahu – jen tiše drž prostor.'". Pro **content-producing** body (Karel musí vygenerovat slova / otázky / kresebnou instrukci) je to špatně.

3. **„Karle napiš mi ty slova" jde do hlavního chatu**, který v `buildContext` říká: odpovídej jako *supervizor* ve formátu 🎯👀⚠️🎮 — žádný režim „vygeneruj přesný obsah pro tento konkrétní bod programu".

4. **Chat není scrollovatelný**  
   Hlavička (titulek + Schválený plán s `max-h-80` + tools strip + image preview) zabere na 744 px viewportu skoro celou výšku. `ScrollArea` (`flex-1`) zkolabuje a panel `KarelInSessionCards` (`max-h-[14rem]`) ji vytlačí.

5. **Po dokončení bodu chybí „odeslat artefakt Karlovi k analýze"**  
   Audio/foto se analyzují obecně, neváží se na konkrétní bod programu.

---

## Oprava (5 cílených zásahů, jeden batch)

### 1. Spouštěč bodu — Karel produkuje obsah pro daný bod programu (NE meta-poznámku)

V `LiveProgramChecklist` přidat ke každému bodu **dvě tlačítka**:
- **🎯 „Spustit tento bod"** — pošle do panelu strukturovaný trigger `{ kind: "activate_block", block, detail, index }`
- **📎 „Odeslat artefakt"** — popup s volbou audio / foto / text, který připojí výstup k tomuto bodu

Nový edge endpoint **`karel-live-session-produce`** (oddělený od `feedback`):
- vstup: `{ part_name, therapist_name, program_block: { index, text, detail }, observation_so_far?, plan_context }`
- prompt je **content-producing**: „Hanka teď spouští bod #1: 'Asociační otevření – 8 slov o rodině'. Tvoje role: vygeneruj **přesně 8 slov** která má Haně tiše napovědět, aby je říkala Tundrupkovi. Žádná meta-rada, žádné komentáře — jen seznam slov + jedna věta jak je předávat."
- model `google/gemini-2.5-flash`, temperature 0.7, max 600 tokenů
- výstup: `{ karel_content: string, kind: "words_list" | "questions" | "instruction" | "free", items?: string[] }`
- detekuje typ bodu z textu (asociace → words_list, „kdyby barvu" → questions, „nakreslíme" → instruction) a podle toho zformátuje výstup

### 2. Aktivační karta v `KarelInSessionCards`

Rozšířit `KarelHintTrigger`:
```ts
{ kind: "activate_block" | "observation" | "attachment_analysis" | "free_input"; block?: {...} }
```
Když `kind === "activate_block"` → volat **`karel-live-session-produce`** místo `feedback`.  
Karta typu „aktivace" má jiný styl (zelená border, „🎯 Pro tento bod") a obsah je **přímo použitelný** (Hanka vidí 8 slov a říká je).

Přidat k aktivační kartě tlačítko **„Hotovo, dál"** které: zaškrtne checkbox bodu + scrolluje na další bod + automaticky nabídne „Spustit další bod".

### 3. Detekce přímé výzvy „napiš mi slova / otázky / nápady" v hlavním chatu

V `sendMessage` v `DidLiveSessionPanel`: před odesláním zkontrolovat regex  
`/(napiš|dej|navrhni|vygeneruj|řekni)\s+(mi\s+)?(ty\s+)?(slova|asociace|otázky|nápady|barvy|instrukci)/i`  
Pokud match a je aktivní bod programu (poslední `activate_block` trigger) → přesměrovat dotaz na **`karel-live-session-produce`** s aktuálním bodem; jinak normální `karel-chat`.

To opraví: „karle napiš mi ty slova" → Karel pošle 8 konkrétních slov, ne meta-radu.

### 4. Oprava scrollu chat okna

V `DidLiveSessionPanel`:
- Schválený plán panel: `max-h-80` → `max-h-48` + při `planExpanded === true` defaultně sbalit po prvním rozkliknutí bodu (auto-collapse on activate).
- `KarelInSessionCards` wrapper: změnit z hard `max-h-[14rem]` na **resizable + collapsible**: malé tlačítko „skrýt karty" + když je `cards.length > 2`, nechat scroll uvnitř karet místo expanze kontejneru. Default `max-h-[10rem]`.
- Wrapper `ScrollArea` messages: explicitně dát `min-h-[12rem]` aby nemohl zkolabovat na 0.
- Tools strip: zabalit do `details/summary` collapsible (default zavřené po prvním nahrání); ikony zůstanou viditelné.

### 5. Per-bod artefakty (audio / foto navázané na bod)

V `LiveProgramChecklist` u rozbaleného bodu: přidat tři malá tlačítka pod textareu:
- 🎙️ Nahrát audio k tomuto bodu
- 📷 Vyfotit
- 📤 Odeslat Karlovi k analýze (zvýrazněné, aktivuje se až je co poslat)

Po stisku „odeslat" → volá `karel-analyze-file` / `karel-audio-analysis` s `extraContext: 'Bod #N programu: <text>'` a výsledek se uloží do `item.observation` + pošle jako analytický trigger do pravého panelu (`kind: "attachment_analysis"`).

---

## Soubory ke změně

| Soubor | Co se mění |
|---|---|
| `src/components/did/LiveProgramChecklist.tsx` | + tlačítka „Spustit bod", „🎙️📷📤" per bod, prop `onActivateBlock`, `onSendArtefact` |
| `src/components/did/KarelInSessionCards.tsx` | rozšířený `KarelHintTrigger.kind`, větvení na `produce` vs `feedback`, aktivační karta + „Hotovo, dál" |
| `src/components/did/DidLiveSessionPanel.tsx` | scroll fix (min-h, max-h tweaks, collapsible tools), regex detekce požadavku na obsah, propagace `activeBlock` |
| `supabase/functions/karel-live-session-produce/index.ts` | **NOVÁ** edge funkce — content-producing prompt |
| `supabase/functions/karel-live-session-feedback/index.ts` | jen drobně: nepoužívat „Bez zásahu" jako default když existuje `program_block` |

## Co plán explicitně NEDĚLÁ
- Nemění strukturu programu ani jeho generování (krok A je hotový).
- Netýká se Jung Original Memory (krok B) ani Therapist-Led Pass governance (krok C).
- Neaktivuje nic v krizovém režimu — pouze DID/Live sezení.

## Pořadí implementace (single batch)
1. `karel-live-session-produce` edge fn + deploy
2. `LiveProgramChecklist` — spouštěč + per-bod artefakty + nové props
3. `KarelInSessionCards` — větvení produce/feedback + aktivační karta
4. `DidLiveSessionPanel` — scroll fix + regex přesměrování + state `activeBlock`
5. drobný tweak `karel-live-session-feedback` promptu
6. Smoke test: otevřít sezení → kliknout „Spustit bod 1" → ověřit 8 slov → napsat „napiš mi ty slova" → ověřit přesměrování → nahrát audio k bodu 2 → ověřit analýzu vázanou na bod

