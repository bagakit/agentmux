import { Box, RadioTower, SquareTerminal } from 'lucide-react'

export function GeneralSettingsPane() {
  return (
    <div className="settings-pane-stack">
      <section className="settings-card settings-card--hero">
        <span className="settings-card__icon"><Box size={18} /></span>
        <div>
          <h3>Core-owned agent runtime</h3>
          <p>AgentMux keeps Provider discovery, Agent Sessions, status hooks and Run transport in the framework-independent Core package.</p>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-row-heading"><SquareTerminal size={15} /><div><h3>Terminal-first Runs</h3><p>Every coding agent uses a durable Run and remains available when the desktop app closes.</p></div></div>
      </section>
      <section className="settings-card">
        <div className="settings-row-heading"><RadioTower size={15} /><div><h3>System SSH</h3><p>Remote hosts use your installed SSH client and authentication. AgentMux stores connection metadata and key file paths, never private key contents.</p></div></div>
      </section>
    </div>
  )
}
