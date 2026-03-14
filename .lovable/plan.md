

# Redesign PRACOVNÍ: Karel jako live partner na sezení

## Co je realizovatelné a co ne

**Realtime odposlech a analýza hlasu v reálném čase -- NE plně v reálném čase.**
Webový prohlížeč neumí posílat audio stream přímo do AI modelu s kontinuální odezvou. Co JE možné:
- **Segmentová analýza**: Hanka nahrává, každých ~30-60s se segment odešle na backend, Karel odpoví do chatu za ~5-10s. Není to "v reálném čase", ale je to blízko -- Karel reaguje s mírným zpožděním jako tichý pozorovatel.
- **Hlasová analýza (tenze, emoce)**: Gemini multimodální model umí analyzovat tón hlasu, takže detekce tenze klienta i terapeutky z audio segmentů je možná.
- **Alternativa pro rychlejší odezvu**: ElevenLabs Realtime Scribe (už máte connector) -- transkripce v reálném čase do textu, Karel analyzuje text průběžně. Toto je nejrychlejší varianta.

## Plán implementace (5 fází)

### Fáze 1: Odstranění a přesuny
- Odstranit `<HanaSessionReport>` z akční lišty v HanaChat (OSOBNÍ)
- Přesunout audio nahrávku do PRACOVNÍ modu

### Fáze 2: Nový flow „Sezení s klientem" v PRACOVNÍ
- Přepracovat úvodní obrazovku: kolonka pro jméno klienta (autocomplete z kartotéky + možnost vytvořit nového)
- Při výběru existujícího klienta: Karel načte všechna sezení a údaje z karty, vygeneruje:
  - **Shrnutí případu** (1 odstavec: základní údaje + extrakce ze všech sezení)
  - **Summary posledního sezení** (2. odstavec)
  - **Formulář** (menším písmem, stav vyplnění)
- Tlačítko **"Zahájit sezení za přítomnosti Karla"**

### Fáze 3: Live sezení s Karlem
- Split layout: formulář vlevo, chat vpravo
- Karel má plný kontext klienta (summary + historie sezení)
- Audio nahrávání nad chatem (Start/Pause/Resume, 5min segmenty)
- **Segmentová analýza**: každý audio segment se posílá na `karel-audio-analysis`, Karel píše rady do chatu
- Karel radí: na co se ptát, čeho si všímat, koriguje nevhodné reakce
- Tlačítko **"Ukončit a zpracovat"**: Karel vezme chat + všechny audio segmenty → profesionální zápis ze sezení (metody, pozorování, návrh na příští sezení, otázky, pomůcky)

### Fáze 4: Post-session nástroje (3 tlačítka na kartě klienta)
1. **"Poradit se na internetu"**: Karel analyzuje celou kartu, identifikuje vyzkoušené metody, přes Perplexity hledá nové přístupy, které se ještě nezkoušely
2. **"Probrat situaci se mnou"**: Chat kde Karel poskytne supervizní pohled -- upozorní na chyby, klíčové body, doporučí postoj, koriguje odborný názor
3. **"Supervizní trénink"**: Karel simuluje klienta podle dat z karty, Hanka trénuje reakce, Karel hodnotí (správnost, silné/slabé stránky, bodování, motivace)

### Fáze 5: Backend edge funkce
- `karel-client-summary` -- generuje shrnutí z karty + všech sezení
- `karel-live-session` -- live chat s kontextem klienta, rady v reálném čase
- `karel-session-finalize` -- zpracování sezení do profesionálního zápisu
- `karel-client-research` -- Perplexity rešerše nových metod
- `karel-supervision-discuss` -- supervizní diskuze o klientovi
- `karel-supervision-training` -- simulace klienta pro trénink

### Soubory k úpravě/vytvoření
- `src/components/hana/HanaChat.tsx` -- odstranit HanaSessionReport
- `src/components/report/SessionSidebar.tsx` -- nový flow výběru klienta
- `src/components/report/LiveSessionPanel.tsx` -- NOVÝ: live sezení s Karlem
- `src/components/report/ClientSummaryCard.tsx` -- NOVÝ: shrnutí klienta
- `src/components/report/PostSessionTools.tsx` -- NOVÝ: 3 post-session tlačítka
- `src/components/report/SupervisionTraining.tsx` -- NOVÝ: simulace trénink
- `src/pages/Chat.tsx` -- integrace nových komponent do PRACOVNÍ
- 4-6 nových edge funkcí

---

**Rozsah**: Toto je velká architektonická změna (~2000+ řádků nového kódu, 6 edge funkcí). Doporučuji implementovat po fázích -- začít fází 1+2 (přesuny + nový flow), pak fáze 3 (live sezení), pak fáze 4 (post-session nástroje).

Mám začít fází 1 a 2?

