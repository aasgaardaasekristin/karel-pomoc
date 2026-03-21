import { describe, it, expect } from "vitest";
import { parseTaskSuggestions } from "@/components/did/TaskSuggestButtons";

// Test parseTaskSuggestions from TaskSuggestButtons
describe("parseTaskSuggestions", () => {
  it("parses valid TASK_SUGGEST tags", () => {
    const input = "Nějaký text [TASK_SUGGEST:hanka:today]Zavolat škole[/TASK_SUGGEST] a další text.";
    const { cleanContent, suggestions } = parseTaskSuggestions(input);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({ task: "Zavolat škole", assignee: "hanka", category: "today" });
    expect(cleanContent).toBe("Nějaký text  a další text.");
  });

  it("parses multiple tags", () => {
    const input = "[TASK_SUGGEST:kata:tomorrow]Připravit karty[/TASK_SUGGEST] [TASK_SUGGEST:both:longterm]Supervize[/TASK_SUGGEST]";
    const { suggestions } = parseTaskSuggestions(input);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].assignee).toBe("kata");
    expect(suggestions[1].category).toBe("longterm");
  });

  it("ignores invalid assignees", () => {
    const input = "[TASK_SUGGEST:unknown:today]Něco[/TASK_SUGGEST]";
    const { suggestions } = parseTaskSuggestions(input);
    expect(suggestions).toHaveLength(0);
  });

  it("returns empty for no tags", () => {
    const { suggestions, cleanContent } = parseTaskSuggestions("Prostý text bez tagů");
    expect(suggestions).toHaveLength(0);
    expect(cleanContent).toBe("Prostý text bez tagů");
  });
});

// Test the structured task regex used in DidLiveSessionPanel handleEndSession
describe("structured task regex (DidLiveSessionPanel)", () => {
  const parseStructuredTasks = (tasksText: string) => {
    const regex = /^-\s*\[(hanka|kata|both)\]\s*\[(today|tomorrow|longterm)\]\s*(.+)/gmi;
    const results: { task: string; assignee: string; category: string }[] = [];
    let match;
    while ((match = regex.exec(tasksText)) !== null) {
      results.push({
        assignee: match[1].toLowerCase(),
        category: match[2].toLowerCase(),
        task: match[3].trim(),
      });
    }
    return results;
  };

  it("parses valid structured tasks", () => {
    const input = `- [hanka] [today] Zavolat škole ohledně IVP
- [kata] [tomorrow] Připravit relaxační karty
- [both] [longterm] Domluvit společnou supervizi`;
    const tasks = parseStructuredTasks(input);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({ assignee: "hanka", category: "today", task: "Zavolat škole ohledně IVP" });
    expect(tasks[1]).toEqual({ assignee: "kata", category: "tomorrow", task: "Připravit relaxační karty" });
    expect(tasks[2]).toEqual({ assignee: "both", category: "longterm", task: "Domluvit společnou supervizi" });
  });

  it("handles mixed content (non-task lines ignored)", () => {
    const input = `Konkrétní úkoly pro tým:
- [hanka] [today] Zavolat škole
Nějaký volný text
- [kata] [tomorrow] Připravit karty`;
    const tasks = parseStructuredTasks(input);
    expect(tasks).toHaveLength(2);
  });

  it("returns empty for unstructured tasks", () => {
    const input = `- Pro Hanku: zavolat škole
- Pro Káťu: připravit karty`;
    const tasks = parseStructuredTasks(input);
    expect(tasks).toHaveLength(0);
  });

  it("handles case-insensitive assignees", () => {
    const input = "- [Hanka] [Today] Test úkol";
    const tasks = parseStructuredTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe("hanka");
    expect(tasks[0].category).toBe("today");
  });

  it("handles empty input", () => {
    expect(parseStructuredTasks("")).toHaveLength(0);
  });
});

// Test renderMarkdown basic patterns
describe("renderMarkdown patterns", () => {
  // Inline test of the regex logic used in renderMarkdown
  it("detects headings correctly", () => {
    expect("## Title".startsWith("## ")).toBe(true);
    expect("### Subtitle".startsWith("### ")).toBe(true);
    expect("##Not a heading".startsWith("## ")).toBe(false);
  });

  it("detects list items", () => {
    expect(/^\s*[\*\-]\s/.test("- item")).toBe(true);
    expect(/^\s*[\*\-]\s/.test("* item")).toBe(true);
    expect(/^\s*[\*\-]\s/.test("  - nested")).toBe(true);
    expect(/^\s*[\*\-]\s/.test("no dash")).toBe(false);
  });

  it("bold replacement works", () => {
    const result = "text **bold** more".replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    expect(result).toBe("text <strong>bold</strong> more");
  });
});
