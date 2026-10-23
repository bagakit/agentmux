import { agentContinuityRetryBaseDelay, DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { TextInput } from '@agentmux/client-ui/input'
import { useId, useState, type ReactNode } from 'react'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { executionSettings, type ExecutionSettings } from './continuity-settings-fields'
import '../../styles/settings-continuity.css'
import './settings-recovery.css'
import { readableSettingsDuration as readableDuration, settingsDurationSeconds as seconds } from './settings-duration'

const defaults = DEFAULT_AGENT_CONTINUITY_POLICY
function milliseconds(value: string): number {
  if (!/^\d+(\.\d{1,3})?$/.test(value)) return NaN
  const [whole = '0', fraction = ''] = value.split('.')
  const parsed = Number(BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0')))
  return Number.isSafeInteger(parsed) ? parsed : NaN
}
const durationUnits = { seconds: 1000, minutes: 60_000, hours: 3_600_000 } as const
type DurationUnit = keyof typeof durationUnits
function initialDurationUnit(value: number): DurationUnit {
  return value >= durationUnits.hours && value % durationUnits.hours === 0 ? 'hours'
    : value >= durationUnits.minutes && value % durationUnits.minutes === 0 ? 'minutes' : 'seconds'
}
function displayDuration(value: number, unit: DurationUnit): { text: string; approximate: boolean } {
  if (!Number.isSafeInteger(value) || value < 0) return { text: '', approximate: false }
  const divisor = BigInt(durationUnits[unit]), precision = 1_000_000_000n
  const scaled = BigInt(value) * precision
  const approximate = scaled % divisor !== 0n
  const digits = (scaled + divisor / 2n) / divisor
  const fraction = String(digits % precision).padStart(9, '0').replace(/0+$/, '')
  return { text: `${digits / precision}${fraction ? `.${fraction}` : ''}`, approximate }
}
function parseDuration(text: string, unit: DurationUnit): number {
  if (!/^\d+(\.\d{1,9})?$/.test(text)) return NaN
  const [whole = '0', fraction = ''] = text.split('.')
  const scale = 10n ** BigInt(fraction.length)
  const numerator = (BigInt(whole) * scale + BigInt(fraction || '0')) * BigInt(durationUnits[unit])
  if (numerator % scale !== 0n) return NaN
  const value = Number(numerator / scale)
  return Number.isSafeInteger(value) ? value : NaN
}
function DurationSettingInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange(value: string): void }) {
  const canonical = milliseconds(value)
  const [unit, setUnit] = useState<DurationUnit>(() => initialDurationUnit(canonical))
  const [entry, setEntry] = useState<{ canonical: string; text: string; unit: DurationUnit } | null>(null)
  const display = displayDuration(canonical, unit)
  const authored = entry?.canonical === value && entry.unit === unit
  const text = authored ? entry.text : display.text
  const approximate = !authored && display.approximate
  const valid = Number.isSafeInteger(canonical)
  return <div className="continuity-duration">
    <div className="continuity-number continuity-duration-editor">
      <TextInput id={id} aria-label={label} aria-describedby={`${id}-value`} inputMode="decimal" value={text} aria-invalid={!valid}
        onChange={event => {
          const parsed = parseDuration(event.target.value, unit)
          const next = Number.isSafeInteger(parsed) ? seconds(parsed) : `invalid:${unit}:${event.target.value}`
          setEntry({ canonical: next, text: event.target.value, unit })
          onChange(next)
        }} />
      <select aria-label={`${label} unit`} value={unit} onChange={event => {
        const next = event.target.value as DurationUnit
        setUnit(next)
        setEntry(valid ? null : { canonical: value, text, unit: next })
      }}>{Object.keys(durationUnits).map(value => <option key={value} value={value}>{value}</option>)}</select>
    </div>
    <output id={`${id}-value`} className="continuity-duration-summary" htmlFor={id}>
      {valid ? approximate ? `≈ ${text} ${unit} · Exact: ${value} seconds` : readableDuration(canonical) : 'Use a duration with whole millisecond precision'}
    </output>
  </div>
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

function RetryExample({ policy }: { policy: ExecutionSettings }) {
  const count = Math.min(policy.retryMaxAttempts, 6)
  return <aside className="recovery-policy-example" aria-label="Recovery retry example">
    <header><strong>After a failed recovery</strong><small>Draft example</small></header>
    {count === 0 ? <p>Automatic retries are off. The original Session remains available for manual recovery.</p> : <>
      <p>Each additional retry waits after the previous failure. Earlier input is never replayed.</p>
      <ol>{Array.from({ length: count }, (_, index) => <li key={index}><span>Retry {index + 1}</span><strong>{readableDuration(agentContinuityRetryBaseDelay(policy, index + 1))}</strong></li>)}</ol>
      <p className="continuity-hint">{count < policy.retryMaxAttempts ? `First ${count} of ${policy.retryMaxAttempts} retries shown. ` : ''}Base waits double up to {readableDuration(policy.retryMaxDelayMs)}. Confirmed process-exit retries add up to 25% of the base, capped at one second; frontend reconnection uses the base alone.</p>
      <p>If recovery still fails after {policy.retryMaxAttempts} {policy.retryMaxAttempts === 1 ? 'retry' : 'retries'}, automatic retries pause. You can still resume the original Session.</p>
    </>}
  </aside>
}

export function ContinuitySettingsPane({ preferences, onSave }: {
  preferences: Partial<AgentMuxContinuityPolicy> | undefined
  onSave(value: ExecutionSettings, expected: ExecutionSettings): Promise<void>
}) {
  const saved = normalizeAgentContinuityPolicy(preferences), draft = useSettingDraftRecord(editValue(saved)), saveState = useSettingsSave(), id = useId()
  const source = (key: keyof AgentMuxContinuityPolicy) => Object.hasOwn(preferences ?? {}, key) ? 'Custom saved value' : 'Built-in default'
  const duration = (key: 'activeRecoveryDelayMs' | 'confirmedIdleWindowMs' | 'recheckIntervalMs' | 'retryInitialDelayMs' | 'retryMaxDelayMs', label: string, hint: ReactNode) => <div className="continuity-setting-row" data-settings-field={key}>
    <label htmlFor={`${id}-${key}`}><strong>{label}</strong><small>{hint}</small></label>
    <DurationSettingInput id={`${id}-${key}`} label={label} value={draft.value[key]} onChange={value => draft.setField(key, value)} />
  </div>
  let parsed: ExecutionSettings | undefined
  try { parsed = policyValue(draft.value) } catch { /* The original form reports invalid drafts below. */ }
  const valid = parsed !== undefined
  async function save() {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(async () => {
      if (!valid) throw new Error('Use nonnegative durations with whole millisecond precision, and whole-number counts. Values must fit a safe integer in milliseconds, and the maximum retry base delay must be at least the initial retry base delay.')
      await onSave(policyValue(submitted.value), policyValue(submitted.expected))
    }))
  }
  return <div className="settings-pane-stack continuity-settings recovery-settings">
    <section className="settings-group">
      <header><span>Session recovery</span><small>Saved: {saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'}</small></header>
      <fieldset className="recovery-mode" data-settings-field="activeRecovery">
        <legend>Automatic native recovery</legend>
        <div className="recovery-mode-options">
          <label><input type="radio" name={`${id}-recovery`} value="automatic" checked={draft.value.activeRecovery === 'automatic'} onChange={() => draft.setField('activeRecovery', 'automatic')} />
            <span><strong>Automatic</strong><small>Resume eligible ended or missing sessions.</small></span></label>
          <label><input type="radio" name={`${id}-recovery`} value="manual" checked={draft.value.activeRecovery === 'manual'} onChange={() => draft.setField('activeRecovery', 'manual')} />
            <span><strong>On demand</strong><small>Wait for your next request or Resume.</small></span></label>
        </div>
      </fieldset>
      <p className="recovery-mode-effect" role="status">{draft.value.activeRecovery === 'automatic'
        ? 'Automatic recovery uses the timing and exit preferences below.'
        : 'Recovery waits for you. The timing and exit preferences below are kept for automatic mode.'} Healthy Runs reconnect in either mode.</p>
      <div className="recovery-timing">
        {duration('activeRecoveryDelayMs', 'Recovery wait', 'Wait after the recovery decision. Zero starts immediately.')}
        {duration('confirmedIdleWindowMs', 'Automatic recovery window', 'Recover recent sessions automatically; older or unknown activity stays on demand.')}
      </div>
      <label className="browser-automation-toggle" data-settings-field="resumeAfterExit"><input type="checkbox" aria-label="Resume after confirmed exit" checked={draft.value.resumeAfterExit} onChange={event => draft.setField('resumeAfterExit', event.target.checked)} />
        <span><strong>Resume after confirmed exit</strong><small>Allow automatic recovery when Core confirms a Run ended or is missing. Manual Resume stays available.</small></span></label>
    </section>
    <details className="continuity-disclosure" data-continuity-retry-settings>
      <summary><span>Retry a failed recovery<small>Restore the same conversation without replaying input</small></span><span className="continuity-disclosure-value">Saved: {saved.retryMaxAttempts} retries</span></summary>
      <div className="continuity-disclosure-body">
      <p className="continuity-hint">Retry only a confirmed failed recovery, without resending earlier input. Healthy or unconfirmed processes are not restarted.</p>
      {duration('retryInitialDelayMs', 'First retry base delay', 'Later base delays double up to the configured maximum.')}
      {duration('retryMaxDelayMs', 'Maximum retry base delay', 'Upper limit before the small scheduling offset described below.')}
      <div className="continuity-setting-row" data-settings-field="retryMaxAttempts"><label htmlFor={`${id}-retries`}><strong>Additional retries</strong><small>Attempts after the initial recovery. Zero disables automatic retries. Reaching the limit pauses recovery and keeps the original Session available.</small></label>
        <TextInput id={`${id}-retries`} className="continuity-count" aria-label="Additional retries" inputMode="numeric" value={draft.value.retryMaxAttempts}
          aria-invalid={!/^\d+$/.test(draft.value.retryMaxAttempts) || !Number.isSafeInteger(Number(draft.value.retryMaxAttempts))} onChange={event => draft.setField('retryMaxAttempts', event.target.value)} /></div>
      {parsed && <RetryExample policy={parsed} />}
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
      {parsed && <aside className="recovery-policy-example" aria-label="Recovery recheck example">
        <header><strong>Check the same operation</strong><small>Draft example</small></header>
        <p>{parsed.recheckMaxAttempts === 0 ? 'No automatic follow-up checks.' : `Up to ${parsed.recheckMaxAttempts} follow-up ${parsed.recheckMaxAttempts === 1 ? 'check' : 'checks'}, ${readableDuration(parsed.recheckIntervalMs)} apart.`} A check reads the original recovery result. It does not start a new attempt or resend input.</p>
        <p className="continuity-hint">If the result is still unknown, the original operation stays available for inspection or an explicit retry.</p>
      </aside>}
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
    <details className="continuity-disclosure recovery-behavior">
      <summary><span>When these preferences apply<small>New recovery decisions on this desktop</small></span></summary>
      <div className="continuity-disclosure-body">
        <p className="continuity-hint">The automatic recovery window is measured from the previous main session’s confirmed activity or idle start. Older or unknown activity stays on demand. Turning off resume after confirmed exit keeps manual Resume available.</p>
        <p className="continuity-hint">Changes apply to new recovery intents. Current recovery, inputs and drafts stay unchanged. Saving preferences starts no Agent and sends no message.</p>
      </div>
    </details>
    {!valid && <p className="settings-inline-error" role="alert">Enter nonnegative durations with whole millisecond precision and whole-number counts within the safe integer range. The maximum retry base delay must be at least the initial retry base delay.</p>}
    <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save recovery preferences" onSave={() => void save()} disabled={!valid} />
  </div>
}
