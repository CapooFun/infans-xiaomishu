export function ProgressRail({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const width = Math.max(0, Math.min(100, (Number(value) || 0) * 100));
  return (
    <div className="progress-rail">
      <div className="progress-rail-meta">
        <span>{label}</span>
        {sub ? <em>{sub}</em> : null}
      </div>
      <div className="progress-rail-track" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
