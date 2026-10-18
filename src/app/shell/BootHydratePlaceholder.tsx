/** Boot-hydrate placeholder (N8), shared by History, Dictionary and Settings. */
export function BootHydratePlaceholder({ title }: { title: string }) {
  return (
    <section aria-busy="true" aria-labelledby="boot-hydrate-title">
      <header className="page-head">
        <h1 id="boot-hydrate-title">{title}</h1>
      </header>
      <div className="empty boot-loading">
        <span aria-hidden="true" className="spin" />
        <b>Loading saved data for this device…</b>
        <span className="sr-only" role="status">Loading…</span>
      </div>
    </section>
  );
}
