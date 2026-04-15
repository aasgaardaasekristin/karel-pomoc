

# Oprava: Chybějící vstupní pole pro Káťu

## Problém

Sekce I (ř. 1001-1023) má **jeden** společný textarea „Napište Karlovi vzkaz" — nerozlišuje mezi Haničkou a Káťou. Uživatel opakovaně požaduje **dva oddělené řádky**: jeden pro Haničku, druhý pro Káťu.

## Řešení

Nahradit jednu Textarea dvěma oddělenými inline vstupními poli:

```
📝 Haničko, tvůj vzkaz pro Karla:
[ __________________________ ] [▸]

📝 Káťo, tvůj vzkaz pro Karla:
[ __________________________ ] [▸]
```

Každé pole odešle do `did_threads` s rozlišeným `thread_label`:
- `"Vzkaz od Haničky z přehledu — {datum}"`
- `"Vzkaz od Káti z přehledu — {datum}"`

## Soubor

`src/components/did/KarelDailyPlan.tsx` ř. 1001-1023 — nahradit jeden blok dvěma identickými, každý s vlastním state (`hankaMessage` / `kataMessage`) a labelem.

## Akceptační kritéria

- Dva oddělené vstupní řádky (Hanička, Káťa) — vždy viditelné
- Každý má vlastní odesílací tlačítko
- Thread label identifikuje odesílatele
- Žádný jiný soubor se nemění

