import type { AppModeId, StarterQuestion } from "@/lib/appModePolicy";

interface StarterQuestionsProps {
  modeId: Exclude<AppModeId, "no_save">;
  questions: StarterQuestion[];
  disabled?: boolean;
  onSelect: (question: StarterQuestion) => void;
}

const StarterQuestions = ({ modeId, questions, disabled, onSelect }: StarterQuestionsProps) => {
  if (questions.length === 0) return null;

  return (
    <div className="px-3 sm:px-4 pb-2" data-testid={`starter-questions-${modeId}`}>
      <div className="max-w-4xl mx-auto flex gap-2 overflow-x-auto py-1">
        {questions.map((question) => (
          <button
            key={question.id}
            type="button"
            disabled={disabled}
            data-mode-id={question.mode_id}
            data-save-policy={question.intended_write_policy}
            data-no-save={question.default_no_save ? "true" : "false"}
            onClick={() => onSelect(question)}
            className="shrink-0 rounded-lg border border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-secondary))]/70 px-3 py-2 text-left text-xs text-[hsl(var(--text-secondary))] shadow-sm transition-colors hover:bg-[hsl(var(--surface-tertiary))] hover:text-[hsl(var(--text-primary))] disabled:opacity-50"
            title={question.description || question.prompt}
          >
            {question.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default StarterQuestions;