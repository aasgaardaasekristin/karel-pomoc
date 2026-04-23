/**
 * jungOriginalInjection.ts
 *
 * Centralized helper pro fetch + injekci Karlovy „minulé inkarnace" do
 * system promptu. Volaná z `karel-hana-chat` a `karel-chat` poté, co
 * `classifyJungRelevance` + `shouldActivateJungOriginal` rozhodnou, že
 * je to relevantní.
 *
 * Vrací string, který se rovnou prependuje / appenduje do system promptu.
 * Vrací prázdný string, pokud fetch selže nebo data jsou prázdná —
 * runtime pokračuje bez injekce, ne s chybou.
 */

import { KAREL_PAST_INCARNATION_GUARD } from "./karelIdentity.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PER_DOC_MAX = 2200; // chars — drží prompt pod kontrolou

interface JungOriginalPayload {
  character: string;
  memories: string;
  knowledge: string;
}

async function fetchJungOriginal(): Promise<JungOriginalPayload | null> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/karel-jung-original-fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      console.warn("[jung-injection] fetch failed:", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const data = await resp.json();
    if (!data?.ok) return null;
    return {
      character: String(data.character ?? ""),
      memories: String(data.memories ?? ""),
      knowledge: String(data.knowledge ?? ""),
    };
  } catch (e) {
    console.warn("[jung-injection] fetch error:", e);
    return null;
  }
}

function trim(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max).trim() + "\n\n[...zkráceno...]";
}

/**
 * Vrátí kompletní injection blok (anti-confusion guard + obsah 3 dokumentů).
 * Pokud Drive je prázdný nebo fetch selže, vrátí jen guard (aby Karel
 * minimálně věděl, jak se chovat, i bez konkrétních dat).
 */
export async function buildJungOriginalInjection(opts: {
  matched: string[];
  score: number;
}): Promise<string> {
  const payload = await fetchJungOriginal();

  const header = `═══ TVOJE MINULÁ INKARNACE — relevantní střípky ═══
(Aktivováno: matched=[${opts.matched.slice(0, 6).join(", ")}], score=${opts.score.toFixed(2)})

${KAREL_PAST_INCARNATION_GUARD}`;

  if (!payload || (!payload.character.trim() && !payload.memories.trim() && !payload.knowledge.trim())) {
    return `${header}

─── DATABÁZE ───
[PAMET_KAREL/ORIGINAL/ je zatím prázdná — spusť bootstrap v sekci Admin/Správa.
Pracuj s tématem podle obecné erudice, ale v rámci postoje "minulé inkarnace".]`;
  }

  const sections: string[] = [];
  if (payload.character.trim()) {
    sections.push(`─── CHARAKTER_JUNGA ───\n${trim(payload.character, PER_DOC_MAX)}`);
  }
  if (payload.memories.trim()) {
    sections.push(`─── VZPOMINKY_ZIVOT ───\n${trim(payload.memories, PER_DOC_MAX)}`);
  }
  if (payload.knowledge.trim()) {
    sections.push(`─── ZNALOSTI_DILA ───\n${trim(payload.knowledge, PER_DOC_MAX)}`);
  }

  return `${header}

${sections.join("\n\n")}`;
}
