// Chat utility functions extracted from Chat.tsx

export const STORAGE_KEY_PREFIX = "karel_chat_";
export const ACTIVE_MODE_KEY = "karel_active_mode";
export const DID_DOCS_LOADED_KEY = "karel_did_docs_loaded";
export const DID_SESSION_ID_KEY = "karel_did_session_id";
export const EXPLICIT_LOGOUT_KEY = "karel_explicit_logout";
const LAST_CAST_GREETING_INDEX_KEY = "karel_last_cast_greeting_index";

export type ConversationMode = "debrief" | "supervision" | "safety" | "childcare" | "research";
export type HubSection = "karel" | "did" | "hana" | "research" | null;
export type DidFlowState = "entry" | "terapeut" | "pin-entry" | "therapist-threads" | "dashboard" | "submode-select" | "thread-list" | "playroom" | "part-identify" | "chat" | "loading" | "meeting" | "live-session" | "did-kartoteka";
export type ResearchFlowState = "thread-list" | "new-topic" | "chat";

export const HANA_PIN_KEY = "karel_hana_pin_verified";
export const HANA_PIN_ACCESS_TOKEN_KEY = "karel_hana_pin_access_token";

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

export const clearNoHistoryChatStorage = () => {
  try {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith(STORAGE_KEY_PREFIX) || key === ACTIVE_MODE_KEY || key === "karel_did_submode" || key === "karel_did_context" || key === DID_DOCS_LOADED_KEY || key === DID_SESSION_ID_KEY) {
        localStorage.removeItem(key);
      }
    });
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("chat_draft:")) sessionStorage.removeItem(key);
    }
  } catch {}
};

export const countMarkerInBrowserStorage = (marker: string) => {
  const includesMarker = (value: string | null) => Boolean(value && marker && value.includes(marker));
  let localStorageCount = 0;
  let sessionStorageCount = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      if (includesMarker(localStorage.getItem(localStorage.key(i) || ""))) localStorageCount += 1;
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      if (includesMarker(sessionStorage.getItem(sessionStorage.key(i) || ""))) sessionStorageCount += 1;
    }
  } catch {}
  return { localStorageCount, sessionStorageCount };
};

export const markExplicitLogout = () => {
  try { sessionStorage.setItem(EXPLICIT_LOGOUT_KEY, String(Date.now())); } catch {}
};

export const isExplicitLogoutActive = () => {
  try {
    const raw = sessionStorage.getItem(EXPLICIT_LOGOUT_KEY);
    if (!raw) return false;
    if (raw === "true") return true;
    const markedAt = Number(raw);
    if (!Number.isFinite(markedAt)) return true;
    if (Date.now() - markedAt > 2 * 60 * 1000) {
      sessionStorage.removeItem(EXPLICIT_LOGOUT_KEY);
      return false;
    }
    return true;
  } catch { return false; }
};

export const clearActiveWorkStorageForLogout = () => {
  try {
    [ACTIVE_MODE_KEY, "karel_did_submode", DID_SESSION_ID_KEY, "karel_did_context", DID_DOCS_LOADED_KEY].forEach((key) => localStorage.removeItem(key));
    ["karel_hub_section", "karel_open_deliberation_id", "karel_meeting_seed", "karel_no_save", HANA_PIN_KEY, HANA_PIN_ACCESS_TOKEN_KEY].forEach((key) => sessionStorage.removeItem(key));
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("chat_draft:")) sessionStorage.removeItem(key);
    }
  } catch {}
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
