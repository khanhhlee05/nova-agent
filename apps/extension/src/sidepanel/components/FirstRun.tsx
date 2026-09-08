import { FlaskConical, KeyRound } from "lucide-react";

export type FirstRunProps = { busy: boolean; onConnectLive: () => void; onUseDemo: () => void };

export const FirstRun = ({ busy, onConnectLive, onUseDemo }: FirstRunProps) => (
  <section className="first-run" aria-labelledby="first-run-heading">
    <span className="hero-orb" aria-hidden="true" />
    <h1 id="first-run-heading">Know what changed. Know what matters next.</h1>
    <p>Nova reads your Brightspace courses through your own logged-in session, keeps everything on this device, and never sends academic data anywhere.</p>
    <ol>
      <li>Sign in to brightspace.villanova.edu in a tab.</li>
      <li>Connect. Nova checks whether Brightspace accepts read-only requests.</li>
      <li>See what is due, what changed, and what to do first.</li>
    </ol>
    <div className="card-actions">
      <button type="button" className="button button-primary" onClick={onConnectLive} disabled={busy}>
        <KeyRound size={16} aria-hidden="true" />
        Connect to Brightspace
      </button>
      <button type="button" className="button" onClick={onUseDemo} disabled={busy}>
        <FlaskConical size={16} aria-hidden="true" />
        Explore with demo data
      </button>
    </div>
    <p className="faint">Unofficial student project. Not affiliated with Villanova University or D2L.</p>
  </section>
);
