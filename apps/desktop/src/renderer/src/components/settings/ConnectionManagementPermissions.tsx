import type { ConnectionRecord, ConnectionSetupView } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'

type Configuration = Extract<NonNullable<ConnectionSetupView['applicationConfiguration']>, { effect: 'add-application-permissions' }>
const LinkIcon = semanticIconComponent('action.open-external')
/** Safe Host review only. No native permission mapping or lasting scope preference lives in the client. */
export function ConnectionManagementPermissions({ record, model, current, configuration, onConsole, onBack }: {
  record: ConnectionRecord; model: ConnectionManagementModel; current: boolean; configuration: Configuration
  onConsole: () => Promise<void>; onBack: () => void
}) {
  const { busy } = model, { review, selected, unresolved } = configuration
  const add = configuration.actions.find(action => action.kind === 'add-application-permissions')
  const recover = configuration.actions.find(action => action.kind === 'recover-configuration-effect')
  const missing = review?.permissions.filter(permission => permission.state === 'missing').length ?? 0
  const original = unresolved ?? (selected ? { operationId: selected.input.operationId, connectionId: record.config.connectionId, stepId: selected.stepId } : null)
  const select = (stepId: string, operationId?: string) => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'add-application-permissions', purpose: configuration.purpose, selectedStepId: stepId } }, operationId)
  const reviewing = busy && ['read-permission-catalog', 'read-application-permissions', 'recover-application-inspection'].includes(model.reading?.actionKind ?? '')
  return <div data-management-permissions>
    {current ? <>
      <div className="connector-enrollment__action" aria-busy={busy}>
        <p className="settings-group-note">Permissions for messages, groups, participant profiles and bot identity.</p>
        {review ? <div className="connector-next-step" data-permission-review-result><div><strong>{review.reason ? 'Some permissions could not be confirmed' : missing ? `${missing} missing application permissions` : 'No additions needed'}</strong><p>{review.reason ? 'The original checks are kept. Nothing can be added from this incomplete review.' : missing ? 'Only these missing items will be added to this application. Existing requests are kept.' : 'These items are already requested or configured. This does not confirm effective authorization.'}</p></div></div> : !recover && (configuration.sources.catalog || configuration.sources.applied) ? <p className="settings-group-note" role="status" data-permission-partial>Part of the check is saved. Continue reviewing to check the remaining part.</p> : null}
        {configuration.reason === 'original-effect-unconfirmed' && !recover && original ? <div className="connector-configuration__notice" role="status" data-permission-unresolved><p>An earlier permission addition is unconfirmed. Checking current permissions never repeats that request.</p>{original.connectionId === record.config.connectionId ? <button className="primary-button" data-permission-original disabled={busy} onClick={() => select(original.stepId, original.operationId)}>Check original request</button> : <button className="small-button" onClick={onBack}>Back to bot library</button>}</div> : null}
        {add ? <div className="connector-configuration__decision"><p className="settings-group-note">Applies to the whole {record.config.label} application. Data ranges, subscriptions and publishing are separate.</p><button className="primary-button" data-permission-add disabled={busy} onClick={() => model.advance(add)}>{busy && model.reading?.actionKind === add.kind ? 'Requesting permissions…' : `Add ${missing} missing permissions`}</button></div> : null}
        {recover ? <button className="primary-button" data-permission-recover disabled={busy} onClick={() => model.advance(recover)}>Finish saving original result</button> : null}
        {selected?.effect === 'add-application-permissions' && selected.request === 'confirmed' && selected.requiresDataRangeConfiguration === true ? <p className="connector-check-feedback" role="status">The platform reports that data-range configuration is still needed. Complete that separately in the developer console.</p> : null}
        <div className="connector-configuration__tools"><button className={add || recover || configuration.reason === 'original-effect-unconfirmed' ? 'small-button' : 'primary-button'} data-permission-review disabled={busy} onClick={() => void model.reviewPermissions()}>{reviewing ? 'Reviewing permissions…' : review || selected ? 'Review permissions again' : 'Review permissions'}</button><button className="small-button" data-management-console onClick={() => void onConsole()}>Open developer console<LinkIcon size={12} /></button></div>
        <p className="settings-group-note">Reviewing checks available permissions and this app’s requests without adding anything.</p>
      </div>
      <details className="connector-optional connector-permission-scope"><summary>{review ? 'Exact permissions in this review' : 'Permission scope'}</summary><p className="settings-group-note">For Agent conversations, creating or connecting groups, reading participant names and avatars, and identifying this bot’s creator for an optional group invitation. Participant profiles use contact access within the application’s permitted data range. Creator lookup uses this application’s own resources. Bot profile updates use the separately confirmed management account.</p>{review ? (['messages', 'groups', 'identity'] as const).map(group => {
        const permissions = review.permissions.filter(permission => permission.group === group)
        return permissions.length ? <div className="connector-permission-group" key={group}><strong>{group === 'messages' ? 'Agent conversations' : group === 'groups' ? 'Create and connect groups' : 'Participant profiles and bot creator'}</strong><dl className="connector-identity connector-permission-list">{permissions.map(permission => <div key={permission.name}><dt><code>{permission.name}</code></dt><dd>{permission.state === 'requested' ? 'Already requested' : permission.state === 'missing' ? 'To add' : 'Not confirmed'}</dd></div>)}</dl></div> : null
      }) : null}</details>
    </> : null}
    {configuration.effects.length || selected ? <details className="connector-optional"><summary>Original permission requests</summary>{[...(selected && !configuration.effects.some(item => item.stepId === selected.stepId) ? [selected] : []), ...configuration.effects].map(receipt => <button className="connector-enrollment__previous" key={receipt.stepId} data-permission-result={receipt.stepId} onClick={() => select(receipt.stepId)}><strong>{receipt.effect === 'add-application-permissions' ? `${receipt.scopeNames.length} application permissions` : 'Original request'}</strong><span>{receipt.request === 'confirmed' ? receipt.secureStorage === 'stored' ? 'Accepted result saved' : 'Accepted result needs saving' : 'Result not confirmed'}</span></button>)}{configuration.next ? <button className="small-button" onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: configuration.effect, purpose: configuration.purpose, cursor: configuration.next! } })}>More requests</button> : null}</details> : null}
  </div>
}
