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

    // ═══ DID DAILY CONTEXT INJECTION ═══
    // Load structured daily profile from did_daily_context (built by karel-daily-refresh)
    if (mode === "childcare" || effectiveMode === "kata") {
      try {
        const { createClient: createSbClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbDaily = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        
        // Get user_id from auth
        let dailyUserId: string | null = null;
        const dailyAuthHeader = req.headers.get("Authorization");
        if (dailyAuthHeader?.startsWith("Bearer ")) {
          const userSb = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
            global: { headers: { Authorization: dailyAuthHeader } },
          });
          const { data: { user } } = await userSb.auth.getUser();
          dailyUserId = user?.id || null;
        }
        
        if (dailyUserId) {
          const { data: dailyCtx } = await sbDaily.from("did_daily_context")
            .select("context_json, context_date, updated_at")
            .eq("user_id", dailyUserId)
            .order("context_date", { ascending: false })
            .limit(1)
            .single();
          
          if (dailyCtx?.context_json) {
            const ctx = dailyCtx.context_json as any;
            
            // Build structured text block from JSON
            const therapistBlock = ctx.therapists ? `
PROFIL TERAPEUTEK:
• Hanka: ${ctx.therapists.hanka?.note || "první terapeutka"}
• Káťa: ${ctx.therapists.kata?.note || "druhá terapeutka"} ⚠️ NIKDY NENÍ ČÁST DID SYSTÉMU` : "";

            const activePartsBlock = ctx.parts?.active?.length ? `
AKTIVNÍ ČÁSTI (${ctx.parts.active.length}):
${ctx.parts.active.map((p: any) => `• ${p.display_name || p.name} – klastr: ${p.cluster || "?"}, věk: ${p.age || "?"}, emoce: ${p.emotional_state || "?"} (${p.emotional_intensity || "?"}/10), zdraví: ${p.health || "?"}`).join("\n")}` : "";

            const sleepingBlock = ctx.parts?.sleeping?.length ? `
SPÍCÍ/DORMANTNÍ ČÁSTI (${ctx.parts.sleeping.length}): ${ctx.parts.sleeping.map((p: any) => p.display_name || p.name).join(", ")}
⚠️ NELZE s nimi přímo pracovat – pouze monitoring` : "";

            const activityBlock = ctx.recent_activity ? `
KLASIFIKACE AKTIVITY:
  PŘÍMÁ AKTIVITA (sub_mode=cast): ${ctx.recent_activity.direct_activity?.map((a: any) => `${a.part} (${a.at?.slice(0, 10)})`).join(", ") || "žádná"}
  ZMÍNKY TERAPEUTEK: ${ctx.recent_activity.therapist_mentions?.map((a: any) => `${a.part} zmíněn/a ${a.mentioned_by}`).join(", ") || "žádné"}` : "";

            const tasksBlock = ctx.pending_tasks?.length ? `
NESPLNĚNÉ ÚKOLY (${ctx.pending_tasks.length}):
${ctx.pending_tasks.slice(0, 8).map((t: any) => `• [${t.priority}${t.escalation >= 2 ? " ⚠️ESK" : ""}] ${t.task} (${t.assigned_to}, ${t.age_days}d)`).join("\n")}` : "";

            const driveBlock = [
              ctx.drive_documents?.dashboard ? `DASHBOARD: ${ctx.drive_documents.dashboard.slice(0, 1500)}` : null,
              ctx.drive_documents?.operativni_plan ? `OPERATIVNÍ PLÁN: ${ctx.drive_documents.operativni_plan.slice(0, 1500)}` : null,
              ctx.drive_documents?.strategicky_vyhled ? `STRATEGICKÝ VÝHLED: ${ctx.drive_documents.strategicky_vyhled.slice(0, 1000)}` : null,
              ctx.drive_documents?.pamet_karel ? `PAMĚŤ KARLA: ${ctx.drive_documents.pamet_karel.slice(0, 1000)}` : null,
            ].filter(Boolean).join("\n\n");

            systemPrompt += `\n\n═══ KARLŮV DENNÍ PROFIL (z did_daily_context, ${dailyCtx.context_date}) ═══
Vygenerováno: ${ctx.generated_at || dailyCtx.updated_at}
Toto je tvá STRUKTUROVANÁ PAMĚŤ na dnešní den. Pracuj s ní AKTIVNĚ.
${therapistBlock}
${activePartsBlock}
${sleepingBlock}
${activityBlock}
${tasksBlock}

═══ DOKUMENTY Z DRIVE ═══
${driveBlock || "(Drive dokumenty nebyly načteny)"}
═══ KONEC DENNÍHO PROFILU ═══`;

            console.log(`[karel-chat] Daily context injected: date=${dailyCtx.context_date}, size=${JSON.stringify(ctx).length}ch`);
          } else {
            console.log("[karel-chat] No daily context found in did_daily_context");
          }
        }
      } catch (e) {
        console.warn("[karel-chat] Daily context injection error (non-fatal):", e);
      }
    }

    // ═══ DID DYNAMIC CONTEXT PRIME ═══
    // If DID mode and we have a context-prime cache from frontend, inject it
    // This replaces the static didInitialContext with a rich, AI-synthesized situational cache
    console.log('[debug-profiling] Cache length:', didContextPrimeCache?.length || 0);
    console.log('[debug-profiling] Cache preview:', didContextPrimeCache?.slice(0, 800));
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

    // ═══ ASYNC TASK EXTRACTION (non-blocking) ═══
    // Collect streamed response and extract tasks after sending
    const [streamForClient, streamForExtract] = response.body!.tee();

    // Fire-and-forget task extraction
    (async () => {
      try {
        const reader = streamForExtract.getReader();
        const decoder = new TextDecoder();
        let fullResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE data lines
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content || "";
                fullResponse += delta;
              } catch {}
            }
          }
        }

        if (fullResponse.length > 20 && (mode === "childcare" || effectiveMode === "kata")) {
          const extractedTasks = extractTasksFromResponse(fullResponse, didSubMode || "general");
          if (extractedTasks.length > 0) {
            const { createClient: createSbForTasks } = await import("https://esm.sh/@supabase/supabase-js@2");
            const sbTasks = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
            
            // Get user_id
            let taskUserId: string | null = null;
            const taskAuth = req.headers.get("Authorization");
            if (taskAuth?.startsWith("Bearer ")) {
              const userSbT = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: taskAuth } },
              });
              const { data: { user } } = await userSbT.auth.getUser();
              taskUserId = user?.id || null;
            }

            if (taskUserId) {
              const rows = extractedTasks.map(t => ({ ...t, user_id: taskUserId }));
              const { error: insErr } = await sbTasks.from("did_tasks").insert(rows);
              if (insErr) console.warn("[task-extract] Insert error:", insErr.message);
              else console.log(`[task-extract] Saved ${rows.length} tasks from chat response`);
            }
          }
        }

        // ═══ ASYNC CRISIS DETECTOR (non-blocking) ═══
        // Runs for every "cast" message — detects crisis signals in conversation
        if (didSubMode === "cast" && fullResponse.length > 10) {
          try {
            // Build last 6-10 messages for analysis
            const recentMessages = (messages as any[]).slice(-10).map((m: any) => {
              const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
              return `${m.role === "user" ? (didPartName || "Část") : "Karel"}: ${content}`;
            });
            // Add Karel's latest response
            recentMessages.push(`Karel: ${fullResponse.slice(0, 2000)}`);
            const conversationExcerpt = recentMessages.join("\n\n");

            const crisisDetectResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
                    content: `Jsi krizový detektor. Analyzuješ konverzaci mezi terapeutem (Karel) a klientem (část osobnosti).

Tvůj JEDINÝ úkol: rozhodnout, zda klient vykazuje známky krize.

Krizové signály (stačí JEDEN):
- Pláč, slzy, emoční kolaps
- "Jsem v nebezpečí" (vnitřním nebo vnějším)
- Zmínka o útoku (verbálním nebo fyzickém) od kohokoli
- Vyhrožování, nátlak, vydírání (od kohokoli)
- Bezmoc ("nemám jak se bránit", "nemůžu nic dělat")
- Opuštěnost ("nikdo mi nepomůže", "nikdo nemá čas")
- Sebepoškození nebo suicidální myšlenky (jakákoli zmínka)
- Manipulace nebo zneužití (včetně finančního)
- Extrémní strach nebo úzkost
- Zmínka o konkrétní osobě která ubližuje

Odpověz POUZE platným JSON objektem, nic jiného:

Pokud NENÍ krize:
{"crisis": false}

Pokud JE krize:
{
  "crisis": true,
  "severity": "HIGH" nebo "CRITICAL",
  "signals": ["seznam", "detekovaných", "signálů"],
  "summary": "2-3 věty co se děje",
  "assessment": "Karlovo vyhodnocení rizika a situace",
  "intervention_plan": "Co by měli terapeuti okamžitě udělat"
}

CRITICAL = přímé ohrožení (sebepoškození, suicidální myšlenky, fyzické násilí, akutní nebezpečí)
HIGH = závažný distres bez přímého ohrožení života`,
                  },
                  { role: "user", content: conversationExcerpt },
                ],
              }),
            });

            if (crisisDetectResponse.ok) {
              const crisisData = await crisisDetectResponse.json();
              const crisisText = (crisisData.choices?.[0]?.message?.content || "").trim();
              // Strip markdown fences if present
              const cleanJson = crisisText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
              
              let crisisResult: any;
              try {
                crisisResult = JSON.parse(cleanJson);
              } catch {
                console.warn("[crisis-detector] Failed to parse response:", crisisText.slice(0, 200));
                crisisResult = { crisis: false };
              }

              if (crisisResult.crisis === true) {
                console.log(`[crisis-detector] 🚨 CRISIS DETECTED for ${didPartName || "unknown"}: severity=${crisisResult.severity}`);
                
                const { createClient: createSbCrisis } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sbCrisis = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

                const partName = didPartName || "Neznámá část";

                // Check for existing ACTIVE alert for this conversation
                // Use part_name as fallback grouping if no conversation_id
                const { data: existingAlerts } = await sbCrisis.from("crisis_alerts")
                  .select("id")
                  .eq("status", "ACTIVE")
                  .eq("part_name", partName)
                  .limit(1);

                if (existingAlerts && existingAlerts.length > 0) {
                  // UPDATE existing alert
                  const { error: updErr } = await sbCrisis.from("crisis_alerts")
                    .update({
                      summary: crisisResult.summary || "Aktualizovaná krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                      severity: crisisResult.severity || "HIGH",
                    })
                    .eq("id", existingAlerts[0].id);
                  if (updErr) console.warn("[crisis-detector] Update error:", updErr.message);
                  else console.log(`[crisis-detector] Updated existing alert ${existingAlerts[0].id}`);
                } else {
                  // INSERT new alert
                  const { data: newAlert, error: insErr } = await sbCrisis.from("crisis_alerts")
                    .insert({
                      part_name: partName,
                      severity: crisisResult.severity || "HIGH",
                      summary: crisisResult.summary || "Detekována krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                    })
                    .select("id")
                    .single();

                  if (insErr) {
                    console.error("[crisis-detector] Insert alert error:", insErr.message);
                  } else if (newAlert) {
                    console.log(`[crisis-detector] Created alert ${newAlert.id}, creating tasks + thread...`);
                    
                    // INSERT two crisis tasks
                    const { error: taskErr } = await sbCrisis.from("crisis_tasks").insert([
                      {
                        crisis_alert_id: newAlert.id,
                        title: `KRIZOVÁ INTERVENCE – ${partName}`,
                        description: `Okamžitě kontaktovat ${partName}. ${crisisResult.summary || ""}`,
                        assigned_to: "hanicka",
                        priority: "CRITICAL",
                      },
                      {
                        crisis_alert_id: newAlert.id,
                        title: `KRIZOVÁ INTERVENCE – podpora – ${partName}`,
                        description: `Podpořit Haničku v krizové intervenci. ${crisisResult.summary || ""}`,
                        assigned_to: "kata",
                        priority: "CRITICAL",
                      },
                    ]);
                    if (taskErr) console.error("[crisis-detector] Insert tasks error:", taskErr.message);
                    else console.log(`[crisis-detector] Created 2 crisis tasks for alert ${newAlert.id}`);

                    // ═══ CREATE CRISIS THREAD (krizová porada) ═══
                    try {
                      const now = new Date();
                      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
                      const timeStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
                      const signalsList = (crisisResult.signals || []).map((s: string) => `  • ${s}`).join("\n");

                      const karelFirstMessage = `⚠️ KRIZOVÁ INTERVENCE – AKTIVOVÁNO

Část: ${partName}
Čas detekce: ${dateStr} ${timeStr}
Úroveň rizika: ${crisisResult.severity || "HIGH"}

CO SE STALO:
${crisisResult.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

KLÍČOVÉ ÚRYVKY Z ROZHOVORU:
${conversationExcerpt.slice(0, 3000)}

MOJE VYHODNOCENÍ:
${crisisResult.assessment || "Vyhodnocení není k dispozici."}

NAVRŽENÝ PLÁN OKAMŽITÉ INTERVENCE:
${crisisResult.intervention_plan || "Plán není k dispozici."}

---

Haničko, Káťo – potřebuji vás okamžitě.
Připojte se do tohoto vlákna. Situace vyžaduje koordinovaný zásah.
Dokud se nepřipojíte, pokračuji ve stabilizaci ${partName} v probíhajícím rozhovoru.
Čekám na vaše instrukce.`;

                      // Get user_id for the thread
                      let crisisUserId: string | null = null;
                      const crisisAuth = req.headers.get("Authorization");
                      if (crisisAuth?.startsWith("Bearer ")) {
                        const userSbCr = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                          global: { headers: { Authorization: crisisAuth } },
                        });
                        const { data: { user: crUser } } = await userSbCr.auth.getUser();
                        crisisUserId = crUser?.id || null;
                      }

                      if (crisisUserId) {
                        const threadLabel = `🔴 KRIZOVÁ INTERVENCE – ${partName} – ${dateStr}`;
                        const { data: newThread, error: threadErr } = await sbCrisis.from("did_conversations")
                          .insert({
                            user_id: crisisUserId,
                            session_id: `crisis-${newAlert.id}`,
                            sub_mode: "crisis",
                            label: threadLabel,
                            preview: `⚠️ Krize: ${(crisisResult.summary || "").slice(0, 100)}`,
                            messages: JSON.stringify([
                              { role: "assistant", content: karelFirstMessage, timestamp: now.toISOString() }
                            ]),
                            did_initial_context: `KRIZOVÉ VLÁKNO pro alert ${newAlert.id}. Část: ${partName}. Severity: ${crisisResult.severity}.`,
                          })
                          .select("id")
                          .single();

                        if (threadErr) {
                          console.error("[crisis-detector] Create thread error:", threadErr.message);
                        } else if (newThread) {
                          // Link thread to alert
                          await sbCrisis.from("crisis_alerts")
                            .update({ crisis_thread_id: newThread.id })
                            .eq("id", newAlert.id);
                          console.log(`[crisis-detector] Created crisis thread ${newThread.id} for alert ${newAlert.id}`);
                        }
                      } else {
                        console.warn("[crisis-detector] No user_id for crisis thread creation");
                      }
                    } catch (threadErr) {
                      console.error("[crisis-detector] Thread creation error (non-fatal):", threadErr);
                    }
                  }
                }
              } else {
                console.log(`[crisis-detector] No crisis detected for ${didPartName || "unknown"}`);
              }
            } else {
              console.warn("[crisis-detector] AI call failed:", crisisDetectResponse.status);
            }
          } catch (crisisErr) {
            console.error("[crisis-detector] Error (non-fatal):", crisisErr);
          }
        }
      } catch (e) {
        console.warn("[task-extract] Async extraction error (non-fatal):", e);
      }
    })();

    return new Response(streamForClient, {
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

// ═══ TASK EXTRACTION HELPERS ═══
function extractTasksFromResponse(responseText: string, subMode: string): Array<Record<string, any>> {
  const taskPatterns = [
    /(?:Potřebuji (?:vědět|znát|ověřit|zjistit))[^.!?\n]+[.!?]/gi,
    /(?:Můžeš mi (?:říct|sdělit|popsat))[^.!?\n]+[.!?]/gi,
    /(?:Zeptej se)[^.!?\n]+[.!?]/gi,
    /(?:Úkol(?:\s+pro\s+tebe)?:)[^.!?\n]+[.!?]/gi,
    /(?:Zpětná vazba:)[^.!?\n]+[.!?]/gi,
    /(?:Jak to (?:dopadlo|proběhlo))[^.!?\n]+[.!?]/gi,
    /(?:Navrhuji sezení:)[^.!?\n]+[.!?]/gi,
    /(?:🔶 HYPOTÉZA:)[^.!?\n]+[.!?]/gi,
    /(?:❓)[^.!?\n]+[.!?]/gi,
  ];
  const tasks: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  
  for (const pattern of taskPatterns) {
    const matches = responseText.matchAll(pattern);
    for (const match of matches) {
      const desc = match[0].trim();
      if (desc.length < 10 || seen.has(desc)) continue;
      seen.add(desc);
      tasks.push({
        assigned_to: subMode === "mamka" ? "hanka" : subMode === "kata" ? "kata" : "both",
        task_type: determineTaskType(desc),
        description: desc.slice(0, 500),
        priority: /🔴|akutní|krize|kritick/i.test(responseText) ? "high" : "medium",
        due_date: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "pending",
        source: "chat_auto_extract",
        related_part: extractPartName(desc),
      });
    }
  }
  return tasks.slice(0, 10); // cap at 10 per response
}

function determineTaskType(text: string): string {
  if (/zpětná vazba|jak to|dopadlo|proběhlo/i.test(text)) return "feedback";
  if (/sezení|plán/i.test(text)) return "session";
  if (/zeptej se|potřebuji vědět|potřebuji znát/i.test(text)) return "question";
  if (/hypotéza|ověřit/i.test(text)) return "observation";
  return "followup";
}

function extractPartName(text: string): string | null {
  const knownParts = ["Arthur", "Clark", "Tundrupek", "Gustík", "Baltazar", "Sebastián", "Matyáš", "Kvído", "Alvar", "Dmytri", "Dymi"];
  for (const part of knownParts) {
    if (text.includes(part)) return part;
  }
  return null;
}
