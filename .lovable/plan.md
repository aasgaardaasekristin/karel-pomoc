

# Diagnostika: Proč Hanička zobrazuje jen 2 vlákna na PC

## Zjištění z databáze

Databáze obsahuje **15 vláken** (10 s uživatelskými zprávami) — všechna patří stejnému `user_id`. RLS politiky jsou správné. Data v DB jsou v pořádku.

## Identifikovaný bug

Problém je **race condition při inicializaci**. Komponenta `HanaThreadHistory` volá `fetchThreads()` okamžitě při mount, ale v ten moment nemusí být ještě obnovená auth session z localStorage. Supabase klient obnovuje JWT asynchronně — pokud query dorazí dřív, RLS vrátí 0 řádků (auth.uid() je null).

Realtime subscription pak čeká jen na *změny v tabulce*, ne na obnovení auth session → pokud se na tabulce nic nezmění, stará (prázdná nebo neúplná) data zůstanou.

Na mobilu to funguje, protože uživatelka tam aktivně píše → tím se tabulka mění a realtime refetch doběhne už s platným tokenem.

## Plán opravy

### 1. Přidat listener na auth state change v HanaThreadHistory
Když se auth session obnoví (`onAuthStateChange`), znovu zavolat `fetchThreads()`. Tím se zajistí, že i když první fetch doběhne bez tokenu, druhý (po auth restore) přinese správná data.

```text
useEffect(() => {
  fetchThreads();  // existing

  // NEW: re-fetch when auth session is restored
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      fetchThreads();
    }
  });

  const channel = supabase.channel(...)...;

  return () => {
    subscription.unsubscribe();
    supabase.removeChannel(channel);
  };
}, [fetchThreads]);
```

### 2. Stejný fix v HanaChat loadActiveConversation
Funkce `loadActiveConversation` (řádek 116-144) také běží na mount a může mít stejný timing problém. Zabalit ji do `supabase.auth.getSession()` guardu, aby počkala na platnou session.

### 3. Soubory k úpravě
- `src/components/hana/HanaThreadHistory.tsx` — přidat `onAuthStateChange` listener
- `src/components/hana/HanaChat.tsx` — obalit init do auth session guardu

