import { DEFAULT_GOALS_COMMON_ACTIONS } from '../../../../shared/goals-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/settings-workflows.css'

export function GoalsSettingsPane({ collapsed, onSave, onOpenGoals }: {
  collapsed: boolean | undefined
  onSave(value: boolean, expected: boolean): Promise<void>
  onOpenGoals(): void
}) {
  const saved = collapsed ?? DEFAULT_GOALS_COMMON_ACTIONS.collapsed
  const draft = useSettingDraft(saved), saveState = useSettingsSave()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Common actions</span><small>Saved: {saved ? 'Collapsed' : 'Expanded'}</small></header>
      <label className="browser-automation-toggle"><input type="checkbox" checked={draft.value} onChange={event => draft.setValue(event.target.checked)} aria-label="Collapse common actions" />
        <span><strong>Start with common actions collapsed</strong><small>Keep Goals focused on your work. Expand common actions whenever you need them.</small></span>
      </label>
    </section>
    <div className="settings-workflows__inline-action"><p className="settings-workflows__note">Choose, reorder and edit common actions directly in Goals. They use the same Prompts library.</p>
      <button type="button" className="small-button" onClick={onOpenGoals}>Open Goals</button>
    </div>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
