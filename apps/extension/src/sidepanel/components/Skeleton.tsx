export const FocusSkeleton = () => (
  <div className="stack" aria-hidden="true" data-testid="skeleton">
    <div className="chips">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="skeleton" style={{ height: 52 }} />
      ))}
    </div>
    <div className="skeleton" style={{ height: 150 }} />
    {[0, 1, 2].map((section) => (
      <div key={section} className="section">
        <div className="skeleton-row">
          <div className="skeleton" style={{ height: 14, width: 14, borderRadius: 7 }} />
          <div className="skeleton" style={{ height: 14, width: `${40 + section * 15}%` }} />
        </div>
        {[0, 1].map((row) => (
          <div key={row} className="skeleton-row">
            <div className="skeleton" style={{ height: 16, width: 16 }} />
            <div>
              <div className="skeleton" style={{ height: 12, width: `${55 + row * 20}%`, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 10, width: "35%" }} />
            </div>
          </div>
        ))}
      </div>
    ))}
  </div>
);
