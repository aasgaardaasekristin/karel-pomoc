import { assertEquals, assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  validateVisibleClinicalBriefingText,
  fixKnownPartGrammar,
  partForms,
} from "./index.ts";

Deno.test("audit-prose input is rejected (DID-relevantní + raw + source)", () => {
  const bad = "Hana/Osobní: použité jsou jen zpracované DID-relevantní implikace, ne raw osobní obsah. Souhrn zdrojů potvrzuje zejména: karel hana conversations, live session progress, therapist tasks.";
  const audit = validateVisibleClinicalBriefingText(bad);
  assertFalse(audit.ok);
  assert(audit.forbidden_terms_count > 0, "must flag forbidden audit terms");
});

Deno.test("low-value implication 'Zohlednit v nejbližším plánování' is flagged", () => {
  const sentence = "Z pracovních implikací beru hlavně toto: gustik: Zohlednit v nejbližším plánování, briefingu nebo follow-upu.";
  const audit = validateVisibleClinicalBriefingText(sentence);
  assertFalse(audit.ok);
  assert(audit.low_value_implication_count > 0 || audit.forbidden_terms_count > 0);
});

Deno.test("clean human clinical opening passes the gate", () => {
  const ok = [
    "Dobré ráno, Haničko a Káťo.",
    "Dnešní přehled navazuje hlavně na včerejší otevřené Sezení s Gustíkem z 30. 4. 2026. Záznam ukazuje, že práce byla zahájená a částečně rozpracovaná, ale ještě z ní nemáme uzavřený klinický závěr.",
    "Pro dnešek z toho plyne jednoduchý první krok. Nezačínat výkladem, ale ověřit tělo, emoci a bezpečí kontaktu.",
    "Haničko, drž otázky krátké a bezpečné. Káťo, prosím hlídej, aby se z otevřeného Sezení nedělal hotový závěr dřív, než kluci sami ukážou, co je pro ně pravda dnes.",
  ].join("\n\n");
  const audit = validateVisibleClinicalBriefingText(ok);
  assertEquals(audit.forbidden_terms_count, 0);
  assertEquals(audit.low_value_implication_count, 0);
  assert(audit.has_concrete_clinical_fact);
  assert(audit.has_practical_next_step);
  assert(audit.ok, `expected ok, violations=${audit.violations.join("|")}`);
});

Deno.test("Czech grammar: 'navázat na Gustík' → 'navázat na Gustíka'", () => {
  const fixed = fixKnownPartGrammar("Můžeme navázat na Gustík malým krokem.");
  assert(fixed.includes("na Gustíka"), `got: ${fixed}`);
  assertFalse(fixed.includes("na Gustík "));
});

Deno.test("Czech grammar: 's gustik' → 's Gustíkem', 'k gustik' → 'k Gustíkovi'", () => {
  assertEquals(fixKnownPartGrammar("pracoval jsem s gustik dnes ráno"), "pracoval jsem s Gustíkem dnes ráno");
  assertEquals(fixKnownPartGrammar("vrátím se k gustik"), "vrátím se k Gustíkovi");
});

Deno.test("partForms exposes all six cases for known parts", () => {
  const f = partForms("Gustík");
  assert(f);
  assertEquals(f!.instrumental, "Gustíkem");
  assertEquals(f!.accusative, "Gustíka");
  assertEquals(f!.dative, "Gustíkovi");
});

Deno.test("forbidden term 'review / průběhové evidence' is rejected", () => {
  const bad = "Dobré ráno. Zdrojově vycházím z review / průběhové evidence a nepředstírám víc, než záznam unese. První krok: ověřit tělo a emoci.";
  const audit = validateVisibleClinicalBriefingText(bad);
  assertFalse(audit.ok);
  assert(audit.forbidden_terms_count > 0);
});

Deno.test("forbidden phrase 'Co je jen stopa v datech' is rejected", () => {
  const bad = "Dobré ráno. Nejasné zůstává, co je jen stopa v datech bez aktuální odpovědi kluků. První krok: ověřit tělo.";
  const audit = validateVisibleClinicalBriefingText(bad);
  assertFalse(audit.ok);
});
