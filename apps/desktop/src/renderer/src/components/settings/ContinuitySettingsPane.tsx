import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-continuity'
import { TextInput } from '@agentmux/client-ui/input'
import { useId, type ReactNode } from 'react'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { executionSettings, type ExecutionSettings } from './continuity-settings-fields'
import '../../styles/settings-continuity.css'

const defaults = DEFAULT_AGENT_CONTINUITY_POLICY
function readableDuration(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return 'Enter a valid duration'
  if (value === 0) return 'No delay'
  const hours = Math.floor(value / 3_600_000), minutes = Math.floor((value % 3_600_000) / 60_000), remainder = value % 60_000
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : '', remainder ? `${seconds(remainder)} ${remainder === 1000 ? 'second' : 'seconds'}` : ''].filter(Boolean).join(' ')
}
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
  return { ...executionSettings(policy), activeRecoveryDelayMs: seconds(policy.activeRecoveryDelayMs), confirmedIdleWindowMs: seconds(policy.confirmedIdleWindowMs),
    recheckIntervalMs: seconds(policy.recheckIntervalMs), recheckMaxAttempts: String(policy.recheckMaxAttempts),
    retryInitialDelayMs: seconds(policy.retryInitialDelayMs), retryMaxDelayMs: seconds(policy.retryMaxDelayMs), retryMaxAttempts: String(policy.retryMaxAttempts) }
}
function policyValue(value: ReturnType<typeof editValue>): ExecutionSettings {
  return executionSettings(normalizeAgentContinuityPolicy({ ...value, activeRecoveryDelayMs: milliseconds(value.activeRecoveryDelayMs),
    confirmedIdleWindowMs: milliseconds(value.confirmedIdleWindowMs), recheckIntervalMs: milliseconds(value.recheckIntervalMs),
    recheckMaxAttempts: /^\d+$/.test(value.recheckMaxAttempts) ? Number(value.recheckMaxAttempts) : NaN,
    retryInitialDelayMs: milliseconds(value.retryInitialDelayMs), retryMaxDelayMs: milliseconds(value.retryMaxDelayMs),
    retryMaxAttempts: /^\d+$/.test(value.retryMaxAttempts) ? Number(value.retryMaxAttempts) : NaN }))
}

