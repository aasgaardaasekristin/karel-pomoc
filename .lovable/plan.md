

## Oprava: Fixní pozadí jen na welcome obrazovce

### Problém
Na řádku 735–738 v `HanaChat.tsx` se `hanaBg` renderuje **vždy** (bez podmínky), takže přepisuje theme i v aktivních vláknech.

### Oprava
Jediná změna — obalit background div podmínkou `!chatStarted`:

**Soubor: `src/components/hana/HanaChat.tsx`, řádky 735–738**

Před:
```tsx
<div
  className="fixed inset-0 bg-cover bg-center bg-no-repeat pointer-events-none z-0 opacity-80"
  style={{ backgroundImage: `url(${hanaBg})` }}
/>
```

Po:
```tsx
{!chatStarted && (
  <div
    className="fixed inset-0 bg-cover bg-center bg-no-repeat pointer-events-none z-0 opacity-80"
    style={{ backgroundImage: `url(${hanaBg})` }}
  />
)}
```

### Žádné další změny
Nic jiného se nemění — welcome obrazovka, layout, theme systém, správa, vlákna zůstávají beze změny.

