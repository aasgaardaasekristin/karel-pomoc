

# Per-context theme isolation

## Overview
Replace the current `persona`-based theme keying with a granular `context_key` system so each view (DID therapist, Hana thread, client card, etc.) gets independent appearance settings.

## 1. Database migration

```sql
-- Add context_key column, defaulting existing rows to use persona value
ALTER TABLE user_theme_preferences 
  ADD COLUMN IF NOT EXISTS context_key TEXT NOT NULL DEFAULT 'global';

-- Migrate existing data: copy persona values into context_key
UPDATE user_theme_preferences SET context_key = persona WHERE context_key = 'global' AND persona != 'default';

-- Drop old unique constraint and create new one
ALTER TABLE user_theme_preferences 
  DROP CONSTRAINT IF EXISTS user_theme_preferences_user_id_persona_key;
ALTER TABLE user_theme_preferences
  ADD CONSTRAINT user_theme_preferences_user_context_key UNIQUE (user_id, context_key);
```

## 2. ThemeContext.tsx refactor

Replace `currentPersona` with `currentContextKey`:
- State: `currentContextKey: string` (default `"global"`)
- `setContextKey(key: string)` — loads prefs from cache or DB for that key
- Cache: `Map<string, ThemePrefs>` for instant switching
- `loadPrefs` queries by `context_key` instead of `persona`
- `updatePrefs` upserts with `context_key` on conflict `user_id,context_key`
- **Fallback**: if no record for context_key, load `"global"` prefs as base
- Keep `persona` field in DB rows (set to context_key for backward compat)
- Keep `applyTemporaryTheme` / `restoreGlobalTheme` unchanged

Interface changes:
```
currentContextKey: string
setContextKey: (key: string) => void
```

## 3. Context key assignments

| View | context_key | Set where |
|---|---|---|
| Hub / main menu | `"global"` | Hub.tsx useEffect |
| DID Kateřina | `"did_katerina"` | DidContentRouter (therapist=mamka) |
| DID Kids thread | `"did_kids_{threadId}"` | DidContentRouter (thread select) |
| Hana mode | `"hana"` | HanaChat init |
| Hana thread | `"hana_thread_{threadId}"` | HanaChat thread select |
| Kartoteka client | `"kartoteka_client_{clientId}"` | Kartoteka selectClient |

## 4. Files to change

1. **Migration** — add `context_key` column, new unique constraint
2. **src/contexts/ThemeContext.tsx** — replace persona-based logic with context_key
3. **src/pages/Hub.tsx** — `setContextKey("global")` on mount
4. **src/components/hana/HanaChat.tsx** — `setContextKey` on init/thread change
5. **src/pages/Kartoteka.tsx** — `setContextKey` on client select
6. **src/components/did/DidContentRouter.tsx** — `setContextKey` per therapist/thread

## 5. What stays unchanged

- ThemeEditorDialog UI and draft pattern
- ThemeQuickButton component
- CSS variable derivation logic
- RLS policies (context_key is just a text column, same user_id check)
- Preset backgrounds feature

