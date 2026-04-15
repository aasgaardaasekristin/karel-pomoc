

# Plan: Crisis Banner Fixes + Jungian Visual Activation

## Current Problems Identified

1. **Duplicate "79h bez kontaktu"** — appears twice in the banner: once as a yellow badge (line 94-98 of CrisisAlert.tsx), and again inside `mainBlocker` text (line 110-114) which renders "79h bez kontaktu — nutný update" via `computeMainBlocker`
2. **"Hanička" displayed separately** in the banner top row (line 78) — confusing, should be removed from the top-level badge row
3. **"chybí: interview, feedback" badges are not clickable** — currently just static `<span>` elements
4. **CTA buttons ("Vyžádat update", "Spustit dnešní hodnocení")** — they only toggle open the CrisisOperationalDetail panel, they don't navigate to threads or call backend functions directly
5. **Jungian visual effects (mandala, particles) not visible** — the CSS exists (.jung-study class lines 412-530 of index.css) but the class is only applied inside DidDashboard component; it's not applied to the parent container or body, so `position: fixed` pseudo-elements may be clipped by `overflow: hidden` ancestors

## Plan

### Step 1: Fix Crisis Banner Duplicates
**File:** `src/components/karel/CrisisAlert.tsx`

- **Remove duplicate "bez kontaktu" badge**: Remove the `card.isStale` badge (lines 94-98) since the same info is in `mainBlocker`
- **Remove standalone "Hanička" text**: Remove line 78 (`card.primaryTherapist` text) — this info is already in the expanded detail
- **Add plain text contact info**: Show two plain text spans: `{hoursStale}h bez kontaktu s částí` and `{hoursWithoutTherapistContact}h bez kontaktu terapeutů` (the latter derived from `card.awaitingResponseFrom` or `card.lastContactAt`)

### Step 2: Make "chybí" Badges Clickable
**File:** `src/components/karel/CrisisAlert.tsx`

- **"interview" click** → Navigate to DID/Kluci and open a new crisis thread with the part in crisis. This requires:
  - Accept a new prop `onNavigateToCrisisThread?: (partName: string, eventId: string) => void` 
  - When clicked, call this prop with the crisis part name
  - The parent (App.tsx) will need to route to the chat page with DID mode, Kluci sub-mode, and auto-create a thread with Karel's opening message for a crisis interview

- **"feedback" click** → Navigate to PendingQuestionsPanel filtered for this crisis. This means:
  - Accept a new prop `onNavigateToFeedback?: (eventId: string) => void`
  - When clicked, expand the banner detail to the "management" tab, scrolled to the Q/A section

Given the complexity of deep-linking to DID/Kluci thread creation with Karel's auto-generated opening, I'll implement this in two parts:
  - **Phase A (this step)**: "interview" → expands detail + opens management tab (same as start_interview CTA). "feedback" → expands detail + opens management tab scrolled to Q/A
  - The navigation will use the existing CTA mechanism (handleCTAClick)

### Step 3: Fix CTA Button Functionality
**Files:** `src/components/karel/CrisisAlert.tsx`, `src/components/karel/CrisisDailyManagement.tsx`

- **"Vyžádat update"** currently just opens the management tab. It should also call the backend `karel-crisis-daily-assessment` to trigger a daily cycle refresh. Will wire it to call `callFn("karel-crisis-daily-assessment", { crisisId })` when clicked.
- **"Spustit dnešní hodnocení"** should call `karel-crisis-interview` edge function to start an interview. Will wire it to call `callFn("karel-crisis-interview", { crisis_event_id })`.

I need to verify these edge functions exist and their expected parameters.

### Step 4: Fix Jungian Visual Effects
**File:** `src/index.css`, `src/components/did/DidDashboard.tsx`

The `.jung-study` pseudo-elements (`::before` mandala, `::after` particles) use `position: fixed` but the `.jung-study` div is inside `<main>` which has `overflow-y: auto`. Fixed-position pseudo-elements should work despite overflow, but the `z-index: 0` may cause them to render behind the background.

Fix: 
- Ensure pseudo-elements have correct z-index stacking
- Move `.jung-study` wrapper to use `min-h-screen` with `isolation: isolate` to create proper stacking context
- Verify the background gradient in `.jung-study` isn't fully opaque (covering the pseudo-elements)
- The main issue: `::before` and `::after` with `position: fixed` work, but the `.jung-study` class sets a solid `background:` with multiple gradient layers that are fully opaque — the pseudo-elements render behind this opaque background. Fix by making the background semi-transparent or applying the pseudo-elements with higher z-index while keeping content above them.

### Step 5: Fix KarelDailyPlan Loading State
**File:** `src/components/did/KarelDailyPlan.tsx`

From the screenshot, the hero section shows grey placeholder blocks. The 05A Drive read may be failing silently. Need to ensure the DB fallback renders properly when Drive read fails.

## Implementation Order
1. Step 1 + Step 2 (banner fixes) — highest user-visible impact
2. Step 4 (visual effects) — visible confirmation of Jungian aesthetic
3. Step 3 (CTA functionality) — operational improvement
4. Step 5 (loading fix) — data display reliability

## Files to Modify
- `src/components/karel/CrisisAlert.tsx` — banner dedup, clickable badges
- `src/index.css` — fix Jungian visual z-index/opacity
- `src/components/did/DidDashboard.tsx` — stacking context fix
- `src/components/did/KarelDailyPlan.tsx` — loading state fix

