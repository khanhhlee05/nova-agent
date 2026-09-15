import { FlaskConical, KeyRound } from "lucide-react";

export type FirstRunProps = { busy: boolean; onConnectLive: () => void; onUseDemo: () => void };

/** Body of the first-run screen; the headline lives in the field above it. */
export const FirstRun = ({ busy, onConnectLive, onUseDemo }: FirstRunProps) => (
  <section className="first-run" aria-label="Get started">
    <ol>
      <li>Sign in to brightspace.villanova.edu in a tab.</li>
      <li>Connect. Nova checks whether Brightspace accepts read-only requests.</li>
      <li>See what is due, what changed, and what to do first.</li>
    </ol>
    <div className="first-run-actions">
      <button type="button" className="button button-primary" onClick={onConnectLive} disabled={busy}>
        <KeyRound size={16} aria-hidden="true" />
        Connect to Brightspace
      </button>
      <button type="button" className="button" onClick={onUseDemo} disabled={busy}>
        <FlaskConical size={16} aria-hidden="true" />
        Explore with demo data
      </button>
    </div>
    <p className="muted">Unofficial student project. Not affiliated with Villanova University or D2L.</p>
  </section>
);
