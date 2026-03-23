import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { getSystemPrompt, ConversationMode } from "./systemPrompts.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, mode, didInitialContext, didSubMode, notebookProject, didPartName, didThreadLabel, didEnteredName, didContextPrimeCache } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // For kata submode, use dedicated kata prompt
    const effectiveMode = (mode === "childcare" && didSubMode === "kata") ? "kata" : mode;
    let systemPrompt = getSystemPrompt(effectiveMode as ConversationMode);

    // ═══ DID DYNAMIC CONTEXT PRIME ═══
    // If DID mode and we have a context-prime cache from frontend, inject it
    // This replaces the static didInitialContext with a rich, AI-synthesized situational cache
    if (mode === "childcare" && didContextPrimeCache && typeof didContextPrimeCache === "string" && didContextPrimeCache.length > 50) {
      systemPrompt += `\n\n═══ DYNAMICKÁ SITUAČNÍ CACHE (DID Context Prime) ═══\nToto je tvá aktuální předsunutá paměť – plastická mezipaměť vystavěná ze VŠECH zdrojů (Drive kartotéka, DB vlákna a epizody, sémantická paměť, úkoly terapeutek, internet). Využívej ji pro maximální přítomnost, adaptabilitu a informovanost.\n\n${didContextPrimeCache}`;
    }
    
    // Runtime context from UI (form snapshot, live supervision instructions, etc.) — fallback
    if (typeof didInitialContext === "string" && didInitialContext.trim().length > 0) {
      systemPrompt += `\n\n═══ RUNTIME KONTEXT Z APLIKACE (DOKUMENTY Z KARTOTÉKY DID) ═══\n\n${didInitialContext}`;
    }

    // DID-specific metadata
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode) {
      systemPrompt += `\n\n═══ AKTIVNÍ PODREŽIM ═══\nAktuální didSubMode: "${didSubMode}"`;

      // ═══ IDENTITA ČÁSTI — injekce do kontextu ═══
      if (didSubMode === "cast" && didPartName) {
        const label = didThreadLabel || didEnteredName || didPartName;
        systemPrompt += `\n\n═══ IDENTIFIKOVANÁ ČÁST (z registru) ═══\n⚠️ Tato část BYLA DETEKOVÁNA z registru PŘED zahájením hovoru. Karel VÍ kdo s ním mluví.\n• Kanonické jméno části: ${didPartName}\n• Část se představila jako: ${label}\n\nKRITICKÉ PRAVIDLO: NEPTEJ SE znovu „Jak ti říkají?" ani „Jsi Arthur?". Část již byla identifikována. Rovnou navazuj s plnou návazností z karty. Oslovuj část jménem „${label}".`;
        console.log(`[karel-chat] Part identity injected: canonical=${didPartName}, label=${label}`);
      }
    }

    // ═══ FAST-PATH: supervision & live-session ═══
    // Skip all heavy operations (Drive, Perplexity, tasks) for live modes
    if (mode === "supervision" || mode === "live-session") {
      const isLive = mode === "live-session";
      const fastModel = isLive ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview";
      console.log(`[karel-chat] Fast-path (${mode}): model=${fastModel}, skipping Drive/Perplexity/tasks`);

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: fastModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m: any) => Array.isArray(m.content) ? { role: m.role, content: m.content } : m),
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) return new Response(JSON.stringify({ error: "Rate limits exceeded" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        if (response.status === 402) return new Response(JSON.stringify({ error: "Payment required" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const text = await response.text();
        console.error(`AI gateway error (${mode}):`, response.status, text);
        return new Response(JSON.stringify({ error: "AI gateway error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // ═══ RUNTIME INJECTION: Pending therapist tasks + Karel's Insight + Dashboard deductions ═══
    if (mode === "childcare" && (didSubMode === "mamka" || didSubMode === "kata")) {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sb = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // ═══ DASHBOARD DEDUCTIONS INJECTION ═══
        // Read last Dashboard and Operative Plan from Drive to inject Karel's own deductions
        try {
          const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
          const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
          const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
          if (clientId && clientSecret && refreshToken) {
            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
            });
            const tokenData = await tokenRes.json();
            if (tokenData.access_token) {
              const driveToken = tokenData.access_token;
              // Find kartoteka_DID > 00_CENTRUM > Dashboard + Operative Plan
              const findFolder = async (name: string) => {
                const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const data = await res.json();
                return data.files?.[0]?.id || null;
              };
              const kartotekaId = await findFolder("kartoteka_DID") || await findFolder("Kartoteka_DID");
              if (kartotekaId) {
                const q2 = `'${kartotekaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const p2 = new URLSearchParams({ q: q2, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?${p2}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const d2 = await r2.json();
                const centrumFolder = (d2.files || []).find((f: any) => /^00/.test(f.name.trim()) || f.name.toLowerCase().includes("centrum"));
                if (centrumFolder) {
                  const q3 = `'${centrumFolder.id}' in parents and trashed=false`;
                  const p3 = new URLSearchParams({ q: q3, fields: "files(id,name,mimeType)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                  const r3 = await fetch(`https://www.googleapis.com/drive/v3/files?${p3}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                  const d3 = await r3.json();
                  const centrumFiles = d3.files || [];
                  
                  let dashboardContent = "";
                  let planContent = "";
                  
                  for (const cf of centrumFiles) {
                    const cn = cf.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    const isDashboard = cn.includes("dashboard");
                    const isPlan = (cn.includes("operativn") && cn.includes("plan")) || (cn.includes("terapeutick") && cn.includes("plan"));
                    if (!isDashboard && !isPlan) continue;
                    
                    try {
                      let content = "";
                      const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                      if (mediaRes.ok) {
                        content = await mediaRes.text();
                      } else {
                        const expRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                        if (expRes.ok) content = await expRes.text();
                      }
                      if (content.length > 100) {
                        if (isDashboard) dashboardContent = content.slice(0, 4000);
                        if (isPlan) planContent = content.slice(0, 3000);
                      }
                    } catch {}
                  }
                  
                  if (dashboardContent || planContent) {
                    systemPrompt += `\n\n═══ KARLOVY VLASTNÍ DEDUKCE A ZÁVĚRY (z posledního Dashboardu + Operativního plánu) ═══
⚠️ Toto jsou TVÉ VLASTNÍ analytické závěry, predikce a instrukce které jsi zapsal při posledním cyklu.
AKTIVNĚ s nimi pracuj: připomínej úkoly, ptej se na stav predikcí, ověřuj hypotézy, kontroluj plnění.
Neříkej "můj Dashboard říká" – prostě to VÍŠ a jednáš podle toho.

${dashboardContent ? `── DASHBOARD (tvůj radar) ──\n${dashboardContent}\n` : ""}
${planContent ? `── OPERATIVNÍ PLÁN (tvé instrukce) ──\n${planContent}` : ""}`;
                    console.log(`[karel-chat] Dashboard injected: ${dashboardContent.length}ch, Plan: ${planContent.length}ch`);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[karel-chat] Dashboard injection error (non-fatal):", e);
        }

        // Load tasks
        const { data: tasks } = await sb.from("did_therapist_tasks")
          .select("task, assigned_to, status_hanka, status_kata, priority, due_date, created_at, category, escalation_level")
          .neq("status", "done")
          .order("priority", { ascending: false });

        // Load part registry for dormancy context
        const { data: partRegistryData } = await sb.from("did_part_registry")
          .select("part_name, status, last_seen_at");
        
        if (partRegistryData && partRegistryData.length > 0) {
          const sleepingParts = partRegistryData.filter((p: any) => p.status === "sleeping" || p.status === "dormant");
          const activeParts = partRegistryData.filter((p: any) => p.status === "active" || p.status === "aktivní");
          if (sleepingParts.length > 0) {
            systemPrompt += `\n\n═══ REGISTR ČÁSTÍ – DORMANCY GUARD ═══\nAKTIVNÍ části (lze s nimi přímo pracovat): ${activeParts.map((p: any) => p.part_name).join(", ") || "žádné"}\nSPÍCÍ/DORMANTNÍ části (NELZE zadávat přímé úkoly): ${sleepingParts.map((p: any) => p.part_name).join(", ")}\n⚠️ Pro spící části navrhuj POUZE: monitorování, vizualizace, přípravné kroky. NIKDY přímou práci.`;
          }
        }

        // Load motivation profiles
        const { data: profiles } = await sb.from("did_motivation_profiles").select("*");

        const therapist = didSubMode === "mamka" ? "Hanka" : "Káťa";
        const profile = profiles?.find((p: any) => p.therapist === therapist);

        if (tasks && tasks.length > 0) {
          const taskList = tasks.map((t: any) => {
            const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
            const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️ ESKALACE L${t.escalation_level}` : "";
            return `- [${t.priority}${esc}] ${t.task} (pro: ${t.assigned_to}, H: ${t.status_hanka}, K: ${t.status_kata}${t.due_date ? `, termín: ${t.due_date}` : ""}, ${age}d)`;
          }).join("\n");

          // Build insight context
          let insightBlock = "";
          if (profile) {
            const ratio = profile.tasks_completed / Math.max(1, profile.tasks_completed + profile.tasks_missed);
            const avgDays = Number(profile.avg_completion_days || 0);
            insightBlock += `\n\n═══ KARLŮV POSTŘEH (proaktivní insight) ═══`;
            insightBlock += `\nMotivační profil ${therapist}: splněno ${profile.tasks_completed}, nesplněno ${profile.tasks_missed} (${Math.round(ratio*100)}%), průměr ${avgDays.toFixed(1)}d, série ${profile.streak_current}`;
            insightBlock += `\nPreferovaný styl: ${profile.preferred_style}`;

            // Pattern analysis
            const escalated = tasks.filter((t: any) => (t.escalation_level || 0) >= 2);
            const oldTasks = tasks.filter((t: any) => {
              const age = (Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24);
              return age > 5;
            });

            if (escalated.length > 0) {
              insightBlock += `\n⚠️ ${escalated.length} úkolů dosáhlo eskalace level 2+. Karel by měl laskavě ale důsledně upozornit.`;
            }
            if (oldTasks.length >= 3) {
              insightBlock += `\n⚠️ ${oldTasks.length} úkolů je starších 5 dní. Karel navrhne "rychlou poradu" o prioritách.`;
            }
            if (profile.streak_current >= 3) {
              insightBlock += `\n🌟 ${therapist} má sérii ${profile.streak_current} splněných úkolů! Karel pochválí a povzbudí.`;
            }
            if (avgDays > 4 && profile.preferred_style === "deadline") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na konkrétní termíny — zahrne je do doporučení.`;
            }
            if (profile.preferred_style === "praise") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na pochvaly — začne pozitivním hodnocením.`;
            }
          }

          systemPrompt += `\n\n═══ AKTUÁLNÍ NESPLNĚNÉ ÚKOLY ═══\nKarel, na začátku rozhovoru se ZEPTEJ ${therapist === "Hanka" ? "Haničky" : "Káti"} na stav těchto úkolů:\n${taskList}\n\nPokud je úkol starší 4 dní a nesplněný, Karel laskavě ale důsledně upozorní a navrhne řešení. Pokud více úkolů pokulhává, Karel navrhne "poradu" – strukturované sezení o strategii.${insightBlock}`;
        }
        // ═══ SMART ACTIVITY RECOMMENDER — talent-based suggestions from didInitialContext ═══
        try {
          // Extract TALENT lines from didInitialContext (Section H data injected by Auto-Prep or enrichment)
          const contextToScan = didInitialContext || "";
          const talentRegex = /TALENT:\s*([^|]+)\|\s*ÚROVEŇ:\s*([^|]+)\|\s*AKTIVITA:\s*([^|]+)/gi;
          const talents: Array<{ area: string; level: string; activity: string; partName?: string }> = [];
          
          // Also try simpler patterns
          const talentMatches = [...contextToScan.matchAll(talentRegex)];
          for (const m of talentMatches) {
            talents.push({
              area: m[1].trim(),
              level: m[2].trim(),
              activity: m[3].trim(),
            });
          }

          // Extract part-talent associations from card context
          const cardSectionH = contextToScan.match(/SEKCE H[^]*?(?=SEKCE [I-M]|$)/gi);
          if (cardSectionH) {
            for (const section of cardSectionH) {
              const partMatch = contextToScan.match(new RegExp(`KARTA\\s+[ČC]ÁSTI:\\s*([^\\n]+)`, "i"));
              const partName = partMatch?.[1]?.trim() || "";
              const simpleTalents = section.match(/(?:talent|schopnost|zájem|nadání)[:\s]+([^\n,]+)/gi);
              if (simpleTalents) {
                for (const st of simpleTalents) {
                  const area = st.replace(/^(?:talent|schopnost|zájem|nadání)[:\s]+/i, "").trim();
                  if (area.length > 2 && !talents.some(t => t.area.toLowerCase() === area.toLowerCase())) {
                    talents.push({ area, level: "nespecifikováno", activity: "doporučit", partName });
                  }
                }
              }
            }
          }

          if (talents.length > 0) {
            const talentBlock = talents.slice(0, 8).map(t =>
              `• ${t.partName ? `[${t.partName}] ` : ""}${t.area} (${t.level}) → doporučená aktivita: ${t.activity}`
            ).join("\n");
            
            systemPrompt += `\n\n═══ PERSONALIZOVANÁ DOPORUČENÍ (Smart Activity Recommender) ═══
Karel zná tyto talenty a zájmy částí:
${talentBlock}

INSTRUKCE: Když se rozhovor týká konkrétní části s identifikovaným talentem, Karel PROAKTIVNĚ navrhne rozvíjející aktivitu na míru. Například:
- Část se zájmem o fyziku → navrhni experiment, hádanku, edukační hru
- Část se zájmem o hudbu → navrhni rytmické cvičení, poslech, jednoduchou kompozici
- Část se zájmem o kreslení → navrhni art-therapy aktivitu na míru tématu
Karel doporučení přirozeně začlení do rozhovoru, ne jako seznam.`;
          }
        } catch (e) {
          console.warn("Smart Activity Recommender error (non-fatal):", e);
        }

      } catch (e) {
        console.warn("Task/insight injection error (non-fatal):", e);
      }
    }

    // ═══ LANGUAGE ADAPTATION for "cast" mode ═══
    // Detect language of last user message and enforce matching response language
    let detectedLang = "";
    if (didSubMode === "cast" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
      if (lastUserText.length > 0) {
        const hasCyrillic = /[\u0400-\u04FF]/.test(lastUserText);
        const hasNordic = /[æøåÆØÅ]/.test(lastUserText);
        const hasArabic = /[\u0600-\u06FF]/.test(lastUserText);
        const hasChinese = /[\u4e00-\u9fff]/.test(lastUserText);
        
        // More aggressive detection with more keywords
        const looksEnglish = /\b(the|is|are|was|were|have|has|had|my|your|this|that|what|how|why|do|don't|doesn't|I'm|I am|you|hello|hi|please|thank|want|need|feel|think|know|like|can|will|would|should|could|come|go|see|look|tell|say|said|because|but|and|or|not|no|yes|okay|ok|hey|sorry|help|name|where|when|who)\b/i.test(lastUserText);
        const looksGerman = /\b(ich|bin|ist|das|die|der|und|nicht|ein|eine|haben|sein|mir|mich|wie|was|warum|hallo|bitte|danke|gut|schlecht|ja|nein|kann|will|muss|soll|hier|dort|heute|morgen|gehen|kommen|sagen|machen)\b/i.test(lastUserText);
        const looksNorwegian = /\b(jeg|er|det|og|ikke|har|vil|kan|med|fra|hei|takk|hva|hvorfor|fordi|meg|deg|han|hun|den|denne|skal|må|bli|være|gå|komme|si|gjøre|snakke|forstå)\b/i.test(lastUserText);
        const looksSpanish = /\b(yo|es|el|la|los|las|un|una|que|por|para|con|hola|gracias|sí|no|tengo|quiero|puedo|estoy|como|donde|cuando|pero|también|muy|bien|mal)\b/i.test(lastUserText);
        const looksFrench = /\b(je|suis|est|le|la|les|un|une|que|pour|avec|bonjour|merci|oui|non|ai|veux|peux|comme|où|quand|mais|aussi|très|bien|mal)\b/i.test(lastUserText);
        const looksCzech = /\b(jsem|jsi|je|jsou|mám|máš|co|jak|proč|kde|kdy|ale|že|to|ta|ten|se|si|na|do|od|za|při|pro|bez|nad|pod|před|jen|mě|tě|mu|ho|ji|nám|vám|jim|být|mít|dělat|říct|vědět|chtít|moci|smět|muset)\b/i.test(lastUserText);
        
        if (hasNordic || looksNorwegian) detectedLang = "Norwegian";
        else if (hasChinese) detectedLang = "Chinese";
        else if (hasArabic) detectedLang = "Arabic";
        else if (hasCyrillic) detectedLang = "Russian/Cyrillic";
        else if (looksSpanish && !looksCzech) detectedLang = "Spanish";
        else if (looksFrench && !looksCzech) detectedLang = "French";
        else if (looksGerman && !looksCzech) detectedLang = "German";
        else if (looksEnglish && !looksCzech) detectedLang = "English";
        
        if (detectedLang) {
          // Prepend the language instruction to the BEGINNING of system prompt for maximum impact
          systemPrompt = `⚠️⚠️⚠️ MANDATORY LANGUAGE RULE ⚠️⚠️⚠️
YOU MUST RESPOND IN ${detectedLang.toUpperCase()}. 
The child/part is speaking ${detectedLang}. You MUST answer in ${detectedLang}. 
DO NOT respond in Czech. DO NOT mix languages. 
Every single word of your response must be in ${detectedLang}.
This overrides ALL other language instructions.
⚠️⚠️⚠️ END MANDATORY LANGUAGE RULE ⚠️⚠️⚠️

` + systemPrompt;
        }
      }
    }

    // Hard runtime truth-guard for DID mode
    if (mode === "childcare") {
      systemPrompt += `\n\n═══ KRITICKÁ PRAVIDLA PRAVDIVOSTI ═══\n- Pro okamžité odeslání vzkazu používej VÝHRADNĚ značku [ODESLAT_VZKAZ:mamka] nebo [ODESLAT_VZKAZ:kata].\n- Značku vlož AŽ PO výslovném souhlasu části.\n- Bez souhlasu pouze navrhni text a označ ho jako NÁVRH.\n- Po vložení značky řekni části že se vzkaz posílá – systém ho odešle automaticky emailem.\n- V DID režimu považuj část za AKTIVNÍ pouze tehdy, když sama přímo mluví ve vláknu sub_mode=cast; pouhá zmínka terapeutkou nebo v jiném režimu NENÍ aktivita části.\n- Aliasy Dymi/Dymytri/Dymitri vždy mapuj na jediný kanonický název DMYTRI. Pokud DMYTRI není aktivní v registru, nechovej se k němu jako k aktivní části.\n- Nikdy nevytvářej nové názvy částí z čárek, stavových slov nebo testovacích textů typu „Aktivní“.`;
    }

    // ═══ AUTO-PERPLEXITY FOR KATA MODE ═══
    // When Káťa asks about complex situations, automatically search for research
    let perplexityContext = "";
    if (effectiveMode === "kata" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";

      if (lastUserText.length > 15) {
        // Step 1: Quick complexity classification (non-streaming)
        try {
          const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                {
                  role: "system",
                  content: `Jsi klasifikátor složitosti dotazů v kontextu DID (disociativní porucha identity) terapie.
Odpověz POUZE jedním slovem: "simple", "medium" nebo "complex".

COMPLEX = nová/neznámá situace, selhání předchozích strategií, neobvyklé chování části, krizová situace, žádost o strategické sezení, specifická terapeutická technika, probouzení spící části, neznámý trigger.
MEDIUM = konkrétní dotaz na práci s částí, plánování aktivity, žádost o postup.
SIMPLE = obecný dotaz, pozdrav, potvrzení, krátká otázka.`,
                },
                { role: "user", content: lastUserText },
              ],
            }),
          });

          if (classifyResponse.ok) {
            const classifyData = await classifyResponse.json();
            const complexity = (classifyData.choices?.[0]?.message?.content || "").trim().toLowerCase();
            console.log("Kata complexity classification:", complexity, "for:", lastUserText.slice(0, 80));

            // Step 2: If complex or medium, call Perplexity
            if (complexity.includes("complex") || complexity.includes("medium")) {
              const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
              if (PERPLEXITY_API_KEY) {
                try {
                  // Extract part name from context or message
                  const partNameMatch = lastUserText.match(/(?:s|o|pro|na)\s+(\w+(?:em|kem|ou|kou|ím|em)?)/i);
                  const enrichedQuery = `DID terapie dětí: ${lastUserText.slice(0, 200)}. Terapeutické techniky, hry, strategie, desenzibilizace, grounding, attachment.`;

                  const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: "sonar",
                      messages: [
                        {
                          role: "system",
                          content: `Vyhledej odborné zdroje o DID (disociativní porucha identity) u dětí relevantní k dotazu. Zaměř se na:
- Konkrétní terapeutické techniky a metody (IFS, EMDR, sensomotorická terapie, hrová terapie)
- Praktické aktivity a hry pro práci s částmi/altery
- Stabilizační a grounding techniky přizpůsobené dětem
- Attachment-based intervence
Odpověz v češtině. Buď stručný a praktický. Max 500 slov.`,
                        },
                        { role: "user", content: enrichedQuery },
                      ],
                      search_recency_filter: "year",
                    }),
                  });

                  if (perplexityResponse.ok) {
                    const perplexityData = await perplexityResponse.json();
                    const searchResults = perplexityData.choices?.[0]?.message?.content || "";
                    const citations = perplexityData.citations || [];
                    if (searchResults) {
                      perplexityContext = `\n\n═══ AUTOMATICKÁ REŠERŠE (Perplexity – relevantní výzkumy a metody) ═══\n${searchResults}`;
                      if (citations.length > 0) {
                        perplexityContext += `\n\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}`;
                      }
                      perplexityContext += `\n\n═══ INSTRUKCE: Výše uvedené výsledky rešerše VČLEŇ do své odpovědi Káťě. Cituj pouze zdroje z rešerše. Navrhni konkrétní techniky/hry na základě nalezených metod. ═══`;
                      console.log("Perplexity auto-research added for kata mode, length:", perplexityContext.length);
                    }
                  } else {
                    console.warn("Perplexity call failed:", perplexityResponse.status);
                  }
                } catch (e) {
                  console.warn("Perplexity auto-research error:", e);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Complexity classification error:", e);
        }
      }
    }

    // Append Perplexity context to system prompt if available
    if (perplexityContext) {
      systemPrompt += perplexityContext;
    }

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
          ...messages.map((m: any) => {
            // Pass through multimodal content arrays as-is (OpenAI vision format)
            if (Array.isArray(m.content)) {
              return { role: m.role, content: m.content };
            }
            return m;
          }),
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
