import type { Course } from "@nova-agent/core";
import { ExternalLink, X } from "lucide-react";
import { focusHero } from "../heroes";
import type { NextMove } from "../model";
import { Hero } from "./FieldHeader";
import { Tip } from "./Tip";

export type FocusHeroProps = {
  nextMove: NextMove | null;
  course: Course | undefined;
  now: Date;
  canOpen: boolean;
  onOpen: (url: string) => void;
  onInspect: (key: string) => void;
  onDismiss: (key: string, title: string) => void;
};

export const FocusHero = ({ nextMove, course, now, canOpen, onOpen, onInspect, onDismiss }: FocusHeroProps) => {
  const hero = focusHero(nextMove, course?.name, now);
  if (!nextMove) return <Hero {...hero} headingId="next-move-heading" />;
  const { item, ranked } = nextMove;
  const link = canOpen && item.url ? item.url : course?.homeUrl ?? null;
  return (
    <Hero
      {...hero}
      headingId="next-move-heading"
      aside={
        <Tip label="Hide until next refresh">
          <button type="button" className="icon-button icon-button-sm on-field" aria-label={`Hide "${item.title}" until next refresh`} onClick={() => onDismiss(item.key, item.title)}>
            <X size={15} aria-hidden="true" />
          </button>
        </Tip>
      }
      actions={
        <>
          {link ? (
            <button type="button" className="button button-on-field" onClick={() => onOpen(link)}>
              <ExternalLink size={14} aria-hidden="true" />
              {canOpen && item.url ? "Open in Brightspace" : "Open course"}
            </button>
          ) : null}
          <button type="button" className="hero-score" onClick={() => onInspect(item.key)} aria-label={`Suggested priority ${ranked.priority.score} of 100. Why this score?`}>
            Suggested priority <strong className="mono">{ranked.priority.score}</strong> · why?
          </button>
        </>
      }
    />
  );
};
