

# Krok 6: Audit závislostí — výsledky

## handleManualUpdate (1123–1347) → useManualUpdate.ts

### Závislosti z Chat.tsx scope:

| Závislost | Typ | Řešení |
|---|---|---|
| `isManualUpdateLoading` | state | Nahradí `isLoadingRef` uvnitř hooku |
| `activeThread` | state | deps → useRef |
| `messages` | state | deps → useRef |
| `didSubMode` | state | deps → useRef |
| `didInitialContext` | state | deps → useRef |
| `didSessionId` | state | deps → useRef |
| `didThreads.updateThreadMessages` | hook method | deps → didThreadsRef |
| `saveConversation` | useCallback (stable) | deps — bez ref |
| `refreshHistory` | useCallback (stable) | deps — bez ref |
| `setActiveThread, setMessages, setDidSubMode, setDidInitialContext, setDidDocsLoaded, setDidSessionId, setDidFlowState` | React settery | deps — stabilní |
| `setSyncProgress` | state setter | **přesune se dovnitř hooku** (vlastní state) |
| `setIsManualUpdateLoading` | state setter | **přesune se dovnitř hooku** |

### Importy z modulů (ne closure — hook je importuje přímo):

| Import | Zdroj |
|---|---|
| `getAuthHeaders` | `@/lib/auth` |
| `supabase` | `@/integrations/supabase/client` |
| `toast` | `sonner` |
| `clearMessages` | `@/lib/chatHelpers` |
| `DID_DOCS_LOADED_KEY` | `@/lib/chatHelpers` |
| `DID_SESSION_ID_KEY` | `@/lib/chatHelpers` |
| `import.meta.env.VITE_SUPABASE_URL` | env var |

**Žádná skrytá closure.** Všechny závislosti jsou buď v deps interface, nebo module-level importy.

---

## renderDidContent (1600–2032) → DidContentRouter.tsx

### Closure závislosti — MUSÍ jít přes props:

**State/settery (30+):** `didFlowState`, `setDidFlowState`, `didSubMode`, `setDidSubMode`, `activeThread`, `setActiveThread`, `messages`, `setMessages`, `knownParts`, `didInitialContext`, `setDidInitialContext`, `didDocsLoaded`, `didSessionId`, `didLiveSession`, `setDidLiveSession`, `didLiveSessionReady`, `setDidLiveSessionReady`, `didLivePartContext`, `setDidLivePartContext`, `meetingIdFromUrl`, `setMeetingIdFromUrl`, `meetingTherapist`, `setMeetingTherapist`, `input`, `setInput`, `isLoading`, `isSoapLoading`, `isEnrichingContext`, `isFileAnalyzing`, `isAudioAnalyzing`, `isHandbookLoading`, `syncProgress`, `isManualUpdateLoading`, `mode`, `setMode`

**Hook výstupy:** `didContextPrime`, `didThreads`, `audioRecorder`, `attachments` + attachment handlers

**Refs:** `basicDocsRef`, `scrollRef`, `fileInputRef`, `textareaRef`

**Handler funkce (13 — musí být useCallback):** `onManualUpdate`, `handleDidSubModeSelect`, `handleQuickThread`, `handleSelectThread`, `handleNewCastThread`, `handlePartSelected`, `handleLeaveThread`, `handleDidEndCall`, `handleDidBackHierarchical`, `handleGenerateHandbook`, `handleWriteDiary`, `handleAudioAnalysis`, `handleAutoAnalyze`, `sendMessage`, `handleKeyDown`

**Setter:** `setDrivePickerOpen`

### Importy — DidContentRouter importuje přímo (ne přes props):

| Import | Zdroj | Kde v renderDidContent |
|---|---|---|
| `getAuthHeaders` | `@/lib/auth` | řádek 1850 (therapist-threads onSelectThread) |
| `supabase` | `@/integrations/supabase/client` | řádky 1803-1805 (pin-entry auto-prep) |
| `toast` | `sonner` | řádek 1772 (onEnd live session) |
| `ErrorBoundary` | `@/components/ErrorBoundary` | řádky 1632, 1766 |
| `ScrollArea` | `@/components/ui/scroll-area` | řádky 1604, 1631, ... |
| `Button` | `@/components/ui/button` | řádky 1680, 1929 |
| `Loader2` | `lucide-react` | řádek 1588, 1912 |
| Všechny DID komponenty | `@/components/did/*` | celý soubor |
| `ChatInputArea` | `@/components/chat/ChatInputArea` | řádek 1991 |
| `AudioRecordButton` | `@/components/AudioRecordButton` | řádek 2008 |
| `ChatMessage` | `@/components/ChatMessage` | řádek 1979 |

### Lokální komponenta `LoadingSkeleton` (řádek 1584):
Definována v Chat.tsx, použita na řádku 1981. **Řešení:** přesunout definici dovnitř DidContentRouter (3 řádky JSX, žádné závislosti).

### ⚠️ Nalezený problém — inline async v `onSelectThread` (therapist-threads, řádek 1848–1869):
Používá `getAuthHeaders()` a `import.meta.env.VITE_SUPABASE_URL` — obojí module-level, DidContentRouter je naimportuje přímo. **Bezpečné.**

### ⚠️ Nalezený problém — inline async v `onSuccess` (pin-entry, řádky 1794–1828):
Používá `supabase.from(...)` přímo — module-level import. **Bezpečné.**

---

## Závěr

**Žádná skrytá closure nebyla nalezena.** Obě sekce závisí buď na:
1. Hodnotách předávaných přes deps/props (explicitní interface)
2. Module-level importech (getAuthHeaders, supabase, toast, komponenty)

Plán je bezpečný k implementaci beze změn. `LoadingSkeleton` se přesune dovnitř DidContentRouter místo předávání přes props.

### Finální checklist — potvrzeno:

```text
useManualUpdate.ts:
  ✅ useRef + useEffect pro: activeThread, messages,
     didSubMode, didInitialContext, didSessionId, didThreads
  ✅ isLoadingRef guard v run()
  ✅ run = useCallback(async () => {...}, [])
  ✅ AbortController + useEffect cleanup
  ✅ signal.aborted v obou smyčkách (mirror ř.1179 + registry ř.1263)
  ✅ setSyncProgress(null) + isLoadingRef = false v finally
  ✅ Přímé importy: getAuthHeaders, supabase, toast,
     clearMessages, DID_DOCS_LOADED_KEY, DID_SESSION_ID_KEY

DidContentRouter.tsx:
  ✅ React.memo()
  ✅ LoadingSkeleton definován uvnitř (ne props)
  ✅ Přímé importy: getAuthHeaders, supabase, toast,
     ErrorBoundary, ScrollArea, Button, Loader2, všechny DID komponenty
  ✅ Všechny closure hodnoty → explicitní props

Chat.tsx:
  ✅ useCallback na 15 handler props
  ✅ handleManualUpdate → manualUpdate.run
  ✅ {renderDidContent()} → <DidContentRouter {...} />
  ✅ disabled={manualUpdate.isLoading} na UI tlačítku
```

