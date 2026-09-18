import { useState } from 'react'
import { api } from '../../lib/api'
import { crashLogRevealNotice, type CrashLogReveal } from '../../lib/crash-log-reveal'

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
