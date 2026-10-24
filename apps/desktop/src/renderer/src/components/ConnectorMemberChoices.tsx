import type { ConnectionGrant } from '@agentmux/core/connections'

/** Editing choices is not authorization; callers retain the original draft and public request. */
export function ConnectorMemberChoices({ name, value, change, scope, disabled = false }: {
  name: string
  value: ConnectionGrant['capabilities']
  change(capability: ConnectionGrant['capabilities'][number], enabled: boolean): void
  scope: 'group' | 'application'
  disabled?: boolean
}) {
  return <>
    <fieldset className="connector-member-row__choices" disabled={disabled}>
      <label><input type="checkbox" aria-label={`Send requests for ${name}`} checked={value.includes('input')} onChange={event => change('input', event.target.checked)} />Send requests</label>
      <label><input type="checkbox" aria-label={`Answer questions for ${name}`} checked={value.includes('answer')} onChange={event => change('answer', event.target.checked)} />Answer questions</label>
      <label><input type="checkbox" aria-label={`Allow permission decisions for ${name}`} checked={value.includes('permission')} onChange={event => change('permission', event.target.checked)} />Permission decisions</label>
    </fieldset>
    {value.includes('permission') ? <p className="agent-connector-note">{scope === 'application' ? 'Permission requests and limited tool details are shared with this bot’s current and future groups.' : 'Permission requests and limited tool details are shared with this group.'} Only an effectively authorized person can decide.</p> : <details className="agent-connector-disclosure"><summary>Permission context</summary><p className="agent-connector-note">{scope === 'application' ? 'All current and future groups using this bot may receive the limited original permission request and tool details.' : 'This group receives the original request and tool details.'} Requests and answers do not grant this control.</p></details>}
  </>
}
