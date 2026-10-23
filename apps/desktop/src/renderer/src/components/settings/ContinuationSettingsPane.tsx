import { DEFAULT_AGENT_CONTINUITY_CONTINUATION, DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { continuationSettings, type ContinuationSettings } from './continuity-settings-fields'
import '../../styles/settings-continuity.css'
import './settings-automation.css'

export function ContinuationSettingsPane({ preferences, onSave }: {
  preferences: Partial<AgentMuxContinuityPolicy> | undefined
  onSave(value: ContinuationSettings, expected: ContinuationSettings): Promise<void>
}) {
  const draft = useSettingDraftRecord(continuationSettings(normalizeAgentContinuityPolicy(preferences))), saveState = useSettingsSave()
  const facts = (key: keyof ContinuationSettings) => <small className="continuity-field-facts">Default: {DEFAULT_AGENT_CONTINUITY_POLICY[key] ? 'On' : 'Off'} · {Object.hasOwn(preferences ?? {}, key) ? 'Custom saved value' : 'Built-in default'}</small>
  async function save() {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <section className="settings-group continuity-settings continuation-settings" data-continuity-interruption-settings>
    <header><span>After recovery</span><small>Saved: {normalizeAgentContinuityPolicy(preferences).continuationEnabled ? 'Continue interrupted work' : 'No continuation'}</small></header>
    <label className="browser-automation-toggle" data-settings-field="continuationEnabled"><input type="checkbox" aria-label="Continue interrupted work after recovery" checked={draft.value.continuationEnabled} onChange={event => draft.setField('continuationEnabled', event.target.checked)} />
      <span><strong>Continue interrupted work after recovery</strong><small className="continuation-effect" role="status">{draft.value.continuationEnabled ? 'Interrupted work receives one fixed continuation after recovery. Healthy reconnects send nothing.' : 'Recovery restores the conversation without sending a continuation.'}</small>{facts('continuationEnabled')}</span></label>
    <details className="continuity-disclosure continuation-detection">
      <summary><span>Interruption detection<small>Fallback for Providers without interruption detection</small></span></summary>
      <label className="browser-automation-toggle" data-settings-field="activeInterruptionFallback"><input type="checkbox" aria-label="Use active state when interruption detection is unsupported" checked={draft.value.activeInterruptionFallback} onChange={event => draft.setField('activeInterruptionFallback', event.target.checked)} />
      <span><strong>Use active state when interruption detection is unsupported</strong><small>Only when the Provider cannot detect interruptions, treat the main session’s active state before exit as interrupted. A Provider that supports detection but reports an unknown result never uses this fallback.</small>{facts('activeInterruptionFallback')}</span></label>
    </details>
    <details className="continuity-preview" aria-label="Recovery delivery preview">
      <summary>Continuation preview</summary>
      <p className="continuity-hint">{draft.value.continuationEnabled ? 'Interrupted work receives one fixed continuation after native recovery succeeds:' : 'Automatic continuation is off. No continuation is sent after recovery.'}</p>
      {draft.value.continuationEnabled && <pre data-continuity-continuation-preview>{DEFAULT_AGENT_CONTINUITY_CONTINUATION}</pre>}
      <p className="continuity-hint">The continuation may open one new model turn. Unknown earlier input is never replayed. Saving these preferences starts no recovery and sends nothing.</p>
    </details>
    <p className="automation-save-scope">Saves continuation and interruption detection only. Starts no recovery and sends no message.</p>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save continuation" onSave={() => void save()} />
  </section>
}
