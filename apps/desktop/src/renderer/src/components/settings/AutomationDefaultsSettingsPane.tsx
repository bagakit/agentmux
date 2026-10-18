import { DEFAULT_AUTOMATION_PREFERENCES as _batchAutomationDefaults } from '../../../../shared/automation-preferences'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { useId } from 'react'
import { resolveAutomationPreferences, validateAutomationPreferences, type AutomationDefaults, type AutomationPreferences } from '../../../../shared/automation-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import '../../styles/settings-continuity.css'
import './settings-automation.css'

export const AUTOMATION_DEFAULTS_SEARCH_TARGETS = [
  { id: 'progressIntervalMs', title: 'Default progress interval', keywords: 'periodic minutes check interval 周期 持续推进' },
  { id: 'progressPrompt', title: 'Default progress prompt', keywords: 'periodic continuation instruction 提示词' },
  { id: 'calendarTimezone', title: 'Default arrangement timezone', keywords: 'calendar system IANA local 时区 安排' },
  { id: 'checkInQuietStart', title: 'Quiet period starts', keywords: 'follow-up quiet start 静默' },
  { id: 'checkInQuietEnd', title: 'Quiet period ends', keywords: 'follow-up quiet end 静默' },
  { id: 'checkInSilenceMs', title: 'Minimum silence before follow-up', keywords: 'quiet follow-up hours 沉默' },
  { id: 'checkInMinIntervalMs', title: 'Minimum follow-up interval', keywords: 'quiet follow-up hours 间隔' },
  { id: 'checkInDailyBudget', title: 'Daily follow-up budget', keywords: 'quiet follow-up local day attempts 每日 预算' }
] as const

export function automationDefaultsSavedSummary(preferences?: AutomationPreferences): string {
  const saved = resolveAutomationPreferences(preferences)
  return `${saved.progressIntervalMs / 60_000} min · ${saved.calendarTimezone || 'System timezone'}`
}
const units = { progressIntervalMs: 60_000, checkInSilenceMs: 3_600_000, checkInMinIntervalMs: 3_600_000 } as const
function editValue(value: AutomationDefaults) {
  return { ...value, progressIntervalMs: String(value.progressIntervalMs / units.progressIntervalMs),
    checkInSilenceMs: String(value.checkInSilenceMs / units.checkInSilenceMs),
    checkInMinIntervalMs: String(value.checkInMinIntervalMs / units.checkInMinIntervalMs), checkInDailyBudget: String(value.checkInDailyBudget) }
}
function policyValue(value: ReturnType<typeof editValue>): AutomationDefaults {
  const duration = (key: keyof typeof units) => /^\d+(\.\d+)?$/.test(value[key]) ? Math.round(Number(value[key]) * units[key]) : NaN
  const parsed = { ...value, progressIntervalMs: duration('progressIntervalMs'), checkInSilenceMs: duration('checkInSilenceMs'),
    checkInMinIntervalMs: duration('checkInMinIntervalMs'), checkInDailyBudget: /^\d+$/.test(value.checkInDailyBudget) ? Number(value.checkInDailyBudget) : NaN }
  validateAutomationPreferences(parsed)
  return parsed
}

