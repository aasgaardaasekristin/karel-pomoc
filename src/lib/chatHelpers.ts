// Chat utility functions extracted from Chat.tsx

export const STORAGE_KEY_PREFIX = "karel_chat_";
export const ACTIVE_MODE_KEY = "karel_active_mode";
export const DID_DOCS_LOADED_KEY = "karel_did_docs_loaded";
export const DID_SESSION_ID_KEY = "karel_did_session_id";
const LAST_CAST_GREETING_INDEX_KEY = "karel_last_cast_greeting_index";

export type ConversationMode = "debrief" | "supervision" | "safety" | "childcare" | "research";
export type HubSection = "did" | "hana" | "research" | null;
export type DidFlowState = "entry" | "terapeut" | "pin-entry" | "therapist-threads" | "dashboard" | "submode-select" | "thread-list" | "part-identify" | "chat" | "loading" | "meeting" | "live-session" | "did-kartoteka";
export type ResearchFlowState = "thread-list" | "new-topic" | "chat";

export const HANA_PIN_KEY = "karel_hana_pin_verified";

const CAST_GREETINGS = [
  "Hej! 😊 Jak se dneska máš? Co nového?",
  "Čau! Co se ti dneska honí hlavou?",
  "Ahoj! 🌟 Povídej, na co máš teď chuť?",
  "Jé, ahoj! Jak se ti daří? Co bys dneska chtěl/a?",
  "Hezky, že jsi tady! Jakou náladu máš právě teď?",
  "Ahoj ahoj! Co hezkého nebo těžkého dneska přišlo?",
  "Čau! Už jsem se těšil/a, až si zase popovídáme. Co je nového?",
];

export const getRandomCastGreeting = () => {
  if (CAST_GREETINGS.length === 1) return CAST_GREETINGS[0];
  try {
    const lastIndexRaw = localStorage.getItem(LAST_CAST_GREETING_INDEX_KEY);
    const lastIndex = lastIndexRaw ? Number(lastIndexRaw) : -1;
    let nextIndex = Math.floor(Math.random() * CAST_GREETINGS.length);
    if (nextIndex === lastIndex) nextIndex = (nextIndex + 1) % CAST_GREETINGS.length;
    localStorage.setItem(LAST_CAST_GREETING_INDEX_KEY, String(nextIndex));
    return CAST_GREETINGS[nextIndex];
  } catch {
    return CAST_GREETINGS[Math.floor(Math.random() * CAST_GREETINGS.length)];
  }
};

export const saveMessages = (mode: string, messages: { role: string; content: string }[]) => {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${mode}`, JSON.stringify({ _mode: mode, messages }));
  } catch {}
};

export const loadMessages = (mode: string) => {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${mode}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "_mode" in parsed) {
      if (parsed._mode !== mode) {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
        return null;
      }
      return parsed.messages;
    }
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
    return null;
  } catch { return null; }
};

export const clearMessages = (mode: string) => {
  localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
};

export const handleApiError = (response: Response) => {
  if (response.status === 429) throw new Error("Karel je momentálně přetížený. Zkus to prosím za chvilku.");
  if (response.status === 402) throw new Error("Karel je momentálně nedostupný – pravděpodobně došly AI kredity.");
  throw new Error("Něco se pokazilo. Zkus to znovu.");
};

/** Parse an SSE stream and call onContent for each delta chunk */
export const parseSSEStream = async (
  body: ReadableStream<Uint8Array>,
  onContent: (content: string) => void,
): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith(":") || line.trim() === "") continue;
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") break;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content as string | undefined;
        if (content) {
          fullContent += content;
          onContent(fullContent);
        }
      } catch {
        buffer = line + "\n" + buffer;
        break;
      }
    }
  }

  return fullContent;
};

export const WELCOME_MESSAGES: Record<ConversationMode, string> = {
  debrief: "Hani, jsem tady. Pojď, sedni si ke mně k ohni. Pracovní den končí a já ti držím prostor, abys mohla odložit vše, co v tobě zůstalo. Jak se právě teď cítíš?",
  supervision: "Haničko, jsem připraven s tebou pracovat. Která postava z tvé praxe tě teď zaměstnává? Můžeme reflektovat, trénovat, nebo ti nabídnu strukturovaný zápis - co potřebuješ?",
  safety: "Hani, pojďme společně a věcně projít to, co tě znepokojuje. Jsem tu jako tvůj partner - projdeme hranice, postup i dokumentaci. Na čem pracujeme?",
  childcare: "",
  research: "🔬 Haničko, jsem připraven prohledat internet pro tebe. Řekni mi, co tě zajímá – nové metody, testy, odborné články, trendy v psychoterapii, techniky pro práci s dětmi... Stačí popsat téma nebo situaci a já najdu relevantní zdroje.",
};
