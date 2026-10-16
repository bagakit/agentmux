import type { ConnectionRecord, ConnectionSetupReadSubject } from '@agentmux/core/connections'
import { SurfaceModeSwitch } from '../SurfaceModeSwitch'
import { ConnectionManagementPublication } from './ConnectionManagementPublication'
import { ConnectionManagementPermissions } from './ConnectionManagementPermissions'
import { ConnectionManagementReception } from './ConnectionManagementReception'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'

const subjects: Record<ConnectionSetupReadSubject, string> = {
  'application-details': 'Application details', 'bot-settings': 'Bot message setting',
  'permission-catalog': 'Permission directory', 'application-permissions': 'Requested application permissions',
  'event-catalog': 'Event directory', 'event-settings': 'Event settings', 'callback-settings': 'Callback settings',
  'publication-pending': 'Pending application changes', 'publication-versions': 'Application versions',
  'publication-visibility': 'Current application audience', 'publication-sharing': 'External sharing',
  'publication-features': 'Application features', 'publication-version': 'Selected application version'
}
const resultLabel = (request: string, storage: string) => request === 'confirmed'
  ? storage === 'stored' ? 'Result saved' : 'Result needs saving' : request === 'dispatching' ? 'In progress' : 'Result not confirmed'

/** Controls consume exact Host-offered actions; activity selection is a local read. */
export function ConnectionManagementConfiguration({ record, model, current, onConsole, onBack }: {
  record: ConnectionRecord; model: ConnectionManagementModel; current: boolean
  onConsole: () => Promise<void>; onBack: () => void
}) {
  const { view, busy } = model
  const inspection = view?.applicationInspection, configuration = view?.applicationConfiguration
  const supported = model.catalog?.value?.support?.capabilities ?? []
  if (configuration?.effect === 'create-application-version' || configuration?.effect === 'submit-application-version') return <ConnectionManagementPublication key={view?.operation?.operationId} record={record} model={model} current={current} configuration={configuration} onConsole={onConsole} onBack={onBack} />
  const selectedMode = configuration?.effect === 'add-message-reception' ? 'use-persistent-connection' : configuration?.effect === 'add-card-actions' ? 'use-persistent-callback' : configuration?.effect ?? 'enable-messaging'
  const modeSwitch = current && (supported.includes('persistent-event-transport') || supported.includes('application-permissions')) ? <SurfaceModeSwitch value={selectedMode} active={current} ariaLabel="Bot setup step" options={[
    { value: 'enable-messaging', label: 'Messages' }, ...(supported.includes('persistent-event-transport') ? [{ value: 'use-persistent-connection' as const, label: 'Delivery' }] : []), ...(supported.includes('application-permissions') ? [{ value: 'add-application-permissions' as const, label: 'Permissions' }] : []), ...(supported.includes('card-actions') ? [{ value: 'use-persistent-callback' as const, label: 'Cards' }] : [])
  ]} onChange={effect => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: effect === 'add-application-permissions' ? { effect, purpose: 'agent-conversation' } : { effect } })} /> : null
  if (configuration?.effect === 'add-application-permissions') return <div className="connector-configuration" data-management-configuration>{modeSwitch}<ConnectionManagementPermissions record={record} model={model} current={current} configuration={configuration} onConsole={onConsole} onBack={onBack} /></div>
  if (configuration?.effect === 'add-message-reception') return <div className="connector-configuration" data-management-configuration>{modeSwitch}<ConnectionManagementReception record={record} model={model} current={current} configuration={configuration} onConsole={onConsole} onBack={onBack} /></div>
  const scalarConfiguration = configuration && 'source' in configuration ? configuration : null
  const transport = configuration?.effect === 'use-persistent-connection'
  const effect = scalarConfiguration?.effect ?? 'enable-messaging'
  const callbacks = effect === 'use-persistent-callback' || effect === 'add-card-actions'
  const effectLabels = { 'enable-messaging': 'Turn on bot messages', 'use-persistent-connection': 'Use persistent connection', 'use-persistent-callback': 'Connect card interactions', 'add-card-actions': 'Enable card replies' } as const
  const read = inspection?.actions.find(action => action.kind === (callbacks ? 'read-callback-settings' : transport ? 'read-event-settings' : 'read-bot-settings'))
  const modeRead = inspection?.selected?.stepId === scalarConfiguration?.source?.stepId && inspection?.readResult?.subject === 'event-settings' ? inspection.readResult.transport : null
  const modeLabel = configuration?.capability === 'enabled' ? 'Persistent connection' : modeRead === 'webhook' ? 'Webhook' : modeRead === 'function' ? 'Function' : 'Not confirmed'
  const enable = configuration?.actions.find(action => action.kind === effect)
  const recoverRead = inspection?.actions.find(action => action.kind === 'recover-application-inspection')
  const recoverEffect = configuration?.actions.find(action => action.kind === 'recover-configuration-effect')
  const unresolved = configuration?.unresolved
  const originalEffect = unresolved?.connectionId === record.config.connectionId ? unresolved : configuration?.selected
    ? { operationId: configuration.selected.input.operationId, connectionId: record.config.connectionId, stepId: configuration.selected.stepId } : null
  const uncertainEffect = configuration?.reason === 'original-effect-unconfirmed'
  const acceptedEffect = configuration?.selected?.request === 'confirmed'
  const primaryRead = !uncertainEffect && !enable && configuration?.capability !== 'enabled'
  const readSelected = inspection?.selected, effectSelected = configuration?.selected
  const readPage = inspection?.observations ?? [], effectPage = configuration?.effects ?? []
  // A selected original may be outside the current bounded page. Keep it visible without another Store.
  const visibleReads = readSelected && !readPage.some(receipt => receipt.stepId === readSelected.stepId) ? [readSelected, ...readPage] : readPage
  const visibleEffects = effectSelected && !effectPage.some(receipt => receipt.stepId === effectSelected.stepId) ? [effectSelected, ...effectPage] : effectPage
  const selectedRead = (stepId: string) => model.inspectOriginal({ applicationInspection: { selectedStepId: stepId }, applicationConfiguration: { effect, ...(configuration?.selected ? { selectedStepId: configuration.selected.stepId } : {}) } })
  const selectedEffect = (stepId: string, operationId?: string) => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect, selectedStepId: stepId } }, operationId)
  const hasActivity = !!visibleReads.length || !!visibleEffects.length
  return <div className="connector-configuration" data-management-configuration>
    {modeSwitch}
    {current ? <div className="connector-enrollment__action" aria-busy={busy}>
      {busy && !model.reading?.actionKind ? <p className="settings-group-note" role="status">Reading setup actions…</p> : null}
      {transport ? <p className="settings-group-note" data-management-current-transport>Last checked event delivery: {modeLabel}</p> : null}
      {uncertainEffect && originalEffect ? <button className="primary-button" data-management-original-effect disabled={busy} onClick={() => selectedEffect(originalEffect.stepId, originalEffect.operationId)}>{busy ? 'Checking original request…' : 'Check original request'}</button> : null}
      {enable ? <><button className="primary-button" data-management-enable={!transport && !callbacks ? '' : undefined} data-management-use-persistent={transport ? '' : undefined} data-management-card-actions={callbacks ? '' : undefined} disabled={busy} onClick={() => model.advance(enable)}>{busy && model.reading?.actionKind === effect ? 'Saving this change…' : effectLabels[effect]}</button><p className="settings-group-note">{effect === 'use-persistent-callback' ? `This changes callback delivery for the whole ${record.config.label} application, including existing callback consumers. Publishing is a separate step.` : effect === 'add-card-actions' ? 'Add card action replies while keeping the checked persistent callback connection. Existing callbacks are kept; publishing is a separate step.' : transport ? `This changes event delivery for the whole ${record.config.label} application, including existing event consumers. This step does not add or remove subscriptions, or publish the app.` : `This requests messaging for ${record.config.label}. Publishing is a separate step.`}</p></> : null}
      {read ? <button className={primaryRead ? 'primary-button' : 'small-button'} data-management-read-bot={!transport && !callbacks && !acceptedEffect ? '' : undefined} data-management-read-events={transport ? '' : undefined} data-management-read-callbacks={callbacks ? '' : undefined} data-management-current-setting={acceptedEffect ? '' : undefined} disabled={busy} onClick={() => model.advance(read)}>{busy && model.reading?.actionKind === read.kind ? 'Checking current setting…' : acceptedEffect ? 'Check current setting' : scalarConfiguration?.source ? 'Check setting again' : callbacks ? 'Check card interactions' : transport ? 'Check event delivery' : 'Check bot settings'}</button> : null}
      {!inspection && !configuration || model.reading?.configurationIssue ? <><p className="connector-check-feedback" role="status">Bot setup actions could not be read. Your confirmed account is kept.</p><button className="small-button" data-management-inspect disabled={busy} onClick={model.inspect}>Check setup actions</button></> : null}
      {transport && supported.includes('message-reception') ? <button className={configuration.capability === 'enabled' && !uncertainEffect ? 'primary-button' : 'small-button'} data-management-review-reception disabled={busy} onClick={() => void model.reviewMessageReception()}>Check message reception</button> : null}
      {effect === 'use-persistent-callback' && configuration?.capability === 'enabled' ? <button className="small-button" data-management-review-cards disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'add-card-actions' } })}>Check card replies</button> : null}
      {supported.includes('application-publication') ? <button className="small-button" data-management-publication-open disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'create-application-version' } })}>Review publishing</button> : null}
      <button className="small-button" data-management-console onClick={() => void onConsole()}>Open developer console</button>
    </div> : null}
    {uncertainEffect ? <div className="connector-configuration__notice" data-management-unresolved role="status">
      <p>{callbacks ? 'An earlier card interaction change for this application still has no confirmed result. Keep that original request while checking current settings.' : configuration?.capability === 'enabled' ? transport ? 'The current delivery mode is persistent, but the earlier change still has no confirmed result.' : 'The current setting is on, but the earlier turn-on request still has no confirmed result.' : transport ? 'An earlier event delivery change for this application is still unconfirmed.' : 'An earlier turn-on request for this application is still unconfirmed.'}</p>
      {unresolved && unresolved.connectionId !== record.config.connectionId ? <><p>It belongs to another saved bot entry. Return to your bot library to find that original request.</p><button className="small-button" data-management-library onClick={onBack}>Back to bot library</button></> : null}
      {!current && originalEffect ? <button className="small-button" data-management-original-effect disabled={busy} onClick={() => selectedEffect(originalEffect.stepId, originalEffect.operationId)}>Check original request</button> : null}
      {unresolved ? <details className="connector-diagnostics"><summary>Original request location</summary><dl className="connector-identity"><div><dt>Saved bot entry</dt><dd><code>{unresolved.connectionId}</code></dd></div><div><dt>Original request</dt><dd><code>{unresolved.operationId}</code></dd></div></dl></details> : null}
    </div> : null}
    {recoverRead || recoverEffect ? <div className="connector-configuration__notice" role="status">
      <p>The original result was received. Finish saving it locally; this does not send another platform request.</p>
      {recoverRead ? <button className="small-button" data-management-recover-read disabled={busy} onClick={() => model.advance(recoverRead)}>Finish saving check result</button> : null}
      {recoverEffect ? <button className="small-button" data-management-recover-effect disabled={busy} onClick={() => model.advance(recoverEffect)}>{transport ? 'Finish saving delivery result' : 'Finish saving turn-on result'}</button> : null}
    </div> : null}
    {hasActivity ? <details className="connector-optional connector-configuration__activity" data-management-activity>
      <summary>Original setup activity</summary>
      <p className="settings-group-note">These are results of earlier actions. Viewing them does not check or change the platform.</p>
      {visibleReads.length ? <div className="connector-configuration__results" aria-label="Original checks">{visibleReads.map(receipt => <button className="connector-configuration__result" key={receipt.stepId} data-management-read-result={receipt.stepId} aria-pressed={readSelected?.stepId === receipt.stepId} onClick={() => selectedRead(receipt.stepId)}>
        <span>{receipt.subject ? subjects[receipt.subject] : 'Application access check'}</span><small>{resultLabel(receipt.request, receipt.secureStorage)}</small>{readSelected?.stepId === receipt.stepId ? <small className="connector-configuration__selection">Selected original result</small> : null}<code>{receipt.stepId}</code>
      </button>)}{inspection?.next ? <button className="small-button" data-management-more-reads disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: { cursor: inspection.next! }, applicationConfiguration: { effect } })}>More checks</button> : null}</div> : null}
      {visibleEffects.length ? <div className="connector-configuration__results" aria-label="Original configuration requests">{visibleEffects.map(receipt => <button className="connector-configuration__result" key={receipt.stepId} data-management-effect-result={receipt.stepId} aria-pressed={configuration?.selected?.stepId === receipt.stepId} onClick={() => selectedEffect(receipt.stepId)}>
        <span>{receipt.effect in effectLabels ? effectLabels[receipt.effect as keyof typeof effectLabels] : 'Original configuration change'}</span><small>{resultLabel(receipt.request, receipt.secureStorage)}</small>{configuration?.selected?.stepId === receipt.stepId ? <small className="connector-configuration__selection">Selected original result</small> : null}<code>{receipt.stepId}</code>
      </button>)}{configuration?.next ? <button className="small-button" data-management-more-effects disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect, cursor: configuration.next! } })}>More configuration requests</button> : null}</div> : null}
    </details> : null}
    {model.reading?.configurationIssue ? <details className="connector-diagnostics"><summary>Setup action details</summary><p className="connector-enrollment__technical">{model.reading.configurationIssue}</p></details> : null}
  </div>
}
