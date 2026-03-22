

# Sprint 3: Výběrový dialog + Auto-insert úkolů

## Verified findings

**for_session calculation**: In `karel-session-finalize`, `count` is fetched at line 34 (BEFORE insert at line 104). So `count` = number of previous sessions, current session = `count + 1`, tasks for next session = `count + 2`. The original `(count ?? 0) + 2` is correct.

**createSession** returns `string` (session ID) -- confirmed from context code.

## 4 files to change

### 1. `src/contexts/ActiveSessionsContext.tsx`
- Add `sessionPlan?: any` to `SessionWorkspace` interface (after line 14)
- Add `updateSessionPlan: (id: string, plan: any) => void` to context type interface
- Add implementation using existing `updateSession` helper
- Add to provider value

### 2. `src/pages/Kartoteka.tsx`
- Import `useActiveSessions`
- In SessionPlanPanel's `onStartSession` callback: call `createSession(clientId, clientName)` then `updateSessionPlan(id, plan)` then `navigate("/chat")`

### 3. `src/components/report/LiveSessionPanel.tsx`
- Add `sessionMode` state: `"plan" | "modify" | "custom" | "free" | null` (null = show dialog)
- Read `activeSession?.sessionPlan` from context
- When `messages.length === 0 && sessionMode === null`: render selection dialog (4 radio options, "Podle navrhu" disabled if no plan)
- On mode selection: set `sessionMode`, trigger greeting with mode-specific text
- In `buildContext()` (the part that constructs chat context for the edge function): if `sessionMode === "plan"`, append plan phases
- Add `customTopic` state for "modify" and "custom" modes with textarea

### 4. `supabase/functions/karel-session-finalize/index.ts`
- Add two new sections to the prompt template (after line 77):
  ```
  ### Ukoly pro terapeuta
  - [HIGH/MEDIUM/LOW] popis
  
  ### Ukoly pro klienta
  - popis
  ```
- After getting `report` (line 101), parse tasks with escaped regex:
  ```typescript
  function parseTasks(text: string, heading: string) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = text.match(new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n###|$)`));
    if (!section) return [];
    return [...section[1].matchAll(/- (?:\[(HIGH|MEDIUM|LOW)\] )?(.+)/gi)]
      .map(m => ({ task: m[2].trim(), priority: (m[1] || "medium").toLowerCase() }));
  }
  ```
- Insert tasks into `client_tasks` with `for_session: (count ?? 0) + 2` (correct -- count is pre-insert)
- Only insert if tasks array is non-empty
- Return `{ report, tasks }` (backward compatible)

## Estimated: ~120 lines across 4 files, no DB migration

