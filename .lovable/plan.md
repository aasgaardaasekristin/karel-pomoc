

# Fix: Session plan JSON parsing

## Problem
In `supabase/functions/karel-session-plan/index.ts` (lines 139-144), the current regex-based stripping is fragile. It uses two sequential `replace()` calls that fail when the AI wraps the JSON in markdown with surrounding text (e.g., "Here's the plan:\n```json\n{...}\n```").

## Fix
Replace lines 138-144 in `supabase/functions/karel-session-plan/index.ts`:

```typescript
let plan: any;
try {
  // Try to extract JSON from markdown code block first
  const match = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  const clean = match ? match[1].trim() : rawContent.trim();
  plan = JSON.parse(clean);
} catch (e) {
  console.error("Failed to parse session plan JSON. Raw AI response:", rawContent);
  plan = { sessionGoal: "Plán nebyl vygenerován ve správném formátu", phases: [], whyThisPlan: rawContent };
}
```

**One file changed, ~3 lines modified.** The regex properly captures content between ` ```json ` and ` ``` ` delimiters, falling back to raw content if no code block is found. Failed parses now log the raw response for debugging.

