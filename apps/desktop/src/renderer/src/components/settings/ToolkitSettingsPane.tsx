import { Activity, LockKeyhole } from 'lucide-react'
import { useId } from 'react'
import { PERFORMANCE_STATUS_BAR_IDS, type PerformancePreferences } from '../../../../shared/toolkit-preferences'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'

export function ToolkitSettingsPane({ performance, active, onSave }: {
  performance: PerformancePreferences
  active: boolean
  onSave(performance: PerformancePreferences, expected: PerformancePreferences): Promise<void>
}) {
  const id = useId()
  const draft = useSettingDraftRecord(performance)
  const save = useSettingsSave()
  async function submit() {
    const submitted = draft.beginSave()
    const committed = await save.run(() => onSave(submitted.value, submitted.expected))
    submitted.finish(committed)
  }
  return <div className="settings-pane-stack toolkit-settings">
    <p className="settings-lead">Small tools, right where you work.</p>
    <section className="toolkit-settings__tool" aria-label="Performance tool">
      <div className="toolkit-settings__identity">
        <span className="toolkit-settings__icon"><Activity size={24} strokeWidth={1.5} /></span>
        <div><span className="toolkit-settings__eyebrow">Built-in toolkit</span><h3>Performance</h3><p>A clear view of AgentMux and your agents’ resource use.</p></div>
      </div>
      <div className="toolkit-settings__preview" aria-label="Status bar preview">
        <span>Workspace</span><span className="toolkit-settings__preview-tool" data-enabled={draft.value.enabled}>
          <Activity size={15} />{draft.value.statusBar === 'label' && <span>Performance</span>}
        </span><span className="toolkit-settings__preview-settings">Settings</span>
      </div>
      <label className="toolkit-settings__toggle">
        <span><strong>Show Performance</strong><small>Available in the status bar. Observes only while you view it or explicitly run it.</small></span>
        <input type="checkbox" checked={draft.value.enabled} onChange={event => draft.setField('enabled', event.target.checked)} />
      </label>
      <fieldset className="toolkit-settings__layout"><legend>Status bar appearance</legend>
        <div className="toolkit-settings__choices">
          <LiquidSelectionSurface selected={draft.value.statusBar} active={active} targetAttribute="data-settings-target" />
          {PERFORMANCE_STATUS_BAR_IDS.map(value => <label key={value} data-settings-target={value} data-selected={draft.value.statusBar === value}>
            <input type="radio" name={`${id}-layout`} value={value} checked={draft.value.statusBar === value} onChange={() => draft.setField('statusBar', value)} />
            <Activity size={16} />{value === 'icon' ? 'Icon' : 'Icon and name'}
          </label>)}
        </div>
      </fieldset>
      <p className="toolkit-settings__locked"><LockKeyhole size={13} /><span>Official, read-only script. Uses the same public CLI queries available to you.</span></p>
    </section>
    <p className="settings-hint">Turning this off hides the entry and prevents new Performance observations. It does not stop your agents.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save toolkit" onSave={() => void submit()} />
  </div>
}
