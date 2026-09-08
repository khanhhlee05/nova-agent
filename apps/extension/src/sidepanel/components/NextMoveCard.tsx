import type { Course } from "@nova-agent/core";
import { CheckCircle2, ExternalLink, Sparkles } from "lucide-react";
import { formatDeadline, formatRelative } from "../format";
import type { NextMove } from "../model";
import { KindIcon } from "./icons";

export type NextMoveCardProps = {
  nextMove: NextMove | null;
  course: Course | undefined;
  now: Date;
  canOpen: boolean;
  onOpen: (url: string) => void;
  onInspect: (key: string) => void;
};

export const NextMoveCard = ({ nextMove, course, now, canOpen, onOpen, onInspect }: NextMoveCardProps) => {
  if (!nextMove) {
    return (
      <section className="card next-move" aria-labelledby="next-move-heading">
        <div className="card-eyebrow">
          <span id="next-move-heading">Next move</span>
        </div>
        <div className="empty" style={{ marginTop: 10, padding: 18 }}>
          <CheckCircle2 size={22} aria-hidden="true" />
          <strong>Nothing active right now</strong>
          <span>Every visible item is submitted or has no ranking yet.</span>
        </div>
      </section>
    );
  }
  const { item, ranked, reasons } = nextMove;
  const tone = ranked.priority.overdue ? "coral" : (ranked.priority.hoursUntilDue ?? Infinity) < 48 ? "amber" : "blue";
  return (
    <section className="card next-move" aria-labelledby="next-move-heading">
      <div className="card-eyebrow">
        <span id="next-move-heading">Next move</span>
        <span className="muted" style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500 }}>
          Suggested priority
        </span>
      </div>
      <div className="next-move-title">
        <div className="pulse-ring" data-tone={tone} style={{ "--score": ranked.priority.score } as React.CSSProperties} role="img" aria-label={`Suggested priority ${ranked.priority.score} of 100`}>
          <strong>{ranked.priority.score}</strong>
        </div>
        <div style={{ minWidth: 0 }}>
          <h2>{item.title}</h2>
          <div className="meta-row">
            <span className="course-dot" style={{ background: course?.color }} aria-hidden="true" />
            <span>{course?.name ?? "Unknown course"}</span>
            <span aria-hidden="true">·</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KindIcon kind={item.kind} size={13} />
              {item.kind === "quiz" ? "Quiz" : "Assignment"}
            </span>
          </div>
          <div className="meta-row" style={{ marginTop: 2 }}>
            <strong style={{ color: tone === "coral" ? "var(--nova-coral)" : tone === "amber" ? "var(--nova-amber)" : "var(--nova-text)" }}>
              {ranked.priority.overdue ? `Overdue · ${formatRelative(item.dueAt, now)}` : `Due ${formatRelative(item.dueAt, now)}`}
            </strong>
            {item.dueAt ? <span>{formatDeadline(item.dueAt, now)}</span> : null}
          </div>
        </div>
      </div>
      <ul className="reasons" aria-label="Why this first">
        {reasons.map((reason) => (
          <li key={reason.component}>
            <Sparkles size={13} />
            <span>{reason.text}</span>
          </li>
        ))}
      </ul>
      <div className="card-actions">
        {canOpen && item.url ? (
          <button type="button" className="button button-primary button-sm" onClick={() => onOpen(item.url as string)}>
            <ExternalLink size={14} aria-hidden="true" />
            Open in Brightspace
          </button>
        ) : course ? (
          <button type="button" className="button button-primary button-sm" onClick={() => onOpen(course.homeUrl)}>
            <ExternalLink size={14} aria-hidden="true" />
            Open course
          </button>
        ) : null}
        <button type="button" className="button button-ghost button-sm" onClick={() => onInspect(item.key)}>
          Why this score?
        </button>
      </div>
    </section>
  );
};
