import { useEffect, useRef, useState } from 'react'
import { connectionSetupDecisionForAction, type ConnectionSetupAdvance, type ConnectionSetupAuthenticationAction, type ConnectionSetupConfigurationAction, type ConnectionSetupView } from '@agentmux/core/connections'
import type { MoteConnectionOperation } from '@agentmux/core/mote-connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { BotConfirmationCode } from './BotConfirmationCode'
import { ConnectionRequestTrace } from './settings/ConnectionRequestTrace'
import '../styles/bot-setup-guide.css'

type Progress = NonNullable<ConnectionSetupView['profileUpdate']>
type Action = ConnectionSetupAuthenticationAction | Progress['actions'][number] | ConnectionSetupConfigurationAction
const stages: Record<Progress['stage'], { step: number; label: string }> = {
  authentication: { step: 2, label: 'Sign in to manage this bot' },
  'profile-preflight': { step: 3, label: 'Reading the bot’s current details' },
  'avatar-upload': { step: 3, label: 'Uploading the saved avatar' },
  'profile-write': { step: 3, label: 'Updating this bot’s profile' },
  'profile-readback': { step: 3, label: 'Checking the updated details' },
  'publication-create': { step: 4, label: 'Preparing the profile version' },
  'publication-submit': { step: 4, label: 'Submitting this version' },
  'publication-status': { step: 4, label: 'Checking the original version' }
}

export function ConsoleProfileProgress({ progress, started, sourceConfirmed, unconfirmed, authenticationConfirmed = false }: {
  progress?: Progress | undefined; started: boolean; sourceConfirmed: boolean; unconfirmed?: 'request' | 'progress' | undefined; authenticationConfirmed?: boolean
}) {
  const current = unconfirmed ? 0 : progress ? stages[progress.stage].step : started ? 2 : 1
  const complete = progress?.state === 'complete'
  return <nav className="bot-setup-guide" aria-label="Profile update progress" data-console-profile-progress>
    <ol>{['Saved profile', 'Sign in', 'Update bot', 'Publish'].map((label, index) => {
      const step = index + 1, confirmed = step === 1 ? sourceConfirmed : step === 2 && authenticationConfirmed || complete || step < current
      const status = confirmed ? 'Confirmed' : unconfirmed === 'progress' ? 'Result unavailable' : step !== current ? 'Not started' : progress?.state === 'attention' ? 'Needs attention' : progress?.state === 'approval-required' ? 'Awaiting platform approval' : progress?.state === 'pending' ? progress.stage === 'authentication' ? 'Awaiting confirmation' : 'Ready to continue' : started ? 'In progress' : 'Review profile'
      return <li key={label} data-step={step} data-state={confirmed ? 'recorded' : unconfirmed === 'progress' ? 'unknown' : step === current ? progress?.state === 'attention' ? 'attention' : 'current' : 'upcoming'} aria-current={step === current && !complete ? 'step' : undefined}>
        <span className="bot-setup-guide__number" aria-hidden="true">{confirmed ? '✓' : step}</span>
        <span><strong>{label}</strong><small>{status}</small></span>
      </li>
    })}</ol>
    <p>{unconfirmed === 'progress' ? 'The original management progress is not available yet. View saved progress to check its result.' : unconfirmed === 'request' ? 'The original management request is not available yet. Continue that same request to check its result.' : complete ? 'The original profile version is approved. The current online profile can be checked separately.' : progress ? stages[progress.stage].label : 'Review this Mote’s saved details before updating its bot.'}</p>
  </nav>
}

