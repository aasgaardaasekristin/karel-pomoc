

# FÁZE 2.6 — Finální kanonické kolo

## Audit aktuálního stavu

Po důkladném průchodu všech 8 souborů je stav následující:

---

## P1 body

### 1. `partCardExists()` — thread-sorter řádky 617–667

**Aktuální stav:** Lookup je správně omezen na `01_AKTIVNI_FRAGMENTY` a `03_ARCHIV_SPICICH` pod `kartotekaRootId`. Používá `findFolder` a `listFiles` z `driveHelpers.ts`. Fail-closed bez tokenu i bez root ID.

**Zbývající problém (řádek 645):**
```typescript
if (!sub.name.toUpperCase().includes(canonicalName.toUpperCase())) continue;
```
Toto je `includes` match na název subfolderu. Pokud existuje folder `ANNA_BACKUP` a hledáme `ANNA`, projde. Nebo pokud je folder `MARIANNA` a hledáme `ANNA`, taky projde.

**Oprava:** Změnit na přesný match — folder name musí být buď přesně `canonicalName` (case-insensitive), nebo `canonicalName` s definovaným separátorem (např. `ANNA_` prefix, podtržítko/mezera). Nejbezpečnější varianta:
```typescript
const subUpper = sub.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const targetUpper = canonicalName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
if (subUpper !== targetUpper && !subUpper.startsWith(targetUpper + "_")) continue;
```

### 2. `reactive-loop` — raw text do KARTA

**Aktuální stav:** Zdroj D (osobní vlákna, řádky 480–521) používá `signal.derived_clinical_implication` pro KARTA zápis — to je správně abstrahovaný výstup z `deriveClinicalImplication()` v `signalNormalization.ts`. Nikdy neobsahuje raw text.

**Zdroj C (answered questions, řádky 352–367):** Zapisuje `answer.slice(0, 500)` do KARTA. Toto je odpověď **terapeutky** (ne osobní vlákno Hany), takže klinicky je to v pořádku — terapeut píše o části.

**Zbývající problém:** V Zdroji C chybí explicitní komentář vysvětlující, proč je raw answer přípustný (je to terapeutský vstup, ne soukromý obsah). Přidat komentář.

**Uncertain entity v Zdroji C (řádky 370–386):** Správně triggeruje watchdog, nikdy tiše neskipuje.

**Uncertain entity v Zdroji D (řádky 506–517):** Správně triggeruje watchdog.

### 3. `forcePart` — auto-session-plan řádky 450–490

**Aktuální stav:** Plně správný. Volá `resolveEntity(forcePart, entityRegistryForForce, true)`, odmítá pokud není `confirmed_did_part` nebo `confirmed_part_alias`, vrací `{ success: false, reason: "invalid_force_part" }`. Používá canonical name z resolveru.

**Žádná změna potřeba.**

### 4. `can_be_session_target` — auto-session-plan řádky 507–543 + reactive-loop řádky 546–566

**auto-session-plan:** Správně iteruje candidates v urgency pořadí, testuje `resolved.can_be_session_target` s `hasRecentThreads` jako communicability evidence. Pokud žádný candidate neprojde, vrací `{ success: false, reason: "no_session_target" }`.

**reactive-loop Zdroj D:** Řádky 554–566 — pokud `!partResolved.can_be_session_target`, nastaví `agendaRelatedPart = null`, `agendaTopicType = "observation"`, prefix `[monitoring-only]`. Správně.

**Zdroj C (řádky 337–344):** Agenda insert pro answered questions nemá session-target gate. Ale toto je `topic_type: "followup"` s `priority: "when_appropriate"` — není to direct-work proposal, je to follow-up na zodpovězenou otázku. **Akceptovatelné**, ale přidat komentář.

**Žádná kritická změna potřeba.**

### 5. Closure deadlock — karel-crisis-closure-meeting řádky 112–123

**Aktuální stav:** Řádky 112–118 obsahují explicitní komentář o nekruhové logice. Readiness závisí na obsahu porady (stanoviska + statement + doporučení), ne na `status === "finalized"`. Finalizace nastává až po úspěšném `closed`.

**Žádná změna potřeba.** Dokumentace je na místě.

---

## P2 body

### B. `entityRegistry` — fail-closed dokumentace

**Aktuální stav:** `stampIndexConfirmation` (řádky 310–326) má rozsáhlý komentář dokumentující conscious fail-closed rozhodnutí. `getPartNames()` a `getAllKnownNames()` (řádky 274–302) iterují přes `byNormalizedCanonical.values()` (deduplicated map), ne raw entries.

**Žádná změna potřeba.** Vše je korektní.

### F. Dedup / payload fingerprint — classifiedActionExecutor

**Aktuální stav:** `payloadFingerprint()` (řádky 52–71) hashuje celý normalizovaný payload po strip headers. `isDuplicateWrite()` (řádky 79–117) používá composite key `source_id + content_type + subject_id + payload_fingerprint`.

**Žádná změna potřeba.** Implementace je korektní.

### H1. `consecutiveStableEntries`

**Aktuální stav:** Řádky 563–571 — IIFE s explicitním komentářem: "DERIVED VALUE computed at render time from crisis_daily_assessments — NOT a physical DB column."

**Žádná změna potřeba.**

### H2. `clinical_summary` mimo closing flow

**Aktuální stav:** `buildCurrentSummary` (řádky 271–312) mapuje všech 9 operating states na české labely. Zahrnuje trend, staleness (hodiny bez kontaktu), zásah (fungoval/nefungoval/čeká se), a chybějící data.

**Žádná změna potřeba.**

---

## Shrnutí — jediná skutečná změna

Jedinou kódovou změnou je **zpřísnění folder name match v `partCardExists()`** (thread-sorter řádek 645). Aktuální `includes` match je příliš hrubý a může produkovat false positives.

Ostatní body jsou v pořádku — přidat maximálně 2 dokumentační komentáře (Zdroj C v reactive-loop).

### Soubory k úpravě

| Soubor | Co se mění |
|--------|-----------|
| `supabase/functions/karel-daily-thread-sorter/index.ts` | Řádek 645: `includes` → přesný canonical match na folder name |
| `supabase/functions/karel-reactive-loop/index.ts` | Řádky 352, 337: přidat dokumentační komentáře (proč je raw answer přípustný v Zdroji C; proč Zdroj C followup nepotřebuje session-target gate) |

### Soubory BEZ ZMĚN (ověřeno jako korektní)

- `entityRegistry.ts` — dedup, fail-closed, exportované seznamy OK
- `entityResolution.ts` — permission model, `can_be_session_target` OK
- `entityWatchdog.ts` — dedup, both-therapists question, KDO_JE_KDO write OK
- `karel-did-auto-session-plan/index.ts` — `forcePart` identity gate, `can_be_session_target` loop OK
- `karel-crisis-closure-meeting/index.ts` — nekruhová closure logika zdokumentována OK
- `src/hooks/useCrisisOperationalState.ts` — derived values, operating state labels OK
- `classifiedActionExecutor.ts` — dedup fingerprint, composite key OK

