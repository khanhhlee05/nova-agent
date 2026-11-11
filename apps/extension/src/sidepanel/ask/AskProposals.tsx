import { CalendarDays, Check, Undo2, X } from "lucide-react";
import { SETTLED_COPY, canUndo, resolveProposal, type AskProposal, type ProposalContext } from "./proposals";

const settledText = (proposal: AskProposal): string => {
  if (proposal.state === "pending") return "";
  if (proposal.state === "confirmed" && proposal.payload.kind === "hide_item") return "Hidden. Show all in the panel brings it back.";
  if (proposal.state === "confirmed" && proposal.payload.kind === "add_personal_deadline") return "Added to your Week tab.";
  return SETTLED_COPY[proposal.state];
};

export type ProposalAction = "confirm" | "dismiss" | "undo" | "show";

export type AskProposalsProps = {
  proposals: readonly AskProposal[];
  /** The data the suggestions are checked against. Without it the cards are shown without controls. */
  context?: ProposalContext;
  onAction?: (proposal: AskProposal, action: ProposalAction) => void;
};

/**
 * Suggestions under an answer. A card says exactly what confirming would do,
 * in words written here from the data on this device, and does nothing until
 * the student confirms. Decided cards stay, quieter, as a record.
 */
export const AskProposals = ({ proposals, context, onAction }: AskProposalsProps) => {
  if (proposals.length === 0) return null;
  return (
    <ul className="ask-proposals" aria-label="Suggested actions">
      {proposals.map((proposal) => {
        const resolved = context ? resolveProposal(proposal.payload, context) : null;
        const pending = proposal.state === "pending";
        // Once decided, the card keeps the sentence it was confirmed under: the data has moved on since.
        const text = pending && resolved ? resolved.text : proposal.label;
        const available = pending && !!resolved && resolved.kind !== "unavailable";
        return (
          <li key={proposal.id} className="ask-proposal" data-state={proposal.state}>
            <p className="ask-proposal-kicker">{pending ? "Nova suggests" : "Suggestion"}</p>
            <p className="ask-proposal-text">{text}</p>
            {pending ? (
              onAction ? (
                <div className="card-actions">
                  {available ? (
                    <button type="button" className="button button-primary button-sm" onClick={() => onAction(proposal, "confirm")}>
                      <Check size={14} aria-hidden="true" />
                      Confirm
                    </button>
                  ) : null}
                  <button type="button" className="button button-ghost button-sm" onClick={() => onAction(proposal, "dismiss")}>
                    <X size={14} aria-hidden="true" />
                    Dismiss
                  </button>
                </div>
              ) : null
            ) : (
              <div className="card-actions">
                <span className="ask-proposal-status" role="status">
                  {settledText(proposal)}
                </span>
                {onAction && canUndo(proposal) ? (
                  <button type="button" className="button button-ghost button-sm" onClick={() => onAction(proposal, "undo")}>
                    <Undo2 size={14} aria-hidden="true" />
                    Undo
                  </button>
                ) : null}
                {onAction && proposal.state === "confirmed" && proposal.payload.kind === "add_personal_deadline" && proposal.applied?.personalId ? (
                  <button type="button" className="button button-ghost button-sm" onClick={() => onAction(proposal, "show")}>
                    <CalendarDays size={14} aria-hidden="true" />
                    Show on Week
                  </button>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
