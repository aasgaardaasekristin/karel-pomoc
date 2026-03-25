

# Fix broken preset backgrounds + DID theme isolation

## Issues from screenshot

1. **Mandala** -- broken image (Wikimedia hotlinking blocked)
2. **Vodopád** -- broken image (invalid Unsplash photo ID)
3. **Louka** -- shows aerial mountains/valleys, not a flat green meadow
4. **DID theme isolation** -- `didStorageKey` maps "mamka" and "kata" to the same key (`theme_did_katerina`), and all other DID sub-modes (terapeut entry, therapist-threads, etc.) fall through to `theme_did_entry` -- no per-sub-mode isolation

## Changes

### 1. Fix broken/wrong image URLs in `src/components/ThemeEditorDialog.tsx`

Replace three entries in `PRESET_BACKGROUNDS`:

- **Louka**: Change to a flat green meadow image (Unsplash `photo-1500382017468-9049fed747ef` -- golden-green flat field)
- **Mandala**: Change to a working Unsplash mandala/kaleidoscope image (e.g. `photo-1545048702-79362596cdc9` or similar geometric pattern that loads reliably)
- **Vodopád**: Change to a working waterfall image (Unsplash `photo-1546182990-dffeafbe841d` -- sunlit waterfall)

All three will use standard Unsplash `images.unsplash.com/photo-XXX?w=1920&q=80` format with matching `?w=200&q=60` thumbnails, ensuring consistent loading.

### 2. Expand DID theme key isolation in `src/components/did/DidContentRouter.tsx`

Update both the inner (line 164) and outer (line 627) `didStorageKey` computations to give each sub-mode its own key:

```
mamka        → theme_did_mamka
kata         → theme_did_kata
cast + thread → theme_did_kids_{threadId}
cast (no thread) → theme_did_kids
(default/entry)  → theme_did_entry
```

This splits "mamka" and "kata" into separate keys (currently both map to `theme_did_katerina`), so each therapist persona gets independent theme settings.

### Files to edit

| File | Change |
|---|---|
| `src/components/ThemeEditorDialog.tsx` | Fix 3 image URLs in `PRESET_BACKGROUNDS` (lines 35, 41, 42) |
| `src/components/did/DidContentRouter.tsx` | Update `didStorageKey` in both inner (line 164-168) and outer (line 627-631) to separate mamka/kata keys |

