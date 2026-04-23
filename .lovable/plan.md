

# Oprava: Kam terapeut zapisuje, co část říká, a jak Karel potvrdí přijetí

## Co teď nefunguje (diagnóza)

V živém sezení existují **dvě různá vstupní pole** a uživatelka nedostává žádnou zpětnou vazbu, do kterého má psát:

1. **Hlavní chat dole** (`DidLiveSessionPanel`) — supervizní rada Karla pro terapeutku ("co říct", "na co pozor").
2. **Per-bod diagnostický chat** (`BlockDiagnosticChat`, ukrytý pod šipkou ▶ u každého bodu programu) — strukturovaný log toho, co Tundrupek říká/dělá pro daný bod. **Toto je správné místo** pro asociace, ale je schované.

**Aktuální chyba v `DidLiveSessionPanel.sendMessage` (řádek 358):**
```ts
if (!assistantContent) setMessages(messages); // ← smaže i uživatelskou zprávu
```
Pokud volání `karel-chat` selže (timeout, síť, rate-limit), kód **rolluje stav zpět na messages PŘED přidáním uživatelské zprávy** — text Hany tedy zmizí, jako by ho nikdy nenapsala. Žádné jasné upozornění, žádný retry. To přesně odpovídá tomu, co Hanka popisuje: „po kliknutí na odeslání se můj text vymazal a je to jako bych do něj vůbec nepsal".

**Druhý problém:** ani když to projde, hlavní chat `DidLiveSessionPanel` **neukládá** asociace do žádné struktury, kterou by Karel později četl jako „seznam reakcí Tundrupka". Karel jen reaguje supervizní radou a zapomíná. Nikde nevidíš „přijato → uloženo k bodu X".

---

## Co opravím

### 1. Hlavní chat: nikdy nesmazat text terapeutky (kritická oprava)

V `DidLiveSessionPanel.sendMessage`:
- Při chybě **ponechat** uživatelskou zprávu v chatu se značkou `⚠️ Karel neodpověděl — klikni „Zkusit znovu"`.
- Vrátit text do `input` boxu jako fallback, aby se neztratil ani při zavření okna.
- Přidat zřetelný toast `Karel teď neodpověděl — text máš uložený, zkus znovu`.
- Přidat tlačítko **„Zkusit znovu"** přímo u poslední uživatelské zprávy.

### 2. Hlavní chat: viditelné potvrzení „PŘIJATO"

Když terapeutka napíše do hlavního chatu (a Karel odpoví):
- Pod její zprávou se zobrazí malý štítek: **`✓ Karel přijal — uloženo do toku sezení (HH:MM)`**.
- Karel ve své odpovědi musí **doslovně odcitovat** první asociaci/větu Tundrupka („Slyším: *‚...'* — to je důležité, protože…"). Tím Hana vizuálně vidí, že obsah dorazil.

### 3. Nové tlačítko „📥 Zařadit jako asociaci k bodu" v hlavním chatu

Vedle textarey hlavního chatu přidám malé select-tlačítko: **`Připojit k bodu programu ▾`** (rozbalí seznam aktivních bodů z LiveProgramChecklist). Když Hana vybere bod a odešle, zpráva se:
- objeví v hlavním chatu jako normálně,
- **zároveň zaloguje** do `BlockDiagnosticChat::turns::{idx}` jako `from: "hana"` turn,
- Karel reaguje cíleně k tomu bodu (ne obecnou supervizí).

Tím odpadá nutnost rozbalovat skrytý per-bod chat — Hana zapisuje na jednom místě a Karel sám rozdělí.

### 4. Vizuální orientace: jasné popisky, kam se píše

Dnes uživatelka nevidí rozdíl mezi tím, kam píše. Přidám:
- Hlavní textarea: placeholder **„Sem zapisuj, co Tundrupek říká nebo dělá. Karel okamžitě poradí. (Enter odešle)"**
- Nad textareou minimální chip: **`💬 Hlavní tok sezení — Karel čte VŠE co napíšeš`**
- Tlačítko `📥 Zařadit k bodu ▾` (viz bod 3) hned vedle.

### 5. Opravím tichý dropdown side-effect

Současně `pushHintTrigger(userMessage, "note")` (řádek 297) spouští druhé paralelní volání `karel-live-session-feedback` v pravém sloupci. Když oba endpointy selžou současně, uživatelka vidí jen prázdno. Změním:
- Hint trigger se spustí **jen po úspěšné odpovědi** z `karel-chat` (přesun za stream).
- Při chybě hlavního chatu se hint trigger nespustí vůbec → žádný matoucí prázdný stav v pravém sloupci.

---

## Kam tedy MÁ Hana psát asociace (po opravě)

**Vždy do hlavního chatu dole** („Sem zapisuj, co Tundrupek říká..."). Nemusí už hledat skryté per-bod chaty.

Pokud chce přiřadit asociaci ke konkrétnímu bodu programu (např. bod #3 „slovní asociace"), použije nové tlačítko **`📥 Zařadit k bodu ▾`** vedle textarey → vybere bod → Karel zápis automaticky uloží i do diagnostického logu daného bodu, takže se objeví v denní analýze, v kartě části (sekce M – metody), i v Drive exportu.

---

## Technické detaily

**Soubory:**
- `src/components/did/DidLiveSessionPanel.tsx` — `sendMessage`: odstranit rollback, přidat retry stav, přidat dropdown „Připojit k bodu", přidat `acceptedAt` badge.
- `src/components/did/KarelInSessionCards.tsx` — zachovat (pravý sloupec funguje korektně).
- `src/components/did/LiveProgramChecklist.tsx` — vystavit list bodů přes prop pro dropdown v hlavním panelu (lift state nebo callback `getCurrentBlocks()`).
- `src/components/did/BlockDiagnosticChat.tsx` — beze změn; jen zapisujeme do jeho `localStorage` klíče `${storageKey}::turns::${idx}` zvenku.
- `supabase/functions/karel-chat/index.ts` (resp. supervision prompt) — doplnit povinnost: *„v první větě odpovědi doslovně odcituj klíčové slovo/asociaci, kterou ti terapeutka právě sdělila — tím potvrdíš příjem"*.

**Žádné DB migrace, žádné nové edge funkce.** Jen UI guard + prompt tweak.

---

## Akceptační kritéria

1. Když Karel selže, text Hany **zůstane viditelný** v chatu i v inputu, s tlačítkem „Zkusit znovu".
2. Pod každou odeslanou zprávou Hany svítí `✓ přijato HH:MM`.
3. Karel v první větě své odpovědi cituje to, co Hana napsala.
4. Tlačítko `📥 Zařadit k bodu ▾` zaloguje asociaci do per-bod logu (ověříme v `BlockDiagnosticChat` po znovuotevření bodu).
5. Žádné tiché mizení textu za žádných okolností.

