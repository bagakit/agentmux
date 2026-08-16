import { useState } from 'react'
import { api } from '../../lib/api'
import { crashLogRevealNotice, type CrashLogReveal } from '../../lib/crash-log-reveal'

// General is read-only: it states where the runtime lives, not a control you flip. A pane-level lead
// sentence introduces it (as in the other panes), then one flat informational block (surface-0 +
// hairline, no box, no accent icon tile) holds the muted footnote facts — reachable without spending
// elevation or brand green on prose. The lead sits OUTSIDE .settings-card on purpose: `.settings-card p`
// is footnote-styled (--fs-meta/--text-3, higher specificity than .settings-lead), so nesting the lead
// there would collapse it to footnote size and erase the lead/footnote hierarchy this pane exists to show.
export function GeneralSettingsPane() {
  const [reveal, setReveal] = useState<CrashLogReveal>('idle')

  async function revealCrashLog(): Promise<void> {
    try {
      setReveal(await api.ui.revealCrashLog() ? 'revealed' : 'absent')
    } catch {
      // 失败也要出声。这条动作的全部意义就是让一份看不见的证据变得看得见，静默失败等于没做。
      setReveal('failed')
    }
  }

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
      <div className="settings-pane-actions">
        {/* 「不上传」这句要和按钮同框。用户第一次意识到崩溃证据存在，就是点这个按钮的时候——
            那一刻他会想「这些东西被发到哪去了」，而答案（哪也没发）必须当场在场，不能在别的页面。 */}
        <span>{crashLogRevealNotice(reveal) ?? 'Crashes are recorded to a local file and never uploaded.'}</span>
        <button className="small-button" onClick={() => void revealCrashLog()}>
          Show crash log
        </button>
      </div>
    </div>
  )
}