export function AutomationDefaultsSettingsPane({ preferences, onSave }: {
  preferences: AutomationPreferences | undefined
  onSave(value: AutomationDefaults, expected: AutomationDefaults): Promise<void>
}) {
  const saved = resolveAutomationPreferences(preferences), draft = useSettingDraftRecord(editValue(saved)), save = useSettingsSave(), id = useId()
  let issue = '', parsed: AutomationDefaults | undefined
  try { parsed = policyValue(draft.value) } catch (error) { issue = error instanceof Error ? error.message : 'Review your automation defaults.' }
  const number = (key: keyof typeof units | 'checkInDailyBudget', label: string, unit: string, hint: string) => <div className="continuity-setting-row" data-settings-field={key}>
    <label htmlFor={`${id}-${key}`}><strong>{label}</strong><small>{hint}</small></label>
    <div className="continuity-number"><TextInput id={`${id}-${key}`} aria-label={label} inputMode={key === 'checkInDailyBudget' ? 'numeric' : 'decimal'}
      value={draft.value[key]} onChange={event => draft.setField(key, event.target.value)} /><span>{unit}</span></div>
  </div>
  async function commit() {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(policyValue(submitted.value), policyValue(submitted.expected))))
  }
  return <div className="settings-pane-stack continuity-settings automation-defaults">
    <div className="automation-defaults-heading"><h3>New task defaults</h3><p className="continuity-scope">Starting values for new tasks. Existing tasks and edited drafts keep their choices.</p></div>
    <section className="settings-group"><header><span>Progress tasks</span><small>Saved: {saved.progressIntervalMs / 60_000} minutes</small></header>
      {number('progressIntervalMs', 'Default progress interval', 'minutes', 'Built-in default: 30 minutes. At least one minute.')}
      <details className="continuity-disclosure automation-prompt-disclosure" data-settings-field="progressPrompt">
        <summary><span>Default progress prompt<small>{draft.value.progressPrompt.trim() ? 'Custom instruction for new progress tasks' : 'Optional · starts blank'}</small></span></summary>
        <div className="automation-defaults-prompt">
          <label htmlFor={`${id}-prompt`}><small>Review this instruction when creating each task.</small></label>
          <ComposerTextarea id={`${id}-prompt`} aria-label="Default progress prompt" rows={3} value={draft.value.progressPrompt} onValueChange={value => draft.setField('progressPrompt', value)} />
        </div>
      </details>
    </section>
    <section className="settings-group"><header><span>Calendar arrangements</span><small>Saved: {saved.calendarTimezone || 'System timezone'}</small></header>
      <div className="continuity-setting-row" data-settings-field="calendarTimezone"><label htmlFor={`${id}-timezone`}><strong>Default arrangement timezone</strong><small>Blank uses the system timezone when a new form opens. Or enter an IANA name, such as Asia/Shanghai.</small></label>
        <TextInput id={`${id}-timezone`} aria-label="Default arrangement timezone" placeholder="System timezone" value={draft.value.calendarTimezone} onChange={event => draft.setField('calendarTimezone', event.target.value)} /></div>
    </section>
    <details className="continuity-disclosure" data-automation-quiet-defaults>
      <summary><span>Quiet follow-up<small>Only used when you enable it for a new arrangement</small></span><span className="continuity-disclosure-value">Saved: {saved.checkInDailyBudget} per day</span></summary>
      <div className="continuity-disclosure-body">
      <p className="continuity-hint">Used only when you enable quiet follow-up on a new arrangement. Quiet hours use that arrangement’s timezone.</p>
      {(['checkInQuietStart', 'checkInQuietEnd'] as const).map(key => <div className="continuity-setting-row" data-settings-field={key} key={key}><label htmlFor={`${id}-${key}`}><strong>{key === 'checkInQuietStart' ? 'Quiet period starts' : 'Quiet period ends'}</strong><small>Built-in default: {_batchAutomationDefaults[key]}.</small></label>
        <TextInput id={`${id}-${key}`} aria-label={key === 'checkInQuietStart' ? 'Quiet period starts' : 'Quiet period ends'} type="time" value={draft.value[key]} onChange={event => draft.setField(key, event.target.value)} /></div>)}
      {number('checkInSilenceMs', 'Minimum silence before follow-up', 'hours', 'Built-in default: 18 hours. Choose a duration from 5 minutes to 30 days.')}
      {number('checkInMinIntervalMs', 'Minimum follow-up interval', 'hours', 'Built-in default: 20 hours. Choose a duration from 5 minutes to 30 days.')}
      {number('checkInDailyBudget', 'Daily follow-up budget', 'attempts', 'Built-in default: 1 attempt per local day. Choose 1 to 3.')}
      {parsed && <aside className="automation-policy-example" aria-label="Quiet follow-up example">
        <header><strong>When a follow-up can happen</strong><small>Draft example</small></header>
        <p>At a scheduled check, all of these conditions must be met:</p>
        <dl>
          <div><dt>Wait for silence</dt><dd>At least <strong>{parsed.checkInSilenceMs / 3_600_000} hours</strong> after your last confirmed message.</dd></div>
          <div><dt>Respect quiet hours</dt><dd>No question from <strong>{parsed.checkInQuietStart} to {parsed.checkInQuietEnd}</strong>, in the arrangement’s timezone.</dd></div>
          <div><dt>Space out attempts</dt><dd>At least <strong>{parsed.checkInMinIntervalMs / 3_600_000} hours</strong> after the previous attempt, with at most <strong>{parsed.checkInDailyBudget} {parsed.checkInDailyBudget === 1 ? 'attempt' : 'attempts'} per local day</strong>.</dd></div>
        </dl>
        <p className="continuity-hint">Another question also needs a confirmed reply from you. These are defaults for arrangements where you enable quiet follow-up; this example schedules and sends nothing.</p>
      </aside>}
      </div>
    </details>
    <p className="automation-save-scope">Saves progress, calendar and quiet follow-up defaults. Creates no task and sends no message.</p>
    {!!issue && <p className="settings-inline-error" role="alert">{issue}</p>}
    <SettingsSaveBar save={save} dirty={draft.dirty} disabled={!!issue} label="Save task defaults" onSave={() => void commit()} />
  </div>
}
