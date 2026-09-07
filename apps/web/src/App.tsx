const changes = [
  "Microcontrollers Lab 3 moved from Thursday to Friday",
  "A new Computer Architecture quiz was posted",
  "Signals homework is due tonight and remains incomplete",
];

export function App() {
  return (
    <main>
      <nav><span className="brand">NOVA AGENT</span><a href="https://github.com/khanhhlee05/nova-agent">GitHub</a></nav>
      <section className="hero">
        <p className="eyebrow">UNOFFICIAL • BUILT FOR VILLANOVA STUDENTS</p>
        <h1>Know what changed.<br />Know what matters next.</h1>
        <p className="lede">A local-first Brightspace agent that turns deadlines, announcements, and course activity into a clear plan.</p>
        <a className="button" href="#demo">Explore Mission Control</a>
      </section>
      <section className="dashboard" id="demo">
        <header><div><p className="eyebrow">MISSION CONTROL</p><h2>Good afternoon, Wildcat.</h2></div><span className="status">Demo data</span></header>
        <div className="stats">
          <article><strong>2</strong><span>Due today</span></article>
          <article><strong>4</strong><span>This week</span></article>
          <article><strong>1</strong><span>Overdue</span></article>
        </div>
        <article className="changes"><h3>Since your last visit</h3>{changes.map((change) => <p key={change}>→ {change}</p>)}</article>
      </section>
      <footer>Nova Agent is an independent student project and is not affiliated with Villanova University or D2L.</footer>
    </main>
  );
}
