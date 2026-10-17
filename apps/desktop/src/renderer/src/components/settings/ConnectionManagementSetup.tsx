import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { BotSignInPrompt } from '../BotConfirmationCode'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'
import { ConnectionGuidedTask } from './ConnectionGuidedTask'
import { ConnectionConfigurationProgress } from './ConnectionConfigurationProgress'
import { ConnectionManagementConfiguration } from './ConnectionManagementConfiguration'
import { ConnectionRequestTrace } from './ConnectionRequestTrace'
import { BotSetupGuide, type BotSetupGuideStage } from './BotSetupGuide'

const LoadingIcon = semanticIconComponent('status.loading')
const titles = { checking: 'Reading original setup', waiting: 'Scan to sign in', scanned: 'Confirm on your phone', handoff: 'Reading your account', account: 'Is this the right account?', confirmed: 'Account confirmed', expired: 'This sign-in code expired', unknown: 'Sign-in result not confirmed', revised: 'This application changed' } as const
const summaries = {
  checking: 'Reading this original request. You can leave and check it again later.',
  scanned: 'Finish the sign-in confirmation on your phone. Keep this page open to continue.',
  handoff: 'Your original sign-in is being checked. You can leave and return to it.', account: 'Use this account and enterprise for this application’s setup.',
  confirmed: 'Review this bot’s settings, then publish the changes when you are ready.',
  expired: 'Show a new code to continue this same sign-in. This does not create another bot.', unknown: 'Your original request is kept. Check its result before continuing.',
  revised: 'The original request is kept. Return to the current application before starting a new sign-in.'
} as const

