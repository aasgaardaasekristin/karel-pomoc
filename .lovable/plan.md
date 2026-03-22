

# FÁZE 1 — Review flow + BIRP+S + Úkoly

4 soubory, ~160 řádků, žádná DB migrace.

## 1. `supabase/functions/karel-session-intake/index.ts`

**A) Odstranit DB inserty** (ř. 167-206 — celý blok `client_sessions` insert + `client_tasks` insert). Edge funkce jen vrátí AI výsledek.

**B) Přidat `revisionRequest`** do destructuringu (ř. 26):
```typescript
const { clientId, inputType, textInput, audioBase64, sessionDate, therapistName, revisionRequest } = await req.json();
```

Pokud `revisionRequest` existuje, přidat na konec `userContent`:
```typescript
if (revisionRequest) {
  userContent.push({ type: "text", text: `\n\nINSTRUKCE K ÚPRAVĚ: ${revisionRequest}` });
}
```
(vložit po ř. 76, před AI call)

**C) BIRP+S formát** — v system promptu (ř. 99) změnit popis `summary`:
```
"summary": "Strukturovaný zápis ve formátu BIRP+S:\nB – PREZENTACE KLIENTA: [chování, vzhled, nálada, nonverbální projevy]\nI – INTERVENCE: [co terapeut dělal, jaké techniky použil]\nR – ODPOVĚĎ KLIENTA: [jak klient reagoval, co řekl, posun]\nP – PLÁN: [co příště, zaměření, témata]\nS – SUPERVIZNÍ POZNÁMKA (Karel): [klinická pozorování, hypotézy, rizika]"
```

## 2. `supabase/functions/karel-session-finalize/index.ts`

Nahradit markdown template (ř. 60-92) za BIRP+S:
```
B – PREZENTACE KLIENTA
(Chování, vzhled, nálada, nonverbální projevy)

I – INTERVENCE
(Co terapeut dělal, jaké techniky použil)

R – ODPOVĚĎ KLIENTA
(Jak klient reagoval, co řekl, posun)

P – PLÁN
(Co příště, zaměření, témata)

S – SUPERVIZNÍ POZNÁMKA (Karel)
(Klinická pozorování, hypotézy, rizika)

DIAGNOSTICKÁ HYPOTÉZA: [diagnóza]
JISTOTA: [nízká/střední/vysoká]
RIZIKA: [identifikovaná rizika]

### Úkoly pro terapeuta
- [HIGH/MEDIUM/LOW] popis

### Úkoly pro klienta
- popis
```

## 3. `src/components/report/SessionIntakePanel.tsx`

**A) Progress indikátor** (nahradit ř. 82-93):
- Import `useRef, useEffect`
- `startTimeRef = useRef(Date.now())` — nastavit v `handleSubmit`
- `spinnerChar` stav s `setInterval(100)` rotující `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`
- `progressText` aktualizovaný `setInterval(1000)` podle uplynulého času:
  - 0-3s: "Přijímám vstup..."
  - 3-8s: "Přepisuji audio..." (skip pokud ne audio)
  - 8-18s: "Analyzuju s kartou klienta..."
  - 18-25s: "Konzultuji odborné zdroje..."
  - 25s+: "Sestavuju zápis a doporučení..."

**B) Review flow** (nahradit result view ř. 96-213):
- Nové stavy: `revisionNote: string`, `isSaving: boolean`
- Nový ref: `originalBodyRef = useRef<any>(null)` — uložit request body v `handleSubmit`
- Odstranit toast z ř. 71
- Header: "Karel sestavil zápis – zkontroluj než uložíš"
- Zachovat stávající Tabs (ř. 114-178)
- Pod taby: Textarea "Napiš Karlovi co upravit... (volitelné)" → `revisionNote`
- Dvě tlačítka:
  - **🔄 Přepracovat**: fetch `karel-session-intake` s `{ ...originalBodyRef.current, revisionRequest: revisionNote }` → setResult → review znovu
  - **✅ Uložit do sezení**: `saveToDb()`:
    1. `supabase.from("client_sessions").insert(...)` — session_number, ai_analysis (summary), ai_hypotheses (analysis), ai_recommended_methods, ai_risk_assessment, notes, report_next_session_goal, report_missing_data
    2. Insert questionnaire → `client_tasks` (task_type: "therapist_question")
    3. Insert homework → `client_tasks` (task_type: "client_homework", for_session: sessionNumber + 1)
    4. Toast "Sezení č. N uloženo" + `onComplete()`
- Odstranit ř. 205 text "Dotazník a úkoly byly automaticky uloženy"

## 4. `src/components/report/ClientTasksPanel.tsx`

- Přidat `for_session?: number | null` do `ClientTask` interface (ř. 10-22)
- Groupovat non-done úkoly (therapist_question + client_homework) podle `for_session` pomocí `reduce`
- Pro každou skupinu: header "ZE SEZENÍ č. N" + editovatelný `due_date` input
- Uvnitř skupiny: sekce PRO TERAPEUTA / PRO KLIENTA
- Priority: 🔴 high / 🟡 medium / 🟢 low
- Stávající "Vlastní úkoly" sekce zůstává beze změny pod skupinami

## Klíčové rozhodnutí

- `originalBodyRef = useRef<any>(null)` — NE state, žádný zbytečný re-render
- DB save přesunut z edge funkce na frontend → umožňuje review + přepracování bez duplicit