export function ContinuitySettingsPane({ preferences, onSave }: {
  preferences: Partial<AgentMuxContinuityPolicy> | undefined
  onSave(value: ExecutionSettings, expected: ExecutionSettings): Promise<void>
}) {
  const saved = normalizeAgentContinuityPolicy(preferences), draft = useSettingDraftRecord(editValue(saved)), saveState = useSettingsSave(), id = useId()
  const source = (key: keyof AgentMuxContinuityPolicy) => Object.hasOwn(preferences ?? {}, key) ? 'Custom saved value' : 'Built-in default'
  const duration = (key: 'activeRecoveryDelayMs' | 'confirmedIdleWindowMs' | 'recheckIntervalMs' | 'retryInitialDelayMs' | 'retryMaxDelayMs', label: string, hint: ReactNode) => <div className="continuity-setting-row" data-settings-field={key}>
    <label htmlFor={`${id}-${key}`}><strong>{label}</strong><small>{hint}</small></label>
    <div className="continuity-duration"><div className="continuity-number"><TextInput id={`${id}-${key}`} aria-label={label} inputMode="decimal" value={draft.value[key]}
      aria-invalid={!Number.isSafeInteger(milliseconds(draft.value[key]))} onChange={event => draft.setField(key, event.target.value)} /><span>{milliseconds(draft.value[key]) === 1000 ? 'second' : 'seconds'}</span></div>{milliseconds(draft.value[key]) >= 60_000 && <output className="continuity-duration-summary" htmlFor={`${id}-${key}`}>{readableDuration(milliseconds(draft.value[key]))}</output>}</div>
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
  return <div className="settings-pane-stack continuity-settings">
    <p className="continuity-scope">Choose how this desktop restores ended or missing sessions. New recovery intents use these preferences; current recovery, inputs and drafts stay unchanged.</p>
    <section className="settings-group">
      <header><span>Session recovery</span><small>Saved: {saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'}</small></header>
      <div className="continuity-setting-row" data-settings-field="activeRecovery"><label htmlFor={`${id}-active`}><strong>Automatic native recovery</strong><small>Restore ended or missing Runs automatically, or wait until you send a request or choose Resume. Healthy Runs reconnect as usual.</small></label>
        <select id={`${id}-active`} aria-label="Automatic native recovery" value={draft.value.activeRecovery} onChange={event => draft.setField('activeRecovery', event.target.value as AgentMuxContinuityPolicy['activeRecovery'])}>
          <option value="automatic">Automatic</option><option value="manual">On demand</option>
        </select></div>
      {duration('activeRecoveryDelayMs', 'Recovery wait', 'Delay from the recovery decision to automatic resume. Zero starts immediately.')}
      {duration('confirmedIdleWindowMs', 'Automatic recovery window', 'The previous main session’s confirmed activity or idle start must be within this window. Older or unknown activity stays on demand.')}
      <label className="browser-automation-toggle" data-settings-field="resumeAfterExit"><input type="checkbox" aria-label="Resume after confirmed exit" checked={draft.value.resumeAfterExit} onChange={event => draft.setField('resumeAfterExit', event.target.checked)} />
        <span><strong>Resume after confirmed exit</strong><small>Allow automatic native resume after Core confirms the previous Run ended or is missing. Manual Resume stays available when this is off.</small></span></label>
    </section>
    <details className="continuity-disclosure" data-continuity-retry-settings>
      <summary><span>Retry a failed recovery<small>Restore the same conversation without replaying input</small></span><span className="continuity-disclosure-value">Saved: {saved.retryMaxAttempts} retries</span></summary>
      <div className="continuity-disclosure-body">
      <p className="continuity-hint">After a recovery process is confirmed to have failed, another attempt restores the same conversation without resending earlier input. A healthy or unconfirmed process is not restarted.</p>
      {duration('retryInitialDelayMs', 'First retry base delay', 'Wait before retrying a confirmed failed recovery. Later base delays double up to the configured maximum.')}
      {duration('retryMaxDelayMs', 'Maximum retry base delay', 'Upper limit for the base delay. Each schedule adds a small offset of at most one second and at most one quarter of its base delay.')}
      <div className="continuity-setting-row" data-settings-field="retryMaxAttempts"><label htmlFor={`${id}-retries`}><strong>Additional retries</strong><small>Attempts after the initial recovery. Zero disables automatic retries. Reaching the limit pauses recovery and keeps the original Session available.</small></label>
        <TextInput id={`${id}-retries`} className="continuity-count" aria-label="Additional retries" inputMode="numeric" value={draft.value.retryMaxAttempts}
          aria-invalid={!/^\d+$/.test(draft.value.retryMaxAttempts) || !Number.isSafeInteger(Number(draft.value.retryMaxAttempts))} onChange={event => draft.setField('retryMaxAttempts', event.target.value)} /></div>
      </div>
    </details>
    <details className="continuity-disclosure">
      <summary><span>Recheck the same recovery<small>Observe the original operation and its frozen inputs</small></span><span className="continuity-disclosure-value">Saved: {saved.recheckMaxAttempts} checks</span></summary>
      <div className="continuity-disclosure-body">
      <p className="continuity-hint">Rechecks observe the original operation and keep its frozen inputs. Exhausting these checks leaves the original recovery available for an explicit retry.</p>
      <div className="continuity-setting-row" data-settings-field="recheckMaxAttempts"><label htmlFor={`${id}-attempts`}><strong>Recheck count</strong><small>How many follow-up checks to make for the original operation.</small></label>
        <TextInput id={`${id}-attempts`} className="continuity-count" aria-label="Recheck count" inputMode="numeric" value={draft.value.recheckMaxAttempts}
          aria-invalid={!/^\d+$/.test(draft.value.recheckMaxAttempts) || !Number.isSafeInteger(Number(draft.value.recheckMaxAttempts))} onChange={event => draft.setField('recheckMaxAttempts', event.target.value)} /></div>
      {duration('recheckIntervalMs', 'Recheck interval', 'Delay between follow-up observations of the same recovery operation.')}
      </div>
    </details>
    <details className="continuity-disclosure continuity-defaults">
      <summary><span>Defaults &amp; saved sources<small>Reference values for each recovery preference</small></span></summary>
      <dl className="continuity-default-list">
        {([
          ['activeRecovery', 'Recovery mode', defaults.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'],
          ['activeRecoveryDelayMs', 'Recovery wait', readableDuration(defaults.activeRecoveryDelayMs)],
          ['confirmedIdleWindowMs', 'Recovery window', readableDuration(defaults.confirmedIdleWindowMs)],
          ['resumeAfterExit', 'Resume after exit', defaults.resumeAfterExit ? 'On' : 'Off'],
          ['retryInitialDelayMs', 'First retry base delay', readableDuration(defaults.retryInitialDelayMs)],
          ['retryMaxDelayMs', 'Maximum retry base delay', readableDuration(defaults.retryMaxDelayMs)],
          ['retryMaxAttempts', 'Additional retries', String(defaults.retryMaxAttempts)],
          ['recheckMaxAttempts', 'Recheck count', String(defaults.recheckMaxAttempts)],
          ['recheckIntervalMs', 'Recheck interval', readableDuration(defaults.recheckIntervalMs)],
        ] as const).map(([key, label, value]) => <div key={key}><dt>{label}</dt><dd><span>{value}</span><small>{source(key)}</small></dd></div>)}
      </dl>
    </details>
    <p className="continuity-hint">Saving preferences starts no Agent and sends no message.</p>
    {!valid && <p className="settings-inline-error" role="alert">Enter nonnegative seconds (up to millisecond precision) and whole-number counts within the safe integer range. The maximum retry base delay must be at least the initial retry base delay.</p>}
    <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save recovery preferences" onSave={() => void save()} disabled={!valid} />
  </div>
}
