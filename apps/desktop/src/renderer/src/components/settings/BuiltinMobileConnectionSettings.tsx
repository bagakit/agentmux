import { LockKeyhole, Smartphone } from 'lucide-react'
import { useContext, useId, useState } from 'react'
import { MOBILE_CONNECTION_STATUS_BAR_IDS, type MobileConnectionPreferences } from '../../../../shared/toolkit-preferences'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsNavigation } from '../SettingsNavigation'
import { MOBILE_CONNECTION_TOOL_ID } from '../../../../shared/toolkit-preferences'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'

export function BuiltinMobileConnectionSettings({ preferences, active, onSave }: {
  preferences: MobileConnectionPreferences
  active: boolean
  onSave(value: MobileConnectionPreferences, expected: MobileConnectionPreferences): Promise<void>
}) {
  const id = useId()
  const navigation = useContext(SettingsNavigation)
  const [source, setSource] = useState(''), [sourceError, setSourceError] = useState('')
  const draft = useSettingDraftRecord(preferences)
  const save = useSettingsSave()
  async function submit() {
    const submitted = draft.beginSave()
    const committed = await save.run(() => onSave(submitted.value, submitted.expected))
    submitted.finish(committed)
  }
  return <div className="settings-pane-stack toolkit-settings settings-devices-pane">
    <section className="toolkit-settings__tool" aria-label="Phone connection tool">
      <div className="toolkit-settings__identity">
        <span className="toolkit-settings__icon"><Smartphone size={24} strokeWidth={1.5} /></span>
        <div><span className="toolkit-settings__eyebrow">Built-in toolkit</span><h3>Phone connection</h3><p>Official extension for connection links and device status.</p></div>
      </div>
      <div className="toolkit-settings__preview" aria-label="Phone connection status bar preview"><span>Workspace · Settings</span><span className="toolkit-settings__preview-tool" data-enabled={draft.value.enabled}><Smartphone size={15} />{draft.value.statusBar === 'label' && <span>Phone connection</span>}</span></div>
      <label className="toolkit-settings__toggle"><span><strong>Show Phone connection in the status bar</strong><small>Quickly connect and check devices. Hiding the tool keeps existing device access.</small></span><input type="checkbox" checked={draft.value.enabled} onChange={event => draft.setField('enabled', event.target.checked)} /></label>
      <fieldset className="toolkit-settings__layout"><legend>Status bar appearance</legend><div className="toolkit-settings__choices">
        <LiquidSelectionSurface selected={draft.value.statusBar} active={active} targetAttribute="data-settings-target" />
        {MOBILE_CONNECTION_STATUS_BAR_IDS.map(value => <label key={value} data-settings-target={value} data-selected={draft.value.statusBar === value}><input type="radio" name={`${id}-layout`} value={value} checked={draft.value.statusBar === value} onChange={() => draft.setField('statusBar', value)} /><Smartphone size={16} />{value === 'icon' ? 'Icon' : 'Icon and label'}</label>)}
      </div></fieldset>
      <p className="toolkit-settings__locked"><LockKeyhole size={13} /><span>Official tool · Access is managed by this computer.</span></p>
    </section>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save display preferences" onSave={() => void submit()} />
    <section className="settings-group"><h3>Tool source</h3><p className="settings-hint">Read-only script bundled with the app. It uses the public API and keeps results in the Toolkit record.</p><div className="settings-pane-toolbar"><button className="small-button" onClick={() => { void api.toolkit.script(MOBILE_CONNECTION_TOOL_ID).then(value => { setSource(value.text); setSourceError('') }).catch(cause => setSourceError(presentError(cause))) }}>View script</button><button className="small-button" onClick={() => navigation?.open('devices')}>Manage phone and devices</button></div>{source && <textarea className="toolkit-result__script" aria-label="Official phone connection script" value={source} readOnly />}{sourceError && <p role="status">{sourceError}</p>}</section>
  </div>
}
