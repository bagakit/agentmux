import { DEFAULT_AGENT_CONTINUITY_CONTINUATION, DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-continuity'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { continuationSettings, type ContinuationSettings } from './continuity-settings-fields'
import '../../styles/settings-continuity.css'

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
  return <section className="settings-group continuity-settings" data-continuity-interruption-settings>
    <header><span>Continue interrupted work</span><small>After native recovery</small></header>
    <label className="browser-automation-toggle" data-settings-field="continuationEnabled"><input type="checkbox" aria-label="Continue interrupted work after recovery" checked={draft.value.continuationEnabled} onChange={event => draft.setField('continuationEnabled', event.target.checked)} />
      <span><strong>Continue interrupted work after recovery</strong><small>After the same conversation is restored, send the fixed continuation only when the previous work was interrupted. Healthy reconnects send nothing.</small>{facts('continuationEnabled')}</span></label>
    <label className="browser-automation-toggle" data-settings-field="activeInterruptionFallback"><input type="checkbox" aria-label="Use active state when interruption detection is unsupported" checked={draft.value.activeInterruptionFallback} onChange={event => draft.setField('activeInterruptionFallback', event.target.checked)} />
      <span><strong>Use active state when interruption detection is unsupported</strong><small>Only when the Provider cannot detect interruptions, treat the main session’s active state before exit as interrupted. A Provider that supports detection but reports an unknown result never uses this fallback.</small>{facts('activeInterruptionFallback')}</span></label>
    <details className="continuity-preview" aria-label="Recovery delivery preview">
      <summary>Continuation preview</summary>
      <p className="continuity-hint">{draft.value.continuationEnabled ? 'Interrupted work receives one fixed continuation after native recovery succeeds:' : 'Automatic continuation is off. No continuation is sent after recovery.'}</p>
      {draft.value.continuationEnabled && <pre data-continuity-continuation-preview>{DEFAULT_AGENT_CONTINUITY_CONTINUATION}</pre>}
      <p className="continuity-hint">The continuation may open one new model turn. Unknown earlier input is never replayed. Saving these preferences starts no recovery and sends nothing.</p>
    </details>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </section>
}
