

## Problem

Clicking "Zrcadlit do Drive" twice rapidly results in **both calls executing fully**. The client-side cooldown (`mirrorCooldownRef`) and the `isMirroring` state guard both fail to prevent the second call because:

1. **State guard (`isMirroring`)**: Two clicks in rapid succession both fire before React re-renders with `isMirroring = true`.
2. **Ref cooldown**: Should work in theory (refs are synchronous), but the `useCallback` with `[isMirroring]` dependency may cause issues — when the callback is recreated on re-render, the ref check runs correctly, but both clicks use the **same callback closure** before any re-render happens.

The root cause is likely that both synchronous click handlers run in the same React batch, and both see `mirrorCooldownRef.current = 0` if they execute in the exact same tick.

## Fix — Two changes

### 1. Add a dedicated `isMirroringRef` (synchronous mutex)
Replace the `isMirroring` state check with a **ref-based mutex** that updates synchronously within the handler, before any async work:

```typescript
const isMirroringRef = useRef(false);

const handleMirrorToDrive = useCallback(async () => {
  // Synchronous mutex — prevents any concurrent execution
  if (isMirroringRef.current) {
    toast.info("Redistribuce byla spuštěna nedávno. Počkej chvíli.");
    return;
  }
  isMirroringRef.current = true;
  setIsMirroring(true); // for UI (disabled state, spinner)
  
  try {
    // ... existing logic ...
  } finally {
    setIsMirroring(false);
    // Keep mutex locked for 60s cooldown
    setTimeout(() => { isMirroringRef.current = false; }, 60_000);
  }
}, []); // No dependencies needed — ref-based
```

This eliminates the `mirrorCooldownRef` entirely and replaces it with a single ref that acts as both mutex and cooldown.

### 2. Remove `[isMirroring]` dependency from `useCallback`
The current `[isMirroring]` dependency causes the callback to be recreated on every state change, which is unnecessary when using refs. The new callback will have **no dependencies** (`[]`), ensuring a single stable function reference.

### Files to edit
- `src/components/hana/HanaChat.tsx` — Replace `mirrorCooldownRef` + `isMirroring` check with `isMirroringRef` mutex pattern.