/** A presentation of the original task owner; no authentication or persistence logic lives here. */
export function ConnectionManagementSetup({ record, model, platformLabel, onBack, onLibrary, onConsole }: { record: ConnectionRecord; model: ConnectionManagementModel; platformLabel: string; onBack: () => void; onLibrary: () => void; onConsole: () => Promise<void> }) {
  const { reading, view, observedView, busy, choices } = model
  const [managementOpen, setManagementOpen] = useState(false)
  const setupReadFailed = !!reading?.issue && !!reading.intent
  const revised = model.revised
  const stage = revised ? 'revised' : reading?.issue ? 'unknown' : view?.continuation?.stage ?? (view?.challenge ? 'waiting' : busy ? 'checking' : reading ? 'unknown' : 'initial')
  const account = !revised ? (view ?? observedView)?.continuation?.account : null
  const actions = view?.continuation?.actions ?? []
  const confirm = actions.find(action => action.kind === 'confirm-account')
  const renew = actions.find(action => action.kind === 'renew')
  const recovery = stage === 'unknown' ? actions.find(action => action.kind !== 'renew') : null
  const initial = stage === 'initial', showStart = initial && (!choices.length || model.fresh)
  const configuration = stage === 'confirmed'
  const guided = configuration && model.task.kind !== 'publication'
  const configurationUnconfirmed = view?.applicationInspection?.selected?.request === 'unknown' || view?.applicationConfiguration?.selected?.request === 'unknown'
  const guideStage: BotSetupGuideStage = stage === 'account' ? 'account' : configuration ? configurationUnconfirmed ? 'attention' : 'connect' : ['waiting', 'scanned', 'handoff', 'checking'].includes(stage) ? 'scan' : initial ? 'prepare' : 'attention'
  const hasConfigurationActivity = !!view?.applicationInspection?.selected || !!view?.applicationConfiguration?.selected || !!view?.applicationInspection?.observations.length || !!view?.applicationConfiguration?.effects.length || !!view?.applicationConfiguration?.unresolved
  return <section className="connector-setup connector-management" data-management-setup={record.config.connectionId} data-management-stage={stage}>
    <button type="button" className="connector-back small-button" data-management-back onClick={onBack}>Back to connection</button>
    <BotSetupGuide stage={guideStage} confirmedSteps={[1, ...((view ?? observedView)?.continuation?.stage === 'confirmed' ? [2] : [])]} existingApplication currentStep={stage === 'checking' && !view ? null : configuration || hasConfigurationActivity || observedView?.continuation?.stage === 'confirmed' ? 4 : 2} />
    <header className="connector-enrollment__heading bot-task-heading">
      <p className="connector-management__context">{record.config.label} · {platformLabel}</p>
      <h3 className="connector-editor-title">{configuration ? 'Prepare your bot for conversations' : setupReadFailed ? 'Setup check interrupted' : (initial ? showStart ? 'Confirm your account' : 'Continue your sign-in' : titles[stage])}</h3>
      <p className="connector-enrollment__summary">{configuration ? 'Your sign-in is confirmed. Continue this application through configuration and publishing.' : setupReadFailed ? 'Your bot and unfinished work are kept. Retry this same setup check to continue.' : (initial ? showStart ? 'Sign in with the account you use to manage this bot.' : 'Choose an original request. Checking it does not start another sign-in.' : stage === 'waiting' ? `Scan this code with ${platformLabel} to sign in for this bot’s setup.` : summaries[stage])}</p>
    </header>
    {view?.challenge && !reading?.issue && !revised ? <div className="connector-management__scan" data-management-code>
      <BotSignInPrompt url={view.challenge.qrPayload} title={`${platformLabel} account sign-in code`} platform={platformLabel} scanned={stage === 'scanned'} />
    </div> : null}
    {account ? <dl className={`connector-management__account${configuration ? ' connector-management__account--confirmed' : ''}`} aria-label={configuration || observedView?.continuation?.stage === 'confirmed' ? 'Confirmed account and enterprise' : 'Account and enterprise to confirm'}>
      <div><dt>{reading?.issue ? observedView?.continuation?.stage === 'confirmed' ? 'Last confirmed account' : 'Last observed account' : configuration ? 'Account confirmed' : 'Account'}</dt><dd>{account.userName ?? account.userId}</dd></div>
      <div><dt>Enterprise</dt><dd>{account.tenantName ?? account.tenantId}</dd></div>
    </dl> : null}
    <div className="connector-enrollment__action" aria-busy={busy}>
      {showStart ? <button className="primary-button" data-management-start disabled={!model.supported || busy} onClick={model.start}>Show sign-in code</button> : null}
      {stage === 'account' && confirm && account ? <button className="primary-button" data-management-confirm disabled={busy} onClick={() => model.advance(confirm)}>{busy ? 'Confirming…' : 'Use this account'}</button> : null}
      {stage === 'expired' && renew ? <button className="primary-button" data-management-renew disabled={busy} onClick={() => model.advance(renew)}>Show a new code</button> : null}
      {stage === 'unknown' && reading ? <button className="primary-button" data-management-inspect disabled={busy} onClick={model.inspect}>{busy ? 'Checking…' : setupReadFailed ? 'Retry setup check' : 'Check original sign-in'}</button> : null}
      {['waiting', 'scanned', 'handoff'].includes(stage) && !model.driving ? <button className="primary-button" data-management-resume disabled={busy} onClick={model.continueOriginal}>{busy ? 'Checking sign-in…' : 'Continue sign-in'}</button> : null}
      {reading?.absent ? <p className="connector-check-feedback" role="status">This request is not visible yet. Its original details are kept; this does not confirm that the submitted request was refused.</p> : null}
      {initial && model.catalog?.issue ? <p className="connector-check-feedback" role="status">Sign-in requests could not be refreshed. Your saved application is kept.</p> : null}
      {busy ? <p className="connector-check-feedback" role="status" data-management-activity aria-busy="true"><LoadingIcon size={14} animation="spin" /> {model.activityLabel}</p> : null}
      {initial && !model.catalog?.value && model.listing ? <p className="settings-group-note" role="status">Reading sign-in support…</p> : null}
      {initial && !model.supported && !model.listing ? <><p className="settings-group-note">In-app sign-in is not confirmed for this saved application. You can continue in the developer console.</p><button className="small-button" data-management-console onClick={() => void onConsole()}>Open developer console</button><button className="small-button" onClick={() => void model.list()}>Check sign-in support</button></> : null}
    </div>
    {configuration || observedView?.continuation?.stage === 'confirmed' ? <ConnectionConfigurationProgress view={view ?? observedView} busy={busy} actionKind={reading?.actionKind} readFailed={!!reading?.issue} /> : null}
    {guided && !managementOpen ? <ConnectionGuidedTask record={record} model={model} onLibrary={onLibrary} onConsole={onConsole} /> : null}
    {configuration || hasConfigurationActivity ? model.task.kind === 'publication' && configuration ? <ConnectionManagementConfiguration record={record} model={model} current onConsole={onConsole} onBack={onLibrary} /> : <details open={managementOpen} className="connector-optional" data-guided-management onToggle={event => { const open = event.currentTarget.open; setManagementOpen(open); if (!open && managementOpen && configuration) model.returnToGuided() }}><summary>Manage individual settings</summary><ConnectionManagementConfiguration record={record} model={model} current={!!configuration} onConsole={onConsole} onBack={onLibrary} /></details> : null}
    {model.selectedId ? <ConnectionRequestTrace source={{ kind: 'setup', operationId: model.selectedId }} revision={view?.operation?.revision ?? observedView?.operation?.revision} setupView={view ?? observedView} /> : <p className="settings-group-note" data-management-selection-note>{choices.length ? 'No original request selected. Choose one below to view its progress and copy diagnosis.' : model.listing ? 'Reading original requests. No request is selected.' : model.catalog?.issue ? 'Original requests could not be read. No request is selected.' : 'No original request selected. A sign-in request will appear here after it starts.'}</p>}
    {initial && !model.fresh && choices.length ? <div className="connector-management__originals">{choices.map(({ input, operation }) => <button key={input.operationId} className="connector-enrollment__previous" data-management-original={input.operationId} onClick={() => model.choose(input)}>
      <strong>{operation?.authentication?.stage === 'confirmed' ? 'View confirmed sign-in' : 'Resume original sign-in'}</strong><span>{input.operationId}</span>
    </button>)}{model.catalog?.value?.next ? <button className="small-button" disabled={model.listing} onClick={() => void model.list(model.catalog!.value!.next!)}>More sign-ins</button> : null}</div> : null}
    <details className="connector-optional"><summary>{stage === 'unknown' ? 'Continue or use another sign-in' : 'Other sign-in options'}</summary>
      {model.selectedId && choices.length ? <button className="small-button" data-management-select onClick={model.chooseOriginalRequest}>Choose an original request</button> : null}
      {recovery ? <button className="small-button" data-management-resume disabled={busy} onClick={() => model.advance(recovery)}>Finish saving original sign-in</button> : stage === 'unknown' && model.canContinueOriginal && (reading?.absent || view?.operation?.request.state === 'not-dispatched' || view?.operation?.request.state === 'confirmed' && view.operation.secureStorage !== 'stored') ? <button className="small-button" data-management-resume disabled={busy} onClick={model.continueOriginal}>Continue original sign-in</button> : null}
      {renew && stage !== 'expired' ? <><p className="settings-group-note">Start a new scan in this same request. The previous sign-in result is kept; this does not create a bot.</p><button className="small-button" data-management-renew disabled={busy} onClick={() => model.advance(renew)}>Use another account</button></> : null}
      {model.supported ? <><p className="settings-group-note">You can open a separate sign-in request. Other pending requests are kept.</p><button className="small-button" data-management-another onClick={model.another}>Open a separate sign-in</button></> : null}
    </details>
    {reading || model.catalog?.issue ? <details className="connector-diagnostics"><summary>Sign-in details</summary>
      <dl className="connector-identity"><div><dt>App ID</dt><dd><code>{record.config.application.appId}</code></dd></div>{reading ? <div><dt>Original request</dt><dd><code>{reading.id}</code></dd></div> : null}</dl>
      {reading?.issue || model.catalog?.issue ? <p className="connector-enrollment__technical">{reading?.issue || model.catalog?.issue}</p> : null}
    </details> : null}
  </section>
}
