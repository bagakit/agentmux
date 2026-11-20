import { NativeSelect, TextInput } from '@agentmux/client-ui/input'
import {
  GOAL_WORKFLOW_TEMPLATE_IDS, GOAL_WORKFLOW_TEMPLATES, isGoalWorkflowAddressPart, resolveGoalWorkflowPreferences,
  resolveGoalWorkflowReviewer, type GoalWorkflowTemplateId, type ResolvedGoalWorkflowPreferences
} from '@agentmux/host/goals-preferences'
import type { AppConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import './goal-workflows-settings.css'

const edit = (value: ResolvedGoalWorkflowPreferences) =>
  ({ ...value, maxConcurrent: String(value.maxConcurrent), maxAttempts: String(value.maxAttempts) })
type WorkflowDraft = ReturnType<typeof edit>
const count = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
const setting = (draft: WorkflowDraft, maxConcurrent: number, maxAttempts: number): ResolvedGoalWorkflowPreferences =>
  ({ ...draft, maxConcurrent, maxAttempts })

export function GoalWorkflowsSettingsPane({ config, onSave }: {
  config: AppConfig
  onSave(value: ResolvedGoalWorkflowPreferences, expected: ResolvedGoalWorkflowPreferences): Promise<void>
}) {
  const saved = resolveGoalWorkflowPreferences(config.goals?.workflow)
  const draft = useSettingDraftRecord({ workflow: edit(saved) }, configValuesEqual), saveState = useSettingsSave()
  const value = draft.value.workflow
  const patch = (fields: Partial<WorkflowDraft>) => draft.setField('workflow', { ...value, ...fields })
  const hosts = config.hosts
  const savedReviewer = resolveGoalWorkflowReviewer(saved)
  const reviewer = Boolean(value.reviewerRuntimeId || value.reviewerSessionId)
  const concurrent = count(value.maxConcurrent), attempts = count(value.maxAttempts)
  const reviewerInvalid = reviewer && !resolveGoalWorkflowReviewer(value)
  const blocked = reviewerInvalid ? 'Enter the exact Host, Runtime and Session IDs, or clear both reviewer IDs.'
    : concurrent === undefined || attempts === undefined ? 'Enter whole numbers for both limits. Use 0 for unlimited.' : undefined
  const template = GOAL_WORKFLOW_TEMPLATES[value.template]

  async function save() {
    if (blocked || concurrent === undefined || attempts === undefined) return
    const submitted = draft.beginSave()
    const baseline = submitted.expected.workflow
    submitted.finish(await saveState.run(() => onSave(setting(submitted.value.workflow, concurrent, attempts),
      setting(baseline, Number(baseline.maxConcurrent), Number(baseline.maxAttempts)))))
  }

  return <div className="settings-pane-stack goal-workflows-settings" data-settings-field="goal-workflows">
    <section className="settings-group">
      <header><span>Planning template</span><small>Saved: {GOAL_WORKFLOW_TEMPLATES[saved.template].title}</small></header>
      <label className="goal-workflow-row" data-settings-field="goal-workflow-template">
        <span><strong>Default template</strong><small>{template.description}</small></span>
        <NativeSelect aria-label="Default workflow template" value={value.template} onChange={event => patch({ template: event.target.value as GoalWorkflowTemplateId })}>
          {GOAL_WORKFLOW_TEMPLATE_IDS.map(id => <option key={id} value={id}>{GOAL_WORKFLOW_TEMPLATES[id].title}</option>)}
        </NativeSelect>
      </label>
      <p className="settings-workflows__note">Used when preparing a new plan. The Supervisor still publishes the plan in the Goal.</p>
    </section>
    <section className="settings-group" data-settings-field="goal-workflow-reviewer">
      <header><span>Independent review</span><small>{savedReviewer && saved.template !== 'off' ? 'Reviewer saved' : 'Manual review'}</small></header>
      <p className="settings-workflows__note">Choose a separate Agent to check collected Ticket deliveries. Use the identities reported by the original reviewer Host and Session.</p>
      <label className="goal-workflow-row"><span><strong>Reviewer Host</strong></span>
        <NativeSelect aria-label="Reviewer Host" value={value.reviewerHostId}
          onChange={event => patch({ reviewerHostId: event.target.value, reviewerRuntimeId: '', reviewerSessionId: '' })}>
          {!hosts.some(host => host.id === value.reviewerHostId) ? <option value={value.reviewerHostId}>{value.reviewerHostId}</option> : null}
          {hosts.map(host => <option key={host.id} value={host.id}>{host.label}</option>)}
        </NativeSelect>
      </label>
      <label className="goal-workflow-row"><span><strong>Reviewer Runtime ID</strong></span>
        <TextInput className="goal-workflow-identity" aria-label="Reviewer Runtime ID" value={value.reviewerRuntimeId} placeholder="Original Runtime ID"
          onChange={event => patch({ reviewerRuntimeId: event.target.value })} aria-invalid={reviewer && !isGoalWorkflowAddressPart(value.reviewerRuntimeId)} />
      </label>
      <label className="goal-workflow-row"><span><strong>Reviewer Session ID</strong></span>
        <TextInput className="goal-workflow-identity" aria-label="Reviewer Session ID" value={value.reviewerSessionId} placeholder="Original Agent Session ID"
          onChange={event => patch({ reviewerSessionId: event.target.value })} aria-invalid={reviewer && !isGoalWorkflowAddressPart(value.reviewerSessionId)} />
      </label>
      <p className="settings-workflows__note">{value.template === 'off' ? 'Choose a template to use this reviewer. ' : ''}Clear both IDs to use manual review. Prepared reviews stay with their original Session.</p>
    </section>
    <section className="settings-group" data-settings-field="goal-workflow-budget">
      <header><span>Automatic dispatch limits</span><small>0 means unlimited</small></header>
      <label className="goal-workflow-row goal-workflow-row--number">
        <span><strong>Concurrent dispatches</strong><small>Maximum Ticket attempts awaiting a report in one Goal continuation.</small></span>
        <TextInput aria-label="Concurrent dispatches" inputMode="numeric" value={value.maxConcurrent} aria-invalid={concurrent === undefined}
          onChange={event => patch({ maxConcurrent: event.target.value })} />
      </label>
      <label className="goal-workflow-row goal-workflow-row--number">
        <span><strong>New attempts</strong><small>Maximum new Ticket attempts admitted in one Goal continuation.</small></span>
        <TextInput aria-label="New attempts" inputMode="numeric" value={value.maxAttempts} aria-invalid={attempts === undefined}
          onChange={event => patch({ maxAttempts: event.target.value })} />
      </label>
    </section>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} blocked={blocked} resolution={draft}
      scopeLabel="Workflow settings" label="Save workflow settings" onSave={() => void save()} />
  </div>
}
