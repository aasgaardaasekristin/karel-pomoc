

# Karel jako skutečný klinik: pevný protokol pro každý bod programu

## Co se reálně stalo (poctivě)

Z minula **bylo postaveno jen lešení**, ne klinický mozek:

1. `karel-block-research` byl vytvořen, ale:
   - není povinný — `BlockDiagnosticChat` volá rešerši **až na klik** „Spustit rešerši", jinak Karel běží naslepo
   - výstup zůstane jen vizuálně v briefu, **nepropisuje se do promptu** `karel-block-followup` jako tvrdá vodicí hvězda
   - nesahá na žádný **skutečný manuál** (Machover, Jung asociační experiment, Koch baum, Buck HTP, Goodenough-Harris, dětské DID škály ACE/A-DES/CDC) — generuje obecné fráze

2. `karel-block-followup` model byl `gemini-2.5-flash` s volným promptem, **bez stavového automatu**, bez planned_words[8], bez progresu, bez trauma větve. Proto cyklil na slově „video".

3. `Spustit bod` (pravý panel) a `BlockDiagnosticChat` (inline) jely **dva oddělené proudy bez sdíleného protokolu**, takže slova vygenerovaná v jednom panelu druhý nezná.

4. **Žádné pre-flight setup briefingu** terapeutce — Karel jí předem neřekne „posaď ho proti sobě, zapisuj přesně, měř latenci stopkami, sleduj mimiku, odmlky, vegetativní reakce".

Tvrdit, že to bylo „hotové", bylo nepřesné. Bylo hotové UI a routing. **Klinika tam nebyla.**

## Co teď postavím

### 1) Manuálová knihovna metod (clinical playbooks)

Nový soubor `supabase/functions/_shared/clinicalPlaybooks.ts` s **pevnými** protokoly známých metod (čerpá z odborné literatury, ne improvizace AI):

- `association_experiment_jung` — 8/16/100 slov, latence (stopky), reprodukce, neutrální vs. afektivní slova, kritické indikátory komplexu (prodloužení latence, reprodukční chyba, perseverace, klang, odmítnutí, vegetativní reakce)
- `draw_a_person_machover` — pořadí kreslení, nátlak tužky, umístění, proporce, vynechané části, sexuální charakteristiky
- `tree_test_koch_baum` — koruna, kmen, kořeny, datace stáří, zóny papíru
- `htp_buck` — house/tree/person, dotazování post-drawing
- `kfd_burns` — kinetic family drawing, akce, vzdálenosti, vynechání postav
- `cat_tat_narrative` — projektivní vyprávění, hrdina, konflikt, řešení, konec
- `sandtray_lowenfeld` — výběr figurek, scénografie, narativ
- `did_screening_child` — adaptace dospělých nástrojů (A-DES, CDC) na dětský rozhovor
- `body_map_somatic` — kde to v těle cítíš, barvy, intenzita
- `safe_place_visualization` — grounding, kotvení

Každý playbook má pevnou strukturu:

```text
{
  method_id, method_label, source_refs,
  pre_session_setup: {
    supplies, room, therapist_position, child_position,
    what_to_say_first, what_NOT_to_say,
  },
  measurements_required: ["latency_seconds","first_response_verbatim","affect","posture","..."],
  step_protocol: [ {step, instruction, what_to_record, red_flags} ],
  trauma_response_protocol: { signs, immediate_actions, do_not_repeat_stimulus },
  closure_protocol: { reproduction_check, debrief_questions, grounding },
  scoring_criteria: [...],
  required_artifacts: ["audio","image","verbatim_transcript","latency_log"]
}
```

### 2) Detekce metody z bodu programu

Funkce `detectMethod(blockText)` v playbooks — fuzzy match (asociační experiment / kresba postavy / strom / dům-strom-postava / rodina / příběh / pískoviště / tělová mapa / bezpečné místo).

