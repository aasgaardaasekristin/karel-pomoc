

## Plan: Redesign DidPartSelector to mirror SessionSidebar UI pattern

The current `DidPartSelector` works but has a different visual structure than the professional "Práce" mode (`SessionSidebar`). The user wants it adapted to match that clean pattern — with a Select dropdown for existing parts, a "new part" input below, and an "Otevřít kartotéku" button — while also adding auto-creation logic for unknown parts.

### What changes

**1. Rewrite `DidPartSelector.tsx`** to match `SessionSidebar` layout:
- Hero section: icon + "Sezení s částí" title + subtitle
- Card with:
  - **Select dropdown** (like `SessionSidebar`) listing all `did_part_registry` parts sorted alphabetically by `display_name`, showing status indicators
  - **"Zahájit sezení"** button (like "+ Zahájit sezení")
  - Divider "NEBO NOVÁ ČÁST"
  - **Input + UserPlus button** for new part name
- Below the card: **"Otevřít kartotéku"** button (navigates to DID registry overview / opens kartotéka view)

**2. Auto-create new parts in registry:**
- When a new name is typed that doesn't exist in `did_part_registry`:
  - Find the smallest unused 3-digit ID (scan existing `part_name` values for pattern `NNN_Name`)
  - Insert new row into `did_part_registry` with `part_name = "NNN_NewName"`, `display_name = "NewName"`, `status = "active"`
  - Then proceed to `DidPartCard` step

**3. "Otevřít kartotéku" action:**
- Add an `onOpenKartoteka` callback prop
- In `Chat.tsx`, wire it to show the `DidRegistryOverview` with clickable part cards (existing `onSelectPart` prop already exists on that component)
- Add a new `didFlowState` value `"did-kartoteka"` that renders a full kartotéka view within the DID flow (list of all parts, clickable to open their `DidPartCard`)

### Technical details

**DidPartSelector changes:**
- Replace the scrollable button list with a `<Select>` dropdown (same component as SessionSidebar)
- Keep search functionality inside SelectContent if many parts
- New part creation: query `did_part_registry` for all `part_name` values, extract numeric prefixes, find smallest unused 3-digit number, construct `part_name` as `{NNN}_{sanitizedName}`
- Insert into DB, then call `onSelectPart(newPartName)`

**Chat.tsx changes:**
- Add `"did-kartoteka"` to `DidFlowState` type
- When "Otevřít kartotéku" clicked → `setDidFlowState("did-kartoteka")`
- Render a kartotéka list view (reuse `DidRegistryOverview` or create inline version) where clicking a part opens `DidPartCard`

**DidRegistryOverview kartotéka view:**
- Already has `onSelectPart` prop — wire it to set `didLiveSession` and go to part card step

### Files to modify
- `src/components/did/DidPartSelector.tsx` — full rewrite to match SessionSidebar pattern
- `src/pages/Chat.tsx` — add `"did-kartoteka"` flow state, wire kartotéka button

