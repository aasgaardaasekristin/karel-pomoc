

## Problém

Edge function `karel-did-episode-generate` není registrována v `supabase/config.toml`. Lovable potřebuje tento záznam pro deploy. Funkce samotná funguje správně (logy ukazují úspěšné běhy).

## Oprava

Přidat do `supabase/config.toml`:

```toml
[functions.karel-did-episode-generate]
verify_jwt = false
```

Jeden řádek, hotovo. Po přidání se funkce úspěšně nasadí.

