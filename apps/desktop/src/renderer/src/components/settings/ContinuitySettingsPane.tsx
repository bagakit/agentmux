import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, resolveAgentContinuityReminder, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-continuity'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { useId, type ReactNode } from 'react'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import '../../styles/settings-continuity.css'

const defaults = DEFAULT_AGENT_CONTINUITY_POLICY
function seconds(milliseconds: number): string {
  const fraction = String(milliseconds % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${Math.floor(milliseconds / 1000)}${fraction ? `.${fraction}` : ''}`
}
function milliseconds(value: string): number {
  if (!/^\d+(\.\d{1,3})?$/.test(value)) return NaN
  const [whole = '0', fraction = ''] = value.split('.')
  const parsed = Number(BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0')))
  return Number.isSafeInteger(parsed) ? parsed : NaN
}
function editValue(policy: AgentMuxContinuityPolicy) {
  return { ...policy, activeRecoveryDelayMs: seconds(policy.activeRecoveryDelayMs), confirmedIdleWindowMs: seconds(policy.confirmedIdleWindowMs),
    recheckIntervalMs: seconds(policy.recheckIntervalMs), recheckMaxAttempts: String(policy.recheckMaxAttempts),
    retryInitialDelayMs: seconds(policy.retryInitialDelayMs), retryMaxDelayMs: seconds(policy.retryMaxDelayMs), retryMaxAttempts: String(policy.retryMaxAttempts) }
}
function policyValue(value: ReturnType<typeof editValue>): AgentMuxContinuityPolicy {
  return normalizeAgentContinuityPolicy({ ...value, activeRecoveryDelayMs: milliseconds(value.activeRecoveryDelayMs),
    confirmedIdleWindowMs: milliseconds(value.confirmedIdleWindowMs), recheckIntervalMs: milliseconds(value.recheckIntervalMs),
    recheckMaxAttempts: /^\d+$/.test(value.recheckMaxAttempts) ? Number(value.recheckMaxAttempts) : NaN,
    retryInitialDelayMs: milliseconds(value.retryInitialDelayMs), retryMaxDelayMs: milliseconds(value.retryMaxDelayMs),
    retryMaxAttempts: /^\d+$/.test(value.retryMaxAttempts) ? Number(value.retryMaxAttempts) : NaN })
}

export function ContinuitySettingsPane({ preferences, onSave }: {
  preferences: Partial<AgentMuxContinuityPolicy> | undefined
  onSave(value: AgentMuxContinuityPolicy, expected: AgentMuxContinuityPolicy): Promise<void>
}) {
  const saved = normalizeAgentContinuityPolicy(preferences), draft = useSettingDraftRecord(editValue(saved)), saveState = useSettingsSave(), id = useId()
  const source = (key: keyof AgentMuxContinuityPolicy) => Object.hasOwn(preferences ?? {}, key) ? 'Custom saved value' : 'Built-in default'
  const facts = (key: keyof AgentMuxContinuityPolicy, defaultLabel: string) => <small className="continuity-field-facts">Default: {defaultLabel} · {source(key)}</small>
  const duration = (key: 'activeRecoveryDelayMs' | 'confirmedIdleWindowMs' | 'recheckIntervalMs' | 'retryInitialDelayMs' | 'retryMaxDelayMs', label: string, hint: ReactNode) => <div className="continuity-setting-row" data-settings-field={key}>
    <label htmlFor={`${id}-${key}`}><strong>{label}</strong><small>{hint}</small>{facts(key, `${seconds(defaults[key])} ${defaults[key] === 1000 ? 'second' : 'seconds'}`)}</label>
    <div className="continuity-number"><TextInput id={`${id}-${key}`} aria-label={label} inputMode="decimal" value={draft.value[key]}
      aria-invalid={!Number.isSafeInteger(milliseconds(draft.value[key]))} onChange={event => draft.setField(key, event.target.value)} /><span>{milliseconds(draft.value[key]) === 1000 ? 'second' : 'seconds'}</span></div>
  </div>
  let valid = true
  try { policyValue(draft.value) } catch { valid = false }
  async function save() {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(async () => {
      if (!valid) throw new Error('Use nonnegative durations with up to three decimal places in seconds, and whole-number counts. Values must fit a safe integer in milliseconds, and the maximum retry base delay must be at least the initial retry base delay.')
      await onSave(policyValue(submitted.value), policyValue(submitted.expected))
    }))
  }
  const reminder = resolveAgentContinuityReminder({ ...saved, reminderMode: draft.value.reminderMode, reminderAppend: draft.value.reminderAppend })
  return <div className="settings-pane-stack continuity-settings">
    <p className="continuity-scope">Applies to new recovery intents across this desktop. Saving preferences starts no Agent and sends no message. Existing recovery intents, inputs and your unsent drafts stay as they are.</p>
    <section className="settings-group">
      <header><span>Recovery timing</span><small>Saved: {saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'}</small></header>
      <div className="continuity-setting-row" data-settings-field="activeRecovery"><label htmlFor={`${id}-active`}><strong>Interrupted active sessions</strong><small>Healthy Runs reconnect. Choose automatic resume, or wait until you send a request or choose Resume.</small>{facts('activeRecovery', defaults.activeRecovery === 'automatic' ? 'Automatic' : 'On demand')}</label>
        <select id={`${id}-active`} aria-label="Interrupted active sessions" value={draft.value.activeRecovery} onChange={event => draft.setField('activeRecovery', event.target.value as AgentMuxContinuityPolicy['activeRecovery'])}>
          <option value="automatic">Automatic</option><option value="manual">On demand</option>
        </select></div>
      {duration('activeRecoveryDelayMs', 'Recovery wait', 'Wait before executing the admitted automatic recovery, measured from the confirmed interruption.')}
      {duration('confirmedIdleWindowMs', 'Authoritative idle window', 'Confirmed idle sessions within this window may resume automatically. Older or unknown idle sessions stay on demand. The default is 24 hours; silence alone never proves idle.')}
      <label className="browser-automation-toggle" data-settings-field="resumeAfterExit"><input type="checkbox" aria-label="Resume after confirmed exit" checked={draft.value.resumeAfterExit} onChange={event => draft.setField('resumeAfterExit', event.target.checked)} />
        <span><strong>Resume after confirmed exit</strong><small>Allow automatic native resume after Core confirms the previous Run ended or is missing. Manual Resume stays available when this is off.</small>{facts('resumeAfterExit', defaults.resumeAfterExit ? 'On' : 'Off')}</span></label>
    </section>
    <section className="settings-group" data-continuity-retry-settings>
      <header><span>Retry a failed recovery</span><small>Context only; no input replay</small></header>
      <p className="continuity-hint">After a recovery process is confirmed to have failed, another attempt restores the same conversation without resending earlier input. A healthy or unconfirmed process is not restarted.</p>
      {duration('retryInitialDelayMs', 'First retry base delay', 'Wait before retrying a confirmed failed recovery. Later base delays double up to the configured maximum.')}
      {duration('retryMaxDelayMs', 'Maximum retry base delay', 'Upper limit for the base delay. Each schedule adds a small offset of at most one second and at most one quarter of its base delay.')}
      <div className="continuity-setting-row" data-settings-field="retryMaxAttempts"><label htmlFor={`${id}-retries`}><strong>Additional retries</strong><small>Attempts after the initial recovery. Zero disables automatic retries. Reaching the limit pauses recovery and keeps the original Session available.</small>{facts('retryMaxAttempts', String(defaults.retryMaxAttempts))}</label>
        <TextInput id={`${id}-retries`} className="continuity-count" aria-label="Additional retries" inputMode="numeric" value={draft.value.retryMaxAttempts}
          aria-invalid={!/^\d+$/.test(draft.value.retryMaxAttempts) || !Number.isSafeInteger(Number(draft.value.retryMaxAttempts))} onChange={event => draft.setField('retryMaxAttempts', event.target.value)} /></div>
    </section>
    <section className="settings-group">
      <header><span>Recheck the same recovery</span><small>No replay of an unknown input</small></header>
      <p className="continuity-hint">Rechecks observe the original operation and keep its frozen inputs. Exhausting these checks leaves the original recovery available for an explicit retry.</p>
      <div className="continuity-setting-row" data-settings-field="recheckMaxAttempts"><label htmlFor={`${id}-attempts`}><strong>Recheck count</strong><small>How many follow-up checks to make for the original operation.</small>{facts('recheckMaxAttempts', String(defaults.recheckMaxAttempts))}</label>
        <TextInput id={`${id}-attempts`} className="continuity-count" aria-label="Recheck count" inputMode="numeric" value={draft.value.recheckMaxAttempts}
          aria-invalid={!/^\d+$/.test(draft.value.recheckMaxAttempts) || !Number.isSafeInteger(Number(draft.value.recheckMaxAttempts))} onChange={event => draft.setField('recheckMaxAttempts', event.target.value)} /></div>
      {duration('recheckIntervalMs', 'Recheck interval', 'Delay between follow-up observations of the same recovery operation.')}
    </section>
    <section className="settings-group">
      <header><span>Recovery reminder</span><small>Independent of continuation</small></header>
      <div className="continuity-setting-row" data-settings-field="reminderMode"><label htmlFor={`${id}-reminder`}><strong>Reminder content</strong><small>For an interrupted working conversation after native resume. Custom text appends to the complete built-in reminder.</small>{facts('reminderMode', 'Built-in reminder')}</label>
        <select id={`${id}-reminder`} aria-label="Recovery reminder" value={draft.value.reminderMode} onChange={event => draft.setField('reminderMode', event.target.value as AgentMuxContinuityPolicy['reminderMode'])}>
          <option value="off">Off</option><option value="default">Built-in reminder</option><option value="default-plus-custom">Built-in + custom</option>
        </select></div>
      {draft.value.reminderMode === 'default-plus-custom' && <label className="continuity-text-field"><strong>Append to the reminder</strong>{facts('reminderAppend', 'Empty')}
        <Textarea aria-label="Append to recovery reminder" rows={4} value={draft.value.reminderAppend} onChange={event => draft.setField('reminderAppend', event.target.value)} /></label>}
      <details className="continuity-preview" open><summary>Complete effective reminder</summary><pre data-continuity-reminder-preview>{reminder || 'No reminder will be sent.'}</pre></details>
    </section>
    <section className="settings-group">
      <header><span>Continue interrupted work</span><small>Independent of the reminder</small></header>
      <label className="browser-automation-toggle" data-settings-field="continuationEnabled"><input type="checkbox" aria-label="Continue interrupted work after recovery" checked={draft.value.continuationEnabled} onChange={event => draft.setField('continuationEnabled', event.target.checked)} />
        <span><strong>Send a continuation after recovery</strong><small>Only for a session authoritatively interrupted while working. Healthy reconnects and idle recovery do not automatically continue.</small>{facts('continuationEnabled', defaults.continuationEnabled ? 'On' : 'Off')}</span></label>
      <label className="continuity-text-field" data-settings-field="continuationPrompt"><strong>Continuation prompt</strong>{facts('continuationPrompt', 'Built-in continuation')}
        <Textarea aria-label="Continuation prompt" rows={4} value={draft.value.continuationPrompt} onChange={event => draft.setField('continuationPrompt', event.target.value)} /></label>
      <details className="continuity-preview"><summary>Complete effective continuation</summary><pre data-continuity-continuation-preview>{draft.value.continuationEnabled ? draft.value.continuationPrompt || 'The prompt is empty; no continuation text is available.' : 'No continuation will be sent.'}</pre></details>
    </section>
    <section className="continuity-delivery-preview" aria-label="Recovery delivery preview">
      <h3>What the initial recovery may send</h3>
      <p>{reminder ? 'Reminder enabled. ' : 'Reminder off. '}{draft.value.continuationEnabled ? 'Continuation enabled. ' : 'Continuation off. '}
        The selected reminder becomes a platform note and joins the continuation prompt. Selected nonempty content is sent in one new input; either part can supply it. If neither part has content, no input is sent.</p>
      <p>The parts remain separately inspectable and share the same original input key and actual transport or delivery receipt. A native launch argument receipt confirms Runtime carriage only; Provider consumption requires separate evidence. This input may use an ordinary User role and open one turn. A native system role is not guaranteed; delivery does not mean the model completed the task.</p>
      <p>Only the initial recovery input carries the selected reminder and continuation. Later supervised retries restore context only; they resend neither these parts nor any earlier input. Saving here sends nothing.</p>
    </section>
    {!valid && <p className="settings-inline-error" role="alert">Enter nonnegative seconds (up to millisecond precision) and whole-number counts within the safe integer range. The maximum retry base delay must be at least the initial retry base delay.</p>}
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} disabled={!valid} />
  </div>
}
