// FIX 9.K.1b — MessageBubble
// Bradavický noční hrad: bg #1E1B2E, pergamen #F4E9C8 (child), tmavý pergamen #3A3050 (karel),
// svíčkový akcent #E8C547.
import React from "react";

export type MessageBubbleProps = {
  sender: "child" | "karel" | "system";
  content: string;
  sent_at: string;
  is_streaming?: boolean;
};

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ sender, content, sent_at, is_streaming }) => {
  if (sender === "system") {
    return (
      <div className="w-full flex justify-center my-2">
        <div style={{ color: "#9A8FB0", fontStyle: "italic", fontSize: 12 }}>
          {content}
        </div>
      </div>
    );
  }

  const isChild = sender === "child";
  return (
    <div className={`w-full flex ${isChild ? "justify-end" : "justify-start"} my-2`}>
      <div style={{ maxWidth: "78%" }}>
        <div
          style={{
            background: isChild ? "#F4E9C8" : "#3A3050",
            color: isChild ? "#1E1B2E" : "#F4E9C8",
            padding: "10px 14px",
            borderRadius: 14,
            border: isChild ? "1px solid #E0D3A8" : "1px solid #5A4A78",
            whiteSpace: "pre-wrap",
            fontFamily: "'DM Sans', system-ui, sans-serif",
            lineHeight: 1.45,
            fontSize: 15,
          }}
        >
          {!isChild && (
            <span
              style={{
                display: "inline-block", width: 22, height: 22, borderRadius: 11,
                background: "#1E1B2E", color: "#E8C547", border: "1.5px solid #E8C547",
                textAlign: "center", lineHeight: "19px", fontSize: 12, marginRight: 8,
                verticalAlign: "middle",
              }}
            >K</span>
          )}
          <span style={{ verticalAlign: "middle" }}>{content}</span>
          {is_streaming && (
            <span style={{ marginLeft: 6, color: "#E8C547" }}>•••</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#7A6F8A", textAlign: isChild ? "right" : "left", marginTop: 3 }}>
          {fmtTime(sent_at)}
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;
