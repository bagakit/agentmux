import type { ConnectionRecord, ConnectionSetupReadSubject, ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'

const subjects: Record<ConnectionSetupReadSubject, string> = {
  'application-details': 'Application details', 'bot-settings': 'Bot message setting',
  'event-settings': 'Event settings', 'callback-settings': 'Callback settings'
}
const resultLabel = (request: string, storage: string) => request === 'confirmed'
  ? storage === 'stored' ? 'Result saved' : 'Result needs saving' : request === 'dispatching' ? 'In progress' : 'Result not confirmed'

/** Presentation only: current capability and the original request remain separate facts. */
export function connectionConfigurationSummary(view: ConnectionSetupView | null) {
  const configuration = view?.applicationConfiguration
  if (configuration?.capability === 'enabled') return { title: 'Bot messages are on', summary: 'The bot’s message capability is switched on. More setup is needed before it can chat.' }
  if (configuration?.capability === 'disabled') return { title: 'Bot messages are off', summary: configuration.actions.some(action => action.kind === 'enable-messaging')
    ? 'Turn on messaging for this bot. It will still need the remaining setup before it can chat.'
    : 'The current setting is off. Check again or continue setup in the developer console.' }
  if (configuration?.reason === 'original-effect-unconfirmed') return { title: 'Turn-on result not confirmed', summary: 'The original request is kept. Check its result; checking will not send it again.' }
  if (configuration?.selected?.request === 'confirmed') return { title: 'Turn-on request accepted', summary: 'Check the current setting to see whether messaging is now on. This is one part of setup.' }
  if (view?.applicationInspection?.selected?.subject === 'bot-settings') return { title: 'Bot setting not confirmed', summary: 'This check did not confirm the current setting. The original result is kept.' }
  return { title: 'Prepare bot messages', summary: 'Check this bot’s current message setting, then turn it on if needed.' }
}

/** Controls consume exact Host-offered actions; activity selection is a local read. */
export function ConnectionManagementConfiguration({ record, model, current, onConsole, onBack }: {
  record: ConnectionRecord; model: ConnectionManagementModel; current: boolean
  onConsole: () => Promise<void>; onBack: () => void
}) {
  const { view, busy } = model
  const inspection = view?.applicationInspection, configuration = view?.applicationConfiguration
  const read = inspection?.actions.find(action => action.kind === 'read-bot-settings')
  const enable = configuration?.actions.find(action => action.kind === 'enable-messaging')
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
  const selectedRead = (stepId: string) => model.inspectOriginal({ applicationInspection: { selectedStepId: stepId }, applicationConfiguration: configuration?.selected ? { selectedStepId: configuration.selected.stepId } : {} })
  const selectedEffect = (stepId: string, operationId?: string) => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { selectedStepId: stepId } }, operationId)
  const hasActivity = !!visibleReads.length || !!visibleEffects.length
  return <div className="connector-configuration" data-management-configuration>
    {current ? <div className="connector-enrollment__action" aria-busy={busy}>
      {uncertainEffect && originalEffect ? <button className="primary-button" data-management-original-effect disabled={busy} onClick={() => selectedEffect(originalEffect.stepId, originalEffect.operationId)}>{busy ? 'Checking original request…' : 'Check original request'}</button> : null}
      {enable ? <><button className="primary-button" data-management-enable disabled={busy} onClick={() => model.advance(enable)}>{busy ? 'Turning on messages…' : 'Turn on bot messages'}</button><p className="settings-group-note">This requests messaging for {record.config.label}. Publishing is a separate step.</p></> : null}
      {read ? <button className={primaryRead ? 'primary-button' : 'small-button'} data-management-read-bot={!acceptedEffect ? '' : undefined} data-management-current-setting={acceptedEffect ? '' : undefined} disabled={busy} onClick={() => model.advance(read)}>{busy && model.reading?.actionKind === 'read-bot-settings' ? 'Checking bot settings…' : acceptedEffect ? 'Check current setting' : configuration?.source ? 'Check setting again' : 'Check bot settings'}</button> : null}
      {!inspection && !configuration || model.reading?.configurationIssue ? <><p className="connector-check-feedback" role="status">Bot setup actions could not be read. Your confirmed account is kept.</p><button className="small-button" data-management-inspect disabled={busy} onClick={model.inspect}>Check setup actions</button></> : null}
      {configuration?.capability === 'enabled' ? <p className="settings-group-note">Complete the remaining platform setup in the developer console, then return to check the connection.</p> : null}
      <button className="small-button" data-management-console onClick={() => void onConsole()}>Open developer console</button>
    </div> : null}
    {uncertainEffect ? <div className="connector-configuration__notice" data-management-unresolved role="status">
      <p>{configuration?.capability === 'enabled' ? 'The current setting is on, but the earlier turn-on request still has no confirmed result.' : 'An earlier turn-on request for this application is still unconfirmed.'}</p>
      {unresolved && unresolved.connectionId !== record.config.connectionId ? <><p>It belongs to another saved bot entry. Return to your bot library to find that original request.</p><button className="small-button" data-management-library onClick={onBack}>Back to bot library</button></> : null}
      {!current && originalEffect ? <button className="small-button" data-management-original-effect disabled={busy} onClick={() => selectedEffect(originalEffect.stepId, originalEffect.operationId)}>Check original request</button> : null}
      {unresolved ? <details className="connector-diagnostics"><summary>Original request location</summary><dl className="connector-identity"><div><dt>Saved bot entry</dt><dd><code>{unresolved.connectionId}</code></dd></div><div><dt>Original request</dt><dd><code>{unresolved.operationId}</code></dd></div></dl></details> : null}
    </div> : null}
    {recoverRead || recoverEffect ? <div className="connector-configuration__notice" role="status">
      <p>The original result was received. Finish saving it locally; this does not send another platform request.</p>
      {recoverRead ? <button className="small-button" data-management-recover-read disabled={busy} onClick={() => model.advance(recoverRead)}>Finish saving check result</button> : null}
      {recoverEffect ? <button className="small-button" data-management-recover-effect disabled={busy} onClick={() => model.advance(recoverEffect)}>Finish saving turn-on result</button> : null}
    </div> : null}
    {hasActivity ? <details className="connector-optional connector-configuration__activity" data-management-activity>
      <summary>Original setup activity</summary>
      <p className="settings-group-note">These are results of earlier actions. Viewing them does not check or change the platform.</p>
      {visibleReads.length ? <div className="connector-configuration__results" aria-label="Original checks">{visibleReads.map(receipt => <button className="connector-configuration__result" key={receipt.stepId} data-management-read-result={receipt.stepId} aria-pressed={readSelected?.stepId === receipt.stepId} onClick={() => selectedRead(receipt.stepId)}>
        <span>{receipt.subject ? subjects[receipt.subject] : 'Application access check'}</span><small>{resultLabel(receipt.request, receipt.secureStorage)}</small>{readSelected?.stepId === receipt.stepId ? <small className="connector-configuration__selection">Selected original result</small> : null}<code>{receipt.stepId}</code>
      </button>)}{inspection?.next ? <button className="small-button" data-management-more-reads disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: { cursor: inspection.next! }, applicationConfiguration: {} })}>More checks</button> : null}</div> : null}
      {visibleEffects.length ? <div className="connector-configuration__results" aria-label="Original turn-on requests">{visibleEffects.map(receipt => <button className="connector-configuration__result" key={receipt.stepId} data-management-effect-result={receipt.stepId} aria-pressed={configuration?.selected?.stepId === receipt.stepId} onClick={() => selectedEffect(receipt.stepId)}>
        <span>Turn on bot messages</span><small>{resultLabel(receipt.request, receipt.secureStorage)}</small>{configuration?.selected?.stepId === receipt.stepId ? <small className="connector-configuration__selection">Selected original result</small> : null}<code>{receipt.stepId}</code>
      </button>)}{configuration?.next ? <button className="small-button" data-management-more-effects disabled={busy} onClick={() => model.inspectOriginal({ applicationInspection: {}, applicationConfiguration: { cursor: configuration.next! } })}>More turn-on requests</button> : null}</div> : null}
    </details> : null}
    {model.reading?.configurationIssue ? <details className="connector-diagnostics"><summary>Setup action details</summary><p className="connector-enrollment__technical">{model.reading.configurationIssue}</p></details> : null}
  </div>
}
