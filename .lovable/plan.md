

# Asistence: Napojení na připravená sezení z DB

## Problém
Když terapeut přejde na záložku **Asistence**, volby "Podle návrhu" a "Upravit návrh" jsou disabled, protože `hasPlan` závisí na `sessionPlan` v localStorage (`ActiveSessionsContext`). Ten se nastaví pouze při kliknutí "Zahájit asistenci" v záložce Připravit sezení ve stejné browser session. Pokud terapeut přijde později, `activePlan` je `null` → plány z DB se nenačtou.

## Řešení

### 1. `LiveSessionPanel.tsx` — načtení příprav z DB + výběr plánu

**Při zobrazení mode-selection dialogu (řádky 444-518):**
- Přidat `useEffect` na fetch `session_preparations` pro aktuální `clientId` z DB (stejně jako v `ClientSessionPrepPanel`)
- Pokud existují uložené přípravy a `hasPlan` je false, zobrazit seznam příprav k výběru
- **"Podle návrhu"**: Pokud je 1 příprava → načíst rovnou. Pokud více → zobrazit picker (radio/select) s číslem sezení a datem
- **"Upravit návrh"**: Stejný picker + textarea pro úpravy. Karel v Asistenci generuje upravený plán (ne v záložce Připravit), nechá odsouhlasit, pak spustí asistenci
- Po výběru plánu: uložit do `updateSessionPlan(resolvedSessionId, selectedPlan)` → `hasPlan` se stane true

**Nový flow pro "Upravit návrh":**
- Po potvrzení volby Karel vygeneruje upravený plán přímo v chat (streamovaný výstup z `karel-session-plan` s `modificationsRequested`)
- Zobrazí výsledek jako assistant message s tlačítky "Schválit a začít" / "Další úpravy"
- Po schválení přejde do live asistence s upraveným plánem

### 2. `LiveSessionPanel.tsx` — nový stav pro modify flow

- Přidat stav `modifyPhase: "pick" | "editing" | "reviewing" | null`
- V "editing" fázi: Karel se ptá na změny, terapeut odpovídá
- V "reviewing" fázi: Karel generuje nový plán, terapeut schvaluje/upravuje
- Po schválení: `setModeConfirmed(true)` → standardní live asistence

### 3. Změny ve mode-selection UI

- Odebrat `disabled` z "Podle návrhu" a "Upravit návrh" pokud existují DB přípravy (i když `hasPlan` je false)
- Přidat podmíněný picker příprav pod radio options když je vybrán "plan" nebo "modify"
- Picker zobrazí: "Sezení č. X — datum" pro každou přípravu

## Soubory
- `src/components/report/LiveSessionPanel.tsx` — hlavní změny (DB fetch, picker, modify flow)

## Technické detaily
- DB query: `supabase.from("session_preparations").select("id, session_number, created_at, plan, approved_at").eq("client_id", clientId).order("created_at", { ascending: false })`
- Pro modify flow: volání `karel-session-plan` s `modificationsRequested` parametrem, streaming odpověď zobrazená v chatu
- Po schválení upraveného plánu: uložit do `sessionPlan` přes `updateSessionPlan`

