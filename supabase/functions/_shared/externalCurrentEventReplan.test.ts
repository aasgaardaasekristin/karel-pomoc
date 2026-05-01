import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExternalCurrentEvent,
  buildSafeSessionDraft,
  buildSafePlayroomDraft,
  buildTruthfulKarelInlineComment,
  inlineCommentHasAuditLanguage,
} from "./externalCurrentEventReplan.ts";

Deno.test("classifies Hana's urgent Timmy update as external_current_event_update", () => {
  const text = "dnes je situace extrémně vypjatá. velrybu Timmy vypouští z barge dříve než slibovali, vypadá to, že je velryba ohrožena, a záchranáři nedodrželi slovo. Kluci jsou samozřejmě ovlivněni negativně touto událostí. Veškerý program navrhuji pozměnit a upravit výhradně na toto. Doporučuji abys našel na internetu poslední ověřené zprávy a sestavil program jak v sezení tak i v herně přímo na míru v souladu s touto situací.";
  const c = classifyExternalCurrentEvent(text);
  assertEquals(c.is_external_current_event, true);
  assertEquals(c.requires_replan, true);
  assertEquals(c.requires_web_verification, true);
  assertEquals(c.affects_session, true);
  assertEquals(c.affects_playroom, true);
  assertEquals(c.urgency, "high");
  assertEquals((c.event_label ?? "").toLowerCase().startsWith("velryb") || c.event_label === "Timmy" || c.event_label === "timmy", true);
});

Deno.test("does not trigger on benign mention", () => {
  const c = classifyExternalCurrentEvent("Mám dobrou náladu, prosím přidej pět minut na úvod.");
  assertEquals(c.is_external_current_event, false);
  assertEquals(c.requires_replan, false);
});

Deno.test("safe drafts mention body, safety, and event noun", () => {
  const session = buildSafeSessionDraft("Timmy");
  const playroom = buildSafePlayroomDraft("Timmy");
  const sJoined = JSON.stringify(session);
  const pJoined = JSON.stringify(playroom);
  assertEquals(sJoined.includes("tělo") || sJoined.includes("těle"), true);
  assertEquals(sJoined.includes("bezpeč"), true);
  assertEquals(sJoined.includes("Timmy"), true);
  assertEquals(pJoined.includes("Timmy"), true);
  // No symbol/projection language
  assertEquals(/symboliz|projek|nakresli\s+timmy/i.test(sJoined), false);
  assertEquals(/symboliz|projek|nakresli\s+timmy/i.test(pJoined), false);
});

Deno.test("inline comment is truthful when no web tool available", () => {
  const c = buildTruthfulKarelInlineComment({
    authorLabel: "Hanička",
    eventLabel: "Timmy",
    webVerificationAvailable: false,
    affectedDeliberationCount: 2,
  });
  assertEquals(c.includes("Hanička"), true);
  assertEquals(c.includes("Timmy"), true);
  assertEquals(/našel jsem na internetu|podle posledních zpráv|ověřil jsem/i.test(c), false);
  assertEquals(c.toLowerCase().includes("nemám teď v aplikaci"), true);
});

Deno.test("inline comment audit guard catches forbidden terms", () => {
  assertEquals(inlineCommentHasAuditLanguage("Zapsal jsem to do Pantry B a Pipeline ho zpracuje.").ok, false);
  assertEquals(inlineCommentHasAuditLanguage("Hanička, beru to jako urgentní změnu reality.").ok, true);
});
