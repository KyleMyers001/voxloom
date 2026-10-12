export function BootHydratePlaceholder({ title }: { title: string }) {
  return (
    <section aria-busy="true" aria-labelledby="boot-hydrate-title">
      <div className="hero">
        <div>
          <h1 id="boot-hydrate-title">{title}</h1>
          <p>Loading saved data for this device…</p>
        </div>
      </div>
      <div className="card">
        <p className="empty-note" role="status">Loading…</p>
      </div>
    </section>
  );
}
