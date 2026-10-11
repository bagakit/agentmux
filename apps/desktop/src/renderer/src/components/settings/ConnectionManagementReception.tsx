import type { ConnectionRecord, ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'

type Configuration = Extract<NonNullable<ConnectionSetupView['applicationConfiguration']>, { effect: 'add-message-reception' }>

/** One reception outcome inside Delivery; native mapping and eligibility remain Host-owned. */
export function ConnectionManagementReception({ record, model, current, configuration, onConsole, onBack }: {
  record: ConnectionRecord; model: ConnectionManagementModel; current: boolean; configuration: Configuration
  onConsole: () => Promise<void>; onBack: () => void
}) {
  const { busy } = model, { selected, review } = configuration
  const add = configuration.actions.find(a => a.kind === 'add-message-reception'), recover = configuration.actions.find(a => a.kind === 'recover-configuration-effect')
  const unresolved = configuration.unresolved
  const select = (stepId: string, operationId?: string) => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'add-message-reception', selectedStepId: stepId } }, operationId)
  const original = unresolved ?? (selected ? { stepId: selected.stepId, operationId: selected.input.operationId, connectionId: record.config.connectionId } : null)
  const reviewing = busy && (model.reading?.actionKind === 'read-event-catalog' || model.reading?.actionKind === 'read-event-settings')
  return <div data-management-reception>
    {current ? <div className="connector-enrollment__action" aria-busy={busy}>
      {review ? <div className="connector-next-step" data-reception-review-result><div><strong>{review.reason ? 'Message reception could not be confirmed' : review.reception === 'subscribed' ? 'Required message event is configured' : 'The message event is missing'}</strong><p>{review.reason ? 'The original checks are kept. No event can be added from this incomplete review.' : review.reception === 'subscribed' ? 'This is the current application subscription, not proof that messages are arriving.' : review.transport === 'persistent-connection' ? 'It can be added with the last checked persistent delivery mode.' : 'Set event delivery to a persistent connection before adding message reception.'}</p></div></div> : !selected && (configuration.sources.catalog || configuration.sources.settings) ? <p className="settings-group-note" data-reception-partial role="status">The completed part of this check is saved. Continue checking to review message reception.</p> : null}
      {recover ? <button className="primary-button" data-reception-recover disabled={busy} onClick={() => model.advance(recover)}>Finish saving original result</button> : null}
      {configuration.reason === 'original-effect-unconfirmed' && !recover && original ? <div className="connector-configuration__notice" data-reception-unresolved role="status"><p>An earlier message addition for this application is still unconfirmed. Checking current reception cannot send it again.</p>{original.connectionId === record.config.connectionId ? <button className="primary-button" data-reception-original disabled={busy} onClick={() => select(original.stepId, original.operationId)}>Check original request</button> : <button className="small-button" onClick={onBack}>Back to bot library</button>}</div> : null}
      {add ? <><button className="primary-button" data-reception-add disabled={busy} onClick={() => model.advance(add)}>{busy && model.reading?.actionKind === add.kind ? 'Adding message reception…' : 'Add message reception'}</button><p className="settings-group-note">This adds one message event to the whole {record.config.label} application and sends its last checked persistent delivery mode with the request. Other event consumers may be affected if that mode changed since the check. It does not change permissions, callbacks or publishing.</p></> : null}
      <button className={add || recover || configuration.reason === 'original-effect-unconfirmed' ? 'small-button' : 'primary-button'} data-reception-review disabled={busy} onClick={() => void model.reviewMessageReception()}>{reviewing ? 'Checking message reception…' : review || selected ? 'Check reception again' : 'Check message reception'}</button>
      <p className="settings-group-note">Check delivery and the available message event. Checking does not change this application.</p>
      <button className="small-button" data-reception-delivery disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'use-persistent-connection' } })}>Event delivery settings</button>
      <button className="small-button" data-management-console onClick={() => void onConsole()}>Open developer console</button>
    </div> : null}
    {configuration.effects.length || selected ? <details className="connector-optional"><summary>Original reception requests</summary>{[...(selected && !configuration.effects.some(r => r.stepId === selected.stepId) ? [selected] : []), ...configuration.effects].map(receipt => <button className="connector-enrollment__previous" key={receipt.stepId} data-reception-result={receipt.stepId} onClick={() => select(receipt.stepId)}><strong>Add message reception</strong><span>{receipt.request === 'confirmed' ? receipt.secureStorage === 'stored' ? 'Accepted result saved' : 'Accepted result needs saving' : 'Result not confirmed'}</span></button>)}{configuration.next ? <button className="small-button" onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'add-message-reception', cursor: configuration.next! } })}>More requests</button> : null}</details> : null}
  </div>
}
