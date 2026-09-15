export const FocusSkeleton = () => (
  <div className="stack" aria-hidden="true" data-testid="skeleton">
    {[0, 1, 2].map((section) => (
      <div key={section} className="skeleton-section">
        <div className="skeleton" style={{ height: 14, width: `${28 + section * 10}%`, marginBottom: 10 }} />
        {[0, 1].map((row) => (
          <div key={row} className="skeleton-row">
            <div>
              <div className="skeleton" style={{ height: 13, width: `${55 + row * 20}%`, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 10, width: "38%" }} />
            </div>
            <div className="skeleton" style={{ height: 32, width: 32 }} />
          </div>
        ))}
      </div>
    ))}
  </div>
);
