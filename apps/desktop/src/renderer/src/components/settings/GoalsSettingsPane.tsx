import { useId } from 'react'
import { Columns3, List } from 'lucide-react'
import { DEFAULT_GOALS_COMMON_ACTIONS, GOALS_VIEW_IDS, resolveGoalsPreferences, type GoalsPreferences } from '../../../../shared/goals-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/settings-workflows.css'

export function GoalsSettingsPane({ collapsed, preferences, onSave, onOpenGoals }: {
  collapsed: boolean | undefined
  preferences?: GoalsPreferences | undefined
  onSave(value: boolean, expected: boolean, preferences: Required<GoalsPreferences>, expectedPreferences: Required<GoalsPreferences>): Promise<void>
  onOpenGoals(): void
}) {
  const saved = collapsed ?? DEFAULT_GOALS_COMMON_ACTIONS.collapsed
  const draft = useSettingDraft(saved), saveState = useSettingsSave()
  const savedView = resolveGoalsPreferences(preferences)
  const view = useSettingDraft(savedView.defaultView), finished = useSettingDraft(savedView.showFinished), viewGroup = useId()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    const submittedView = view.beginSave(), submittedFinished = finished.beginSave()
    const committed = await saveState.run(() => onSave(submitted.value, submitted.expected,
      { defaultView: submittedView.value, showFinished: submittedFinished.value },
      { defaultView: submittedView.expected, showFinished: submittedFinished.expected }))
    submitted.finish(committed); submittedView.finish(committed); submittedFinished.finish(committed)
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Starting view</span><small>Saved: {savedView.defaultView === 'board' ? 'Board' : 'List'}</small></header>
      <p className="settings-workflows__note">Used when you open a new Goals view. You can still switch views while working.</p>
      <fieldset className="settings-goals-view"><legend>Default Goals view</legend>
        {GOALS_VIEW_IDS.map(choice => <label key={choice} data-selected={view.value === choice}>
          <input type="radio" name={viewGroup} checked={view.value === choice} onChange={() => view.setValue(choice)} />
          <span className="settings-goals-view__preview" aria-hidden="true" data-view={choice}>{choice === 'list' ? <List size={22} /> : <Columns3 size={22} />}</span>
          <span>{choice === 'list' ? 'List' : 'Board'}</span>
        </label>)}
      </fieldset>
      <label className="browser-automation-toggle"><input type="checkbox" checked={finished.value} onChange={event => finished.setValue(event.target.checked)} aria-label="Show finished goals by default" />
        <span><strong>Show finished goals by default</strong><small>Include Done and Cancelled goals when you open a new view.</small></span>
      </label>
    </section>
    <section className="settings-group">
      <header><span>Common actions</span><small>Saved: {saved ? 'Collapsed' : 'Expanded'}</small></header>
      <label className="browser-automation-toggle"><input type="checkbox" checked={draft.value} onChange={event => draft.setValue(event.target.checked)} aria-label="Collapse common actions" />
        <span><strong>Start with common actions collapsed</strong><small>Keep Goals focused on your work. Expand common actions whenever you need them.</small></span>
      </label>
    </section>
    <div className="settings-workflows__inline-action"><p className="settings-workflows__note">Choose, reorder and edit common actions directly in Goals. They use the same Prompts library.</p>
      <button type="button" className="small-button" onClick={onOpenGoals}>Open Goals</button>
    </div>
    <SettingsSaveBar save={saveState} dirty={draft.dirty || view.dirty || finished.dirty} onSave={() => void save()} />
  </div>
}
