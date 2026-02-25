import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getSystemPrompt, scenarioLabels } from "./systemPrompt.ts";
import type { CalmScenario } from "./systemPrompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Simple in-memory rate limiter for public endpoint
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
function checkRateLimit(id: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = rateLimitMap.get(id);
  if (!rec || now > rec.resetTime) { rateLimitMap.set(id, { count: 1, resetTime: now + windowMs }); return true; }
  if (rec.count >= max) return false;
  rec.count++;
  return true;
}

// Webhook placeholder – set URL to activate
const WEBHOOK_URL: string | null = null;

interface WebhookPayload {
  timestamp: string;
  scenario: string;
  riskLevel: "HIGH";
  riskScore: number;
  summary: string;
}

async function triggerWebhook(payload: WebhookPayload): Promise<void> {
  if (!WEBHOOK_URL) {
    console.log("HIGH_RISK_WEBHOOK_PREPARED", JSON.stringify(payload));
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Webhook error:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Rate limiting: max 30 messages per hour per IP
  const clientIP = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(clientIP, 30, 3600000)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { messages, scenario = "other", userName } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Extract cumulative risk score from previous assistant messages
    let maxRiskScore = 0;
    for (const m of messages) {
      if (m.role === "assistant") {
        const match = m.content?.match(/\[RISK_SCORE:(\d+)\]/);
        if (match) {
          const score = parseInt(match[1], 10);
          if (score > maxRiskScore) maxRiskScore = score;
        }
      }
    }

    // Trigger webhook preparation at high risk
    if (maxRiskScore >= 9) {
      const payload: WebhookPayload = {
        timestamp: new Date().toISOString(),
        scenario: scenario as string,
        riskLevel: "HIGH",
        riskScore: maxRiskScore,
        summary: `High risk detected in ${scenarioLabels[scenario as CalmScenario] || scenario} session.`,
      };
      console.log("HIGH_RISK", JSON.stringify({ scenario, riskScore: maxRiskScore }));
      await triggerWebhook(payload);
    }

    const systemPrompt = getSystemPrompt(scenario as CalmScenario, userName);

    // Clean messages - remove risk markers before sending to model
    const cleanedMessages = messages.map((m: { role: string; content: any }) => {
      // Pass through multimodal content arrays as-is
      if (Array.isArray(m.content)) {
        return { role: m.role, content: m.content };
      }
      return {
        ...m,
        content: m.content.replace(/\[RISK_SCORE:\d+\]/g, "").replace(/\[RISK:HIGH\]/g, "").trim(),
      };
    });

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
          ...cleanedMessages,
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
    console.error("Karel calm error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
