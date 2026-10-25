import { useId } from 'react'
import { DEFAULT_GOALS_COMMON_ACTIONS, GOALS_VIEW_IDS, resolveGoalsPreferences, type GoalsPreferences } from '@agentmux/host/goals-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import { GoalsIntroduction } from './SettingsConceptIntro'
import '../../styles/settings-workflows.css'
import '../../styles/settings-workview-layout.css'


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
  const supervisor = useSettingDraft(savedView.requesterAsSupervisor)
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    const submittedView = view.beginSave(), submittedFinished = finished.beginSave()
    const submittedSupervisor = supervisor.beginSave()
    const committed = await saveState.run(() => onSave(submitted.value, submitted.expected,
      { defaultView: submittedView.value, showFinished: submittedFinished.value, requesterAsSupervisor: submittedSupervisor.value },
      { defaultView: submittedView.expected, showFinished: submittedFinished.expected, requesterAsSupervisor: submittedSupervisor.expected }))
    submitted.finish(committed); submittedView.finish(committed); submittedFinished.finish(committed); submittedSupervisor.finish(committed)
  }
  return <div className="settings-pane-stack settings-goals">
    <GoalsIntroduction />
    <section className="settings-group" data-settings-field="starting-view">
      <header><span>Starting view</span><small>Saved: {savedView.defaultView === 'board' ? 'Board' : 'List'}</small></header>
      <p className="settings-workflows__note">Used when you open a new Goals view. You can still switch views while working.</p>
      <fieldset className="settings-goals-view"><legend>Default Goals view</legend>
        {GOALS_VIEW_IDS.map(choice => <label key={choice} data-selected={view.value === choice}>
          <input type="radio" name={viewGroup} checked={view.value === choice} onChange={() => view.setValue(choice)} />
          <span className="settings-goals-view__preview" aria-hidden="true" data-view={choice}>
            {choice === 'list'
              ? [0, 1, 2].map(item => <span key={item}><i /><b /></span>)
              : [2, 1, 2].map((cards, column) => <span key={column}><b />{Array.from({ length: cards }, (_, card) => <i key={card} />)}</span>)}
          </span>
          <span>{choice === 'list' ? 'List' : 'Board'}</span>
        </label>)}
      </fieldset>
      <label className="browser-automation-toggle" data-settings-field="finished-goals"><input type="checkbox" checked={finished.value} onChange={event => finished.setValue(event.target.checked)} aria-label="Show finished goals by default" />
        <span><strong>Show finished goals by default</strong><small>Include Done and Cancelled goals when you open a new view.</small></span>
      </label>
    </section>
    <section className="settings-group" data-settings-field="goal-supervisor">
      <header><span>Supervisor for new goals</span><small>Saved: {savedView.requesterAsSupervisor ? 'Requester' : 'Choose manually'}</small></header>
      <label className="browser-automation-toggle"><input type="checkbox" checked={supervisor.value} onChange={event => supervisor.setValue(event.target.checked)} aria-label="Use the requesting Agent as Supervisor" />
        <span><strong>Use the requesting Agent as Supervisor</strong><small>The original Agent or PMO becomes Supervisor, assignee and related Session for a new goal. Continue starts separately.</small></span>
      </label>
      <p className="settings-workflows__note">Existing goals and your manual choices stay as saved. Without a confirmed source, choose a Supervisor in the goal.</p>
    </section>
    <section className="settings-group" data-settings-field="common-actions">
      <header><span>Common actions</span><small>Saved: {saved ? 'Collapsed' : 'Expanded'}</small></header>
      <label className="browser-automation-toggle"><input type="checkbox" checked={draft.value} onChange={event => draft.setValue(event.target.checked)} aria-label="Collapse common actions" />
        <span><strong>Start with common actions collapsed</strong><small>Keep Goals focused on your work. Expand common actions whenever you need them.</small></span>
      </label>
      <div className="settings-workflows__inline-action"><p className="settings-workflows__note">Choose, reorder and edit common actions in Goals, using the same Prompts library.</p>
      <button type="button" className="small-button" onClick={onOpenGoals}>Open Goals</button>
      </div>
    </section>
    <SettingsSaveBar save={saveState} dirty={draft.dirty || view.dirty || finished.dirty || supervisor.dirty} onSave={() => void save()} />
  </div>
}