/** A disposable reader of the original management task. All progression belongs to Setup. */
export function MoteProfileSetup({ operation, automatic, onOperation }: {
  operation: MoteConnectionOperation; automatic: boolean; onOperation(value: MoteConnectionOperation): void
}) {
  const id = operation.setupOperationId!, parentId = operation.operationId
  const [reading, setReading] = useState<{ view: ConnectionSetupView | null; issue: string }>({ view: null, issue: '' })
  const [busy, setBusy] = useState(false), [driving, setDriving] = useState(automatic)
  const active = useRef(true), sequence = useRef(0), pending = useRef(false), callback = useRef(onOperation)
  callback.current = onOperation
  const original = operation.setup
  const summary = !original || reading.view?.operation && reading.view.operation.revision >= original.revision ? reading.view?.operation : original
  const currentReading = summary === reading.view?.operation
  const view = reading.issue || !currentReading ? null : reading.view, progress = currentReading ? reading.view?.profileUpdate : undefined
  function accept(value: ConnectionSetupView) {
    const target = operation.connection
    if (value.operation && (!target || value.operation.operationId !== id || value.operation.goal.kind !== 'profile-update' || value.operation.connectionId !== target.connectionId || value.operation.application.appId !== target.application.appId || value.operation.application.domain !== target.application.domain)) throw new Error('This management result does not belong to the original bot.')
    setReading(previous => previous.view?.operation && value.operation && previous.view.operation.revision > value.operation.revision ? previous : { view: value, issue: '' })
  }
  async function inspect() {
    const request = ++sequence.current
    try {
      let value = await api.connections.call('connection.setup.inspect', { operationId: id })
      if (value.profileUpdate?.publicationDraft) value = await api.connections.call('connection.setup.inspect', { operationId: id, applicationConfiguration: { effect: 'create-application-version', draft: value.profileUpdate.publicationDraft } })
      if (active.current && request === sequence.current) accept(value)
    } catch (error) { if (active.current && request === sequence.current) setReading(previous => ({ ...previous, issue: presentError(error) })) }
  }
  async function perform(setup?: ConnectionSetupAdvance, drive = false) {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const receipt = await api.moteConnections.call('space.mote.connection.advance', {
        operationId: parentId, ...(setup ? { setup } : {})
      })
      if (!active.current) return
      const authentication = receipt.setup?.authentication
      const stillWaiting = authentication?.request === 'confirmed' && authentication.secureStorage === 'stored' && (authentication.stage === 'waiting' || authentication.stage === 'scanned')
      // Refresh the private view before its still-waiting parent revision can unmount the QR.
      // Terminal or unknown results take effect immediately, even if the next local read stalls.
      if (!stillWaiting) callback.current(receipt)
      await inspect()
      if (!active.current) return
      if (stillWaiting) callback.current(receipt)
      if (drive) setDriving(true)
    } catch (error) { if (active.current) { setDriving(false); setReading(previous => ({ ...previous, issue: presentError(error) })) } }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  function advance(action: Action) {
    return perform({ operationId: id, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, ...(action.kind === 'create-application-version' && view?.profileUpdate?.publicationDraft ? { publicationDraft: view.profileUpdate.publicationDraft } : {}) }, action.kind === 'continue' || action.kind === 'renew')
  }
  useEffect(() => {
    active.current = true; void inspect()
    return () => { active.current = false; sequence.current++ }
  }, [id])
  useEffect(() => {
    const action = view?.continuation?.actions.find(action => action.kind === 'continue')
    if (!driving || busy || !action) return
    const timer = setTimeout(() => void advance(action), view?.challenge ? Math.max(0, view.challenge.nextPollAt - Date.now()) : 0)
    return () => clearTimeout(timer)
  }, [view, driving, busy])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void inspect(), 1000)
    return () => clearInterval(timer)
  }, [busy])
  const account = view?.continuation?.account
  const authentication = summary?.authentication
  const authActions = view?.continuation?.stage !== 'confirmed' ? view?.continuation?.actions ?? [] : []
  const publication = view?.profileUpdate?.publicationDraft && view.applicationConfiguration?.effect === 'create-application-version' ? view.applicationConfiguration : null
  const actions: Action[] = [...authActions, ...(view?.profileUpdate?.actions ?? []), ...(publication?.actions.filter(action => action.kind === 'create-application-version') ?? [])]
  const label = (action: Action) => action.kind === 'confirm-account' ? 'Use this account & update bot'
    : action.kind === 'renew' ? 'Get a new sign-in code'
    : action.kind === 'continue' ? 'Continue sign-in'
    : action.kind === 'recover-configuration-effect' ? 'Finish saving the original result'
    : action.kind === 'create-application-version' ? 'Publish this reviewed version'
    : progress?.stage === 'publication-status' ? 'Check the original version' : 'Continue this update'
  return <div className="mote-bot-task" data-console-profile-task={id}>
    <ConsoleProfileProgress progress={progress} started sourceConfirmed unconfirmed={progress ? undefined : reading.view?.operation || operation.setup ? 'progress' : 'request'} authenticationConfirmed={authentication?.stage === 'confirmed' && authentication.request === 'confirmed' && authentication.secureStorage === 'stored'} />
    <div className="mote-bot-task__content">
      <div className="mote-bot-request-heading"><strong>{operation.snapshot.name}</strong><span className="mote-details__hint">Update this bot’s public profile</span></div>
      <p className="mote-details__hint">Uses this Mote’s saved details and publishes them to the same bot. Its current audience is kept. Other Motes and groups sharing this bot will see the change.</p>
      {view?.challenge ? <div className="mote-bot-confirmation" data-mote-profile-code><BotConfirmationCode url={view.challenge.qrPayload} title="Sign in to manage this bot" /><p>Scan with Feishu, then confirm the account and enterprise here.</p></div> : null}
      {account ? <dl className="connector-management__account" aria-label="Account and enterprise to confirm"><div><dt>Account</dt><dd>{account.userName ?? account.userId}</dd></div><div><dt>Enterprise</dt><dd>{account.tenantName ?? account.tenantId}</dd></div></dl> : null}
      {publication?.review ? <section className="connector-next-step" aria-label="Pending changes to review"><div><strong>Review the other pending changes</strong><p>Publishing includes these application changes along with this profile update. Confirm the complete version before continuing.</p>
        {publication.review.changes.map(change => <div key={change.category}><strong>{change.category}</strong><ul>{change.details.map(detail => <li key={detail}>{detail}</li>)}</ul></div>)}
        <p>The complete current audience is kept. Version: {publication.draft?.kind === 'create-version' ? publication.draft.version : 'Not confirmed'}.</p>
        {publication.review.issues.map(issue => <p key={issue} role="status">{issue}</p>)}
      </div></section> : null}
      <div className="mote-bot-actions" aria-busy={busy}>
        {!reading.view?.operation && !operation.setup ? <button type="button" className="primary-button" disabled={busy} onClick={() => void perform(undefined, true)}>Continue original request</button> : null}
        {actions.filter(action => action.kind !== 'continue' || !driving).map(action => <button type="button" key={action.actionId} className={action.kind === 'renew' ? 'small-button' : 'primary-button'} data-mote-profile-action={action.kind} disabled={busy} onClick={() => void advance(action)}>{label(action)}</button>)}
        <button type="button" className="small-button" onClick={() => void inspect()}>View saved progress</button>
      </div>
      {busy ? <p role="status" className="mote-details__hint">{progress ? stages[progress.stage].label : 'Continuing the original request…'}</p> : driving && authActions.some(action => action.kind === 'continue') ? <p role="status" className="mote-details__hint">Waiting for your phone confirmation…</p> : null}
      {progress?.blockedBy ? <p role="status" className="mote-details__hint" data-profile-blocked>An earlier profile write for this bot is still unconfirmed. No new profile write was sent. Inspect its earlier profile receipt: <code>{progress.blockedBy.operationId}</code>.</p> : null}
      {progress?.state === 'attention' ? <p role="status" className="mote-details__hint">This step needs attention. Earlier confirmed results are kept; unconfirmed uploads or writes are not sent again. The original request trace is available below.</p> : null}
      {progress?.state === 'approval-required' ? <p role="status" className="mote-details__hint">The original version is awaiting platform approval. Check that version to see its latest status.</p> : null}
      {reading.issue ? <p role="status" className="mote-details__issue">{reading.issue} The original bot and request are kept.</p> : null}
      <details className="bot-profile-details"><summary>Original update details</summary><dl className="connector-identity"><div><dt>Application</dt><dd><code>{operation.connection?.application.appId}</code></dd></div><div><dt>Management request</dt><dd><code>{id}</code></dd></div>{progress?.versionId ? <div><dt>Original version</dt><dd><code>{progress.versionId}</code></dd></div> : null}</dl></details>
    </div>
    <ConnectionRequestTrace source={{ kind: 'setup', operationId: id }} revision={reading.view?.operation?.revision} title="Profile update requests" />
  </div>
}
