import type { AcademicItem, Course } from "@nova-agent/core";
import { COMPONENT_LABELS, explainPriority, type RankedItem } from "@nova-agent/planner";
import { ChevronDown, ExternalLink } from "lucide-react";
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
};

/** Shared detail body used by the Focus row expansion and the Week popover. */
export const ItemDetails = ({ item, course, ranked, now, canOpen, onOpen, headingLevel = "h4" }: ItemDetailsProps) => {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const reasons = ranked ? explainPriority(item, ranked.priority) : [];
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
        <dd>{STATUS_LABELS[item.status]}{item.status === "unknown" ? <span className="faint"> · Brightspace did not share submission state</span> : null}</dd>
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
        <section className="priority-box" aria-label="Suggested priority">
          <header>
            <span>Suggested priority</span>
            <strong className="mono">{ranked.priority.score}</strong>
          </header>
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
            <div className="breakdown" role="table" aria-label="Priority breakdown">
              {(Object.keys(ranked.priority.components) as (keyof typeof ranked.priority.components)[]).map((component) => (
                <span key={component} style={{ display: "contents" }} role="row">
                  <span role="cell">{COMPONENT_LABELS[component]}</span>
                  <span role="cell">{ranked.priority.components[component].toFixed(1)}</span>
                </span>
              ))}
              <span role="cell">
                <strong>Total (rounded, 0–100)</strong>
              </span>
              <span role="cell">
                <strong>{ranked.priority.score}</strong>
              </span>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="muted">Not ranked: {item.status === "submitted" || item.status === "completed" ? "already done." : "not yet available."}</p>
      )}
      <div className="card-actions">
        {link ? (
          <button type="button" className="button button-sm" onClick={() => onOpen(link)}>
            <ExternalLink size={14} aria-hidden="true" />
            {canOpen ? "Open in Brightspace" : "Open course"}
          </button>
        ) : null}
      </div>
    </div>
  );
};
