import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const conversationText = messages
      .map((m: { role: string; content: string }) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${content}`;
      })
      .join("\n\n");

    const systemPrompt = `Jsi Karel – supervizní mentor a pedagog. Tvým úkolem je vytvořit UČEBNÍ MATERIÁL z proběhlého supervizního rozhovoru.

═══ CO MÁŠ UDĚLAT ═══

Projdi celý rozhovor a vytvoř strukturovaný studijní materiál v češtině, který pomůže terapeutce profesně růst.

═══ STRUKTURA MATERIÁLU (Markdown) ═══

# 📚 Studijní materiál ze supervize
*Datum: [dnešní datum]*

---

## 🔑 Klíčové pojmy a koncepty

Pro KAŽDÝ odborný pojem/koncept, který se v rozhovoru objevil:

### [Název pojmu]
**Definice:** Stručné, srozumitelné vysvětlení pojmu.
**Jak byl použit v supervizi:** Konkrétní kontext, ve kterém se pojem objevil.
**Klinický význam:** Proč je tento pojem důležitý pro praxi.

Příklady pojmů: archetyp zraněného dítěte, projektivní identifikace, symbióza, individuace, přenos, protipřenos, narcistické zranění, vnitřní dítě, stínový materiál, separační úzkost, holding environment, kontejnování, mentalizace, attachmentové vzorce, disociace, retraumatizace, atd.

---

## 🛠️ Techniky a metody

Pro KAŽDOU techniku/metodu zmíněnou v rozhovoru:

### [Název techniky]
**Co to je:** Stručný popis techniky.
**Kdy se používá:** V jakých situacích je indikována.
**Jak se provádí:** Praktický postup (stručně).
**Kontraindikace:** Kdy techniku NEPOUŽÍVAT (pokud relevantní).

---

## 💡 Supervizní postřehy

Klíčové myšlenky a doporučení, které Karel v rozhovoru nabídl:
- (3-5 bodů, konkrétních a praktických)

---

## 📋 K zapamatování

Shrnutí nejdůležitějších poznatků v bodech – to, co si má terapeutka odnést a zapamatovat.

---

## 📖 Doporučená literatura

Pokud se v rozhovoru zmínily konkrétní knihy, autoři nebo školy, uveď je zde s krátkým popisem.

═══ ZÁSADY ═══
- Piš SROZUMITELNĚ – jako dobrý učitel, ne jako encyklopedie.
- Zachovej hloubku, ale buď přístupná.
- Pokud Karel v rozhovoru něco vysvětlil hezky, zachovej ten styl.
- NEVYMÝŠLEJ pojmy, které v rozhovoru nebyly – extrahuj JEN to, co se skutečně probíralo.
- Techniky popisuj prakticky – jak se dělají, ne jen co to je.
- Pokud se v rozhovoru objevily metafory nebo příklady, zachovej je – pomáhají zapamatování.
- Formátuj v Markdown s emojis pro přehlednost.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Vytvoř učební materiál z tohoto supervizního rozhovoru:\n\n${conversationText}` },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const material = data.choices?.[0]?.message?.content;

    if (!material) throw new Error("Empty response from AI");

    return new Response(JSON.stringify({ material }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Study material error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