Pokud bod **nesedí** na žádný playbook → spustí se `karel-block-research` (Perplexity + Lovable AI) a vyrobí ad-hoc playbook ve **stejné struktuře** jako fixní playbooky. Tím nikdy nezůstane Karel bez manuálu.

### 3) Povinný pre-flight briefing terapeutce

V momentě, kdy terapeut klikne **Spustit bod**:

1. Karel **napřed** (ještě než dá první slovo / instrukci) pošle **setup briefing**:
   - pomůcky (stopky, papír na verbatim zápis, případně audio)
   - kde sedí terapeutka, kde dítě
   - co přesně říct dítěti (zarámování)
   - co rozhodně neříkat
   - co bude měřit a zapisovat (latence, doslovná odpověď, afekt, mimika, dech, postoj, vegetativní)
   - jak dlouho má bod trvat
   - kdy přerušit (red flags)

2. Teprve **po** odkliku „rozumím, můžeme začít" pojede vlastní step protokol (slovo 1 → slovo 8, instrukce ke kresbě, atd.).

### 4) Stavový automat v `karel-block-followup`

Backend přepnu z volného povídání na pevný state machine:

```text
{
  protocol_type: "association_experiment_jung",
  phase: "setup" | "running" | "trauma_pause" | "closure" | "done",
  step_index: 0..N,
  planned_steps: [ { stimulus, expected_measurements } ],
  responses: [ { stimulus, verbatim, latency_s, affect, notes } ],
  trauma_flag: bool,
  missing_measurements: [...],
}
```

Karel v každém turnu vrací:

```text
{
  action: "setup" | "give_stimulus" | "clinical_followup" | "trauma_pause" | "advance" | "close",
  stimulus_to_give: "video",
  instruction_to_therapist: "Řekni přesně slovo, spusť stopky, zapiš první slovo dítěte slovo od slova",
  what_to_record_now: ["verbatim","latency_seconds","afekt"],
  clinical_note: "Prodloužená latence + posun významu = indikátor komplexu",
  state_patch: { step_index +=1, ... }
}
```

**Anti-loop guard:** pokud `step_index` má vyplněnou `verbatim` odpověď a není `trauma_flag`, Karel **nesmí** vrátit stejný `stimulus_to_give`. Vynucené `advance` nebo `clinical_followup` nebo `trauma_pause`.

