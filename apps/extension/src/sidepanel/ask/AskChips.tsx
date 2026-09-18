import type { Dashboard } from "../model";

/** Three questions worth asking right now, derived from the data. */
export const suggestedQuestions = (dashboard: Dashboard): string[] => {
  const first = "What should I start first?";
  const second = dashboard.counts.overdue > 0 ? "What is overdue?" : dashboard.counts.thisWeek > 0 ? "What is due in the next 7 days?" : "What is due later?";
  const third = dashboard.totalChanges > 0 ? "What changed since my last visit?" : "Any new announcements?";
  return [first, second, third];
};

export type AskChipsProps = { dashboard: Dashboard; disabled: boolean; onPick: (question: string) => void };

export const AskChips = ({ dashboard, disabled, onPick }: AskChipsProps) => (
  <div className="ask-chips" role="group" aria-label="Suggested questions">
    {suggestedQuestions(dashboard).map((question) => (
      <button key={question} type="button" className="chip-on-field" aria-disabled={disabled || undefined} onClick={() => (disabled ? undefined : onPick(question))}>
        {question}
      </button>
    ))}
  </div>
);
