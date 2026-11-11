import type { AcademicItem, Course } from "@nova-agent/core";
import { BAND_LABELS, COMPONENT_LABELS, COMPONENT_MAX, describePriority, explainPriority, priorityBand, type RankedItem } from "@nova-agent/planner";
import { ChevronDown, ExternalLink, EyeOff, MessageCircleQuestionMark } from "lucide-react";
import { useState } from "react";
import { formatExact, formatRelative } from "../format";
import { KIND_LABELS, STATUS_LABELS } from "../model";

export type ItemDetailsProps = {
  item: AcademicItem;
  course: Course | undefined;
  ranked: RankedItem | undefined;
  now: Date;
  canOpen: boolean;
  onOpen: (url: string) => void;
  headingLevel?: "h3" | "h4";
  /** Session-only dismissal; the item returns on the next refresh. */
  onDismiss?: () => void;
  /** When the student marked the item done on this device, if they did. */
  markedAt?: string | null;
  /** Starts an Ask Nova question about this item. Absent when Ask is off. */
  onAsk?: () => void;
};

/** Shared detail body used by the Focus row expansion and the Week popover. */
export const ItemDetails = ({ item, course, ranked, now, canOpen, onOpen, headingLevel = "h4", onDismiss, markedAt = null, onAsk }: ItemDetailsProps) => {
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Up to three reasons here; the hero shows two. Every non-zero part is in the breakdown below.
  const reasons = ranked ? explainPriority(item, ranked.priority, 3) : [];
  const inPerson = item.submissionType === "on-paper" || item.submissionType === "observed";
  const Heading = headingLevel;
  const link = canOpen ? item.url : course?.homeUrl ?? null;
  return (
    <div className="details">
      <Heading>{item.title}</Heading>
      <dl>
        <dt>Source</dt>
        <dd>
          {KIND_LABELS[item.kind]} · {course?.name ?? "Unknown course"}
        </dd>
        <dt>Due</dt>
        <dd>
          {formatExact(item.dueAt)}
          {item.dueAt ? <span className="muted"> ({formatRelative(item.dueAt, now)})</span> : null}
        </dd>
        <dt>Status</dt>
        <dd>
          {STATUS_LABELS[item.status]}
          {item.status === "unknown" ? <span className="muted"> · Brightspace did not share submission state</span> : null}
          {inPerson && item.status === "not-started" ? <span className="muted"> · Handed in {item.submissionType === "on-paper" ? "on paper" : "in person"}, so Brightspace may never mark it submitted</span> : null}
        </dd>
        {item.score?.graded ? (
          <>
            <dt>Score</dt>
            <dd>{item.score.earned !== null ? `${item.score.earned}${item.pointsPossible !== null ? ` of ${item.pointsPossible}` : ""}` : "Graded, no number shared"}</dd>
          </>
        ) : null}
        {markedAt ? (
          <>
            <dt>On this device</dt>
            <dd>Marked done by you {formatRelative(markedAt, now)}. Brightspace still lists it as open.</dd>
          </>
        ) : null}
        {item.pointsPossible !== null ? (
          <>
            <dt>Points</dt>
            <dd>{item.pointsPossible}</dd>
          </>
        ) : null}
        {item.visibility !== "visible" ? (
          <>
            <dt>Visibility</dt>
            <dd>{item.visibility}</dd>
          </>
        ) : null}
      </dl>
      {ranked ? (
        <section className="priority-box" aria-label="Priority">
          <header>
            <span>{BAND_LABELS[priorityBand(ranked.priority.score)]} · priority out of 100</span>
            <strong className="mono">{ranked.priority.score}</strong>
          </header>
          <p className="priority-summary">{describePriority(item, ranked.priority)}</p>
          <ul className="reasons">
            {reasons.map((reason) => (
              <li key={reason.component}>{reason.text}</li>
            ))}
          </ul>
          <button type="button" className="disclosure" aria-expanded={showBreakdown} onClick={() => setShowBreakdown((value) => !value)}>
            <ChevronDown size={14} aria-hidden="true" style={{ transform: showBreakdown ? "rotate(180deg)" : undefined }} />
            {showBreakdown ? "Hide breakdown" : "Show breakdown"}
          </button>
          {showBreakdown ? (
            <dl className="breakdown" aria-label="Priority breakdown">
              {(Object.keys(ranked.priority.components) as (keyof typeof ranked.priority.components)[]).map((component) => (
                <div key={component} style={{ display: "contents" }}>
                  <dt>{COMPONENT_LABELS[component]}</dt>
                  <dd className="mono">
                    {ranked.priority.components[component].toFixed(1)} <span className="muted">of {COMPONENT_MAX[component]}</span>
                  </dd>
                </div>
              ))}
              <div className="total" style={{ display: "contents" }}>
                <dt>Total (rounded, 0 to 100)</dt>
                <dd className="mono">{ranked.priority.score}</dd>
              </div>
            </dl>
          ) : null}
        </section>
      ) : (
        <p className="muted">Not ranked: {item.status === "submitted" || item.status === "completed" || markedAt ? "already done." : "not yet available."}</p>
      )}
      <div className="card-actions">
        {link ? (
          <button type="button" className="button button-sm" onClick={() => onOpen(link)}>
            <ExternalLink size={14} aria-hidden="true" />
            {canOpen ? "Open in Brightspace" : "Open course"}
          </button>
        ) : null}
        {onAsk ? (
          <button type="button" className="button button-sm" onClick={onAsk}>
            <MessageCircleQuestionMark size={14} aria-hidden="true" />
            Ask Nova about this
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="button button-ghost button-sm" onClick={onDismiss}>
            <EyeOff size={14} aria-hidden="true" />
            Hide until next refresh
          </button>
        ) : null}
      </div>
    </div>
  );
};
