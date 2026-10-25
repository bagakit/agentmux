import { useState } from 'react'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { api } from '../../lib/api'
import { crashLogRevealNotice } from '../../lib/crash-log-reveal'
import type { CrashLogRevealResult } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import './general-settings.css'

export type GeneralSettingsValues = { copyPathsAsAbsolute: boolean }

export function GeneralSettingsPane({ copyPathsAsAbsolute, onSave, onOpenRecovery, onOpenHosts }: {
  onOpenRecovery?: () => void
  onOpenHosts?: () => void
  copyPathsAsAbsolute: boolean | undefined
  onSave: (value: GeneralSettingsValues, expected: GeneralSettingsValues) => Promise<void>
}) {
  const saved = copyPathsAsAbsolute === true
  const draft = useSettingDraftRecord({ copyPathsAsAbsolute: saved })
  const saveState = useSettingsSave()
  const [reveal, setReveal] = useState<CrashLogRevealResult | null>(null)
  const [pending, setPending] = useState(false)

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

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
    <div className="settings-pane-stack general-settings">
      <section className="settings-group" data-settings-field="copy-paths">
        <header><span>Project path display and copying</span><small>Saved: {saved ? 'Absolute' : 'Abbreviated'}</small></header>
        <div className="general-settings__path-choice"><FormRow className="browser-automation-toggle" label="Show and copy full project paths"
          description={<>Include your complete home folder instead of <code>~</code>.</>}>
          {attributes => <input {...attributes} type="checkbox" name="copyPathsAsAbsolute" checked={draft.value.copyPathsAsAbsolute} onChange={(event) => draft.setField('copyPathsAsAbsolute', event.target.checked)} />}
        </FormRow>
        <figure className="general-settings__path-preview" aria-label="Project path draft preview" data-path-format={draft.value.copyPathsAsAbsolute ? 'absolute' : 'abbreviated'}>
          <figcaption>{draft.value.copyPathsAsAbsolute ? 'Full path' : 'Abbreviated path'}<small>Example</small></figcaption>
          <code><span>{draft.value.copyPathsAsAbsolute ? 'your home folder' : '~'}</span><b aria-hidden="true"> / </b>project</code>
          <small>Shown in paths, tooltips and Copy Path.</small>
        </figure></div>
        <p className="general-settings__scope">Remote paths and paths belonging to another user stay complete.</p>
      </section>
      <section className="settings-group general-settings__data">
        <header><span>Data & recovery</span><small>Stored on this machine</small></header>
        <dl>
          <div>
            <dt data-settings-field="local-data">Local data</dt>
            <dd>AgentMux keeps your workspace configuration on this machine.</dd>
          </div>
          <div>
            <dt data-settings-field="session-recovery">Session recovery</dt>
            <dd>Your tabs and layouts are restored when you return. Running agents stay available when the desktop window closes.
              {onOpenRecovery && <button type="button" className="small-button" onClick={onOpenRecovery}>Open Session recovery</button>}
            </dd>
          </div>
          <div>
            <dt data-settings-field="system-ssh">System SSH</dt>
            <dd>Connection metadata and key file paths stay on this machine; private key contents are never stored.
              {onOpenHosts && <button type="button" className="small-button" onClick={onOpenHosts}>Open Hosts</button>}
            </dd>
          </div>
        </dl>
      </section>
      <div className="settings-diagnostics" data-settings-field="crash-log">
        {/* 「不上传」这句要和按钮同框。用户第一次意识到崩溃证据存在，就是点这个按钮的时候——
            那一刻他会想「这些东西被发到哪去了」，而答案（哪也没发）必须当场在场，不能在别的页面。 */}
        <span>
          <strong className="general-settings__diagnostics-title">Crash diagnostics</strong>
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
      <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save path preference" onSave={() => void save()} />
    </div>
  )
}