**Trauma větev:** když terapeut zapíše slovo obsahující trigger (flashback, týrání, freeze, disociace, pláč, ztuhla, zbledla, schovala se, mlčí…) NEBO model identifikuje vegetativní reakci → `phase = "trauma_pause"`, Karel přestane dávat další stimuly, dá:
   - validaci („to co popisuješ je klinicky významné, je to indikátor komplexu vázaného k tématu")
   - rozhodnutí: pokračovat / zvolnit / přerušit a přejít na grounding
   - co teď přesně sledovat
   - co zapsat
   - kdy se vrátit (nebo nevrátit) k testu

### 5) Inteligence: silnější model pro živé sezení

- `karel-block-followup` → `google/gemini-2.5-pro` (těžké klinické reasoning)
- `karel-block-research` strukturace → `google/gemini-2.5-pro`
- `karel-live-session-produce` → `google/gemini-2.5-pro`
- pre-research přes Perplexity `sonar-pro` (s dotazem mířeným na manuál konkrétní metody, ne obecnou definici)

Důvod: `flash` modely právě v této doméně zaostávaly — proto „idiocie" na flashbacku.

### 6) UI: strukturovaný sběr místo volného textu

V `BlockDiagnosticChat` při běžícím protokolu nahradím jeden free-form textarea malým **strukturovaným formulářem na turn**:

```text
Aktuální podnět od Karla: VIDEO
─────────────────────────────────
Doslovná odpověď dítěte: [____]
Latence (s):              [__]
Afekt:  □ neutrální □ napětí □ úzkost □ pláč □ ztuhnutí □ smích
Neverbální:               [____]  (mimika, dech, postoj)
Poznámka terapeutky:      [____]
─────────────────────────────────
[ Pošli a další ]   [ Trauma pauza ]   [ Zeptej se Karla ]
```

Pod tím chronologický transcript + progres `3 / 8`.

Pro nediagnostické body (volná hra, reflexe) zůstane jen volný textarea.

### 7) Sjednocení dvou panelů

`Spustit bod` v levém checklistu i `BlockDiagnosticChat` budou nově pracovat nad **jedním** session-block-state, držený v `DidLiveSessionPanel`. Karel v pravém panelu i v inline chatu uvidí stejný `step_index`, stejné `responses`, stejné `phase`. Zmizí rozjezd „dva mozky".

### 8) Closure brána per bod

Karel `phase: "done"` vrátí teprve když:
- jsou splněny `measurements_required` z playbooku
- jsou přiloženy `required_artifacts` (foto kresby, audio, verbatim log)

Když chybí, dá konkrétní follow-up („chybí mi doslovná reprodukce po pauze, prosím zeptej se znovu na slova 2, 5, 7"), nebo požádá o upload kresby. Tohle pak driveruje completion gate sezení.

## Soubory

| Soubor | Změna |
|---|---|
| `supabase/functions/_shared/clinicalPlaybooks.ts` | **NOVÝ** — knihovna 10+ pevných protokolů + `detectMethod()` |
| `supabase/functions/karel-block-research/index.ts` | doplní ad-hoc playbook ve stejné struktuře, Perplexity `sonar-pro` cílený na manuál metody, model na `gemini-2.5-pro` |
| `supabase/functions/karel-block-followup/index.ts` | přepis na stavový automat, anti-loop guard, trauma větev, model `gemini-2.5-pro`, povinný pre-flight setup |
| `supabase/functions/karel-live-session-produce/index.ts` | model `gemini-2.5-pro`, používá playbook, vrací setup briefing + plánované stimuly |
| `src/components/did/BlockDiagnosticChat.tsx` | auto-load playbooku/rešerše při startu, povinný setup briefing krok, strukturovaný turn-form, progres N/M, trauma pauza |
| `src/components/did/LiveProgramChecklist.tsx` | předání jediného block-state, sjednocení se Spustit bod |
| `src/components/did/KarelInSessionCards.tsx` | aktivační karta čte stejný block-state |
| `src/components/did/DidLiveSessionPanel.tsx` | drží `blockProtocolState` per bod, sdílí ho oběma panelům |

## Smoke test

1. Bod „Asociační experiment — 8 slov o rodině"
2. Klik **Spustit bod** → Karel **nedá hned slovo**, dá setup: stopky, papír verbatim, kde sedí dítě, co přesně říct, co měřit. Čeká na „rozumím".
3. Po potvrzení → slovo 1. Terapeut vyplní strukturovaný turn (verbatim, latence, afekt). Progres `1/8`.
4. Slovo 2…7 plynule.
5. Slovo „video" → terapeut vyplní afekt = „pláč/ztuhnutí" + poznámka „flashback, týrání". Karel **nesmí** opakovat „video", musí vrátit `trauma_pause` s validací, klinickým komentářem, doporučením, rozhodnutím o pokračování.
6. Po rozhodnutí pokračovat → slovo 8 nebo closure.
7. Closure: Karel požádá o reprodukční zkoušku (zopakování po pauze) + případně audio.
8. Bod zavřený jen když jsou měření a artefakty.

## Proč to dříve nebylo a poctivé přiznání

Předchozí iterace stavěla **pipe a UI**, ne **klinickou doktrínu**. Rešerše byla volitelná, prompt byl volný, model byl slabý, stav nebyl strukturovaný a manuály metod neexistovaly. Tím Karel působil „jako idiot" — protože bez pevných protokolů AI v této doméně klouže do obecných frází. Tato iterace přidává to, co tam mělo být od začátku: **pevné playbooky, povinný setup briefing, stavový automat s anti-loop a trauma větví, strukturovaný sběr měření a silnější model**.

