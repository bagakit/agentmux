// General is read-only: it states where the runtime lives, not a control you flip. A pane-level lead
// sentence introduces it (as in the other panes), then one flat informational block (surface-0 +
// hairline, no box, no accent icon tile) holds the muted footnote facts — reachable without spending
// elevation or brand green on prose. The lead sits OUTSIDE .settings-card on purpose: `.settings-card p`
// is footnote-styled (--fs-meta/--text-3, higher specificity than .settings-lead), so nesting the lead
// there would collapse it to footnote size and erase the lead/footnote hierarchy this pane exists to show.
export function GeneralSettingsPane() {
  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">Runtime and transport are owned by the framework-independent Core package; there is nothing to configure here.</p>
      <section className="settings-card">
        <dl className="settings-footnote">
          <div>
            <dt>Core-owned agent runtime</dt>
            <dd>Provider discovery, Agent Sessions, status hooks and Run transport all live in Core.</dd>
          </div>
          <div>
            <dt>Terminal-first Runs</dt>
            <dd>Every coding agent uses a durable Run and stays available when the desktop app closes.</dd>
          </div>
          <div>
            <dt>System SSH</dt>
            <dd>Remote hosts use your installed SSH client and authentication. AgentMux stores connection metadata and key file paths, never private key contents.</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
