import { useState } from 'react'
import { api } from '../../lib/api'
import { crashLogRevealNotice } from '../../lib/crash-log-reveal'
import type { CrashLogRevealResult } from '../../../../shared/contracts'

export function GeneralSettingsPane() {
  const [reveal, setReveal] = useState<CrashLogRevealResult | null>(null)
  const [pending, setPending] = useState(false)

  async function revealCrashLog(): Promise<void> {
    setPending(true)
    try {
      setReveal(await api.ui.revealCrashLog())
    } catch (error) {
      setReveal({ path: '', outcome: 'check-failed', cause: {
        code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CONTROL_FAILED',
        message: error instanceof Error ? error.message : String(error)
      } })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <section className="settings-card">
        <dl className="settings-footnote">
          <div>
            <dt>Local data</dt>
            <dd>Bring your projects and agent tools together in one place. AgentMux keeps your workspace configuration on this machine.</dd>
          </div>
          <div>
            <dt>Session recovery</dt>
            <dd>Your tabs and layouts are restored when you return. Running agents stay available when the desktop window closes.</dd>
          </div>
          <div>
            <dt>System SSH</dt>
            <dd>Remote AgentMux Runs are not supported yet. Connection metadata and key file paths stay on this machine; private key contents are never stored.</dd>
          </div>
        </dl>
      </section>
      <div className="settings-pane-actions">
        {/* 「不上传」这句要和按钮同框。用户第一次意识到崩溃证据存在，就是点这个按钮的时候——
            那一刻他会想「这些东西被发到哪去了」，而答案（哪也没发）必须当场在场，不能在别的页面。 */}
        <span>
          Crashes are recorded to a local file and never uploaded.
          {reveal && <span role="status" className="settings-crash-log-status">
            {crashLogRevealNotice(reveal)}
            {reveal.path && <><br /><code>{reveal.path}</code></>}
          </span>}
        </span>
        <button className="small-button" disabled={pending} onClick={() => void revealCrashLog()}>
          {pending ? 'Requesting…' : 'Show crash log'}
        </button>
      </div>
    </div>
  )
}
