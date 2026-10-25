import { ConnectorAccountSummary } from './ConnectorEntityIdentity'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useRef, useState } from 'react'
import { connectionSetupDecisionForAction, type ConnectionSetupAdvance, type ConnectionSetupAuthenticationAction, type ConnectionSetupConfigurationAction, type ConnectionSetupView } from '@agentmux/core/connections'
import type { MoteConnectionOperation } from '@agentmux/core/mote-connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { BotSignInPrompt } from './BotConfirmationCode'
import { ConnectionRequestTrace } from './settings/ConnectionRequestTrace'
import '../styles/bot-setup-guide.css'
import '../styles/mote-profile-task.css'

type Progress = NonNullable<ConnectionSetupView['profileUpdate']>
type Action = ConnectionSetupAuthenticationAction | Progress['actions'][number] | ConnectionSetupConfigurationAction
type Publication = Extract<NonNullable<ConnectionSetupView['applicationConfiguration']>, { effect: 'create-application-version' | 'submit-application-version' }>
const LoadingIcon = semanticIconComponent('status.loading')
const CompletedIcon = semanticIconComponent('status.completed')
const WarningIcon = semanticIconComponent('status.warning')
const RefreshIcon = semanticIconComponent('action.refresh')
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

function profileResult(progress: Progress | undefined, publication: Publication | null) {
  if (progress?.blockedBy) return { title: 'An earlier profile result needs checking', detail: 'An earlier write for this bot is still unconfirmed. Check that original request before sending another update.' }
  if (publication?.reason === 'original-effect-unconfirmed') return { title: 'Publication result not confirmed', detail: 'Check the original publication request. Its result is still unknown.' }
  if (!progress) return { title: 'Checking this update’s saved progress', detail: 'The original bot and update are kept.' }
  if (progress.state === 'complete') return { title: 'Profile version approved', detail: 'This update’s original version is approved. The current online profile can be checked separately.' }
  if (progress.state === 'approval-required') return { title: 'Submitted, awaiting approval', detail: 'The platform is reviewing this original version. Check its status here.' }
  if (progress.stage === 'publication-create') return { title: 'Profile updated, not published', detail: progress.state === 'attention' ? 'The saved profile details are confirmed. Publication is not complete; follow the original result and checks below.' : 'The saved profile details are confirmed. Continue to publish the updated profile.' }
  if (progress.stage === 'publication-submit') return { title: 'Version created, publication pending', detail: 'This update’s original version is saved. Its publication is not confirmed yet.' }
  if (progress.stage === 'publication-status') return { title: 'Checking the original version', detail: 'Publication is not confirmed yet. Follow the result of this version here.' }
  if (progress.stage === 'authentication') return progress.state === 'attention'
    ? { title: 'Sign-in needs attention', detail: 'The original sign-in is not confirmed. Use the action below to continue this update.' }
    : { title: 'Sign in to update this bot', detail: 'Scan the code, then confirm the account and enterprise. The existing bot is kept.' }
  return progress.state === 'attention'
    ? { title: 'Profile update needs attention', detail: 'This step is not confirmed. Check the original request below; earlier confirmed results are kept.' }
    : { title: 'Updating this bot’s profile', detail: 'Uses the saved Mote details for this same bot. Publication follows the confirmed write.' }
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

  </nav>
}

/** A disposable reader of the original management task. All progression belongs to Setup. */
export function MoteProfileSetup({ operation, hostingTarget, automatic, onOperation }: {
  operation: MoteConnectionOperation; hostingTarget: ConnectionHostingTarget; automatic: boolean; onOperation(value: MoteConnectionOperation): void
}) {
  const id = operation.setupOperationId!, parentId = operation.operationId
  const [reading, setReading] = useState<{ view: ConnectionSetupView | null; issue: string; issueSource?: 'inspect' | 'advance' }>({ view: null, issue: '' })
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(true), [checked, setChecked] = useState(false), [driving, setDriving] = useState(automatic)
  const [manualPending, setManualPending] = useState(0)
  const [busyAction, setBusyAction] = useState<Action['kind'] | null>(null)
  const active = useRef(true), sequence = useRef(0), pending = useRef(false), callback = useRef(onOperation)
  callback.current = onOperation
  const original = operation.setup
  const summary = !original || reading.view?.operation && reading.view.operation.revision >= original.revision ? reading.view?.operation : original
  const currentReading = summary === reading.view?.operation
  const view = reading.issueSource === 'advance' || !currentReading ? null : reading.view
  const progress = reading.view?.profileUpdate
  function accept(value: ConnectionSetupView) {
    const target = operation.connection
    if (value.operation && (!target || value.operation.operationId !== id || value.operation.goal.kind !== 'profile-update' || value.operation.connectionId !== target.connectionId || value.operation.application.appId !== target.application.appId || value.operation.application.domain !== target.application.domain)) throw new Error('This management result does not belong to the original bot.')
    setReading(previous => previous.view?.operation && value.operation && previous.view.operation.revision > value.operation.revision ? previous : { view: value, issue: '' })
  }
  async function inspect(manual = false) {
    const request = ++sequence.current
    if (manual) setManualPending(count => count + 1)
    setChecking(true)
    try {
      const value = await api.connections.call('connection.setup.inspect', { operationId: id }, hostingTarget)
      if (active.current && request === sequence.current) { accept(value); setChecked(true) }
    } catch (error) { if (active.current && request === sequence.current) setReading(previous => previous.issueSource === 'advance' ? previous : { ...previous, issue: presentError(error), issueSource: 'inspect' }) }
    finally { if (active.current) { if (request === sequence.current) setChecking(false); if (manual) setManualPending(count => count - 1) } }
  }
  async function perform(setup?: ConnectionSetupAdvance, drive = false, actionKind: Action['kind'] | null = null) {
    if (pending.current) return
    pending.current = true; setBusyAction(actionKind); setBusy(true)
    try {
      const receipt = await api.moteConnections.call('space.mote.connection.advance', {
        operationId: parentId, ...(setup ? { setup } : {})
      }, hostingTarget)
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
    } catch (error) { if (active.current) { setDriving(false); setReading(previous => ({ ...previous, issue: presentError(error), issueSource: 'advance' })) } }
    finally { pending.current = false; if (active.current) { setBusy(false); setBusyAction(null) } }
  }
  function advance(action: Action) {
    return perform({ operationId: id, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, ...(action.kind === 'create-application-version' && view?.profileUpdate?.publicationDraft ? { publicationDraft: view.profileUpdate.publicationDraft } : {}) }, action.kind === 'continue' || action.kind === 'renew', action.kind)
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
  const configuration = reading.view?.applicationConfiguration
  const publication = configuration?.effect === 'create-application-version' || configuration?.effect === 'submit-application-version' ? configuration : null
  const publicationIssue = publication?.reason === 'original-effect-unconfirmed' ? 'The original publication result is unconfirmed. Check its original request before continuing.'
    : publication?.review ? null
    : publication?.reason === 'adapter-unavailable' ? 'The platform’s publication capability is unavailable. The original profile update is kept.'
    : publication?.reason === 'source-unconfirmed' ? 'The current saved checks do not yet provide a confirmed publication review. Refresh publication checks to read the current result.'
    : null
  const actions: Action[] = [...authActions, ...(view?.profileUpdate?.actions ?? []), ...(view?.profileUpdate?.publicationDraft && view.applicationConfiguration ? view.applicationConfiguration.actions.filter(action => action.kind === 'create-application-version') : [])]
  const result = view?.continuation?.stage === 'account'
    ? { title: 'Confirm your account', detail: 'Check the account and enterprise below, then confirm to update this bot.' }
    : !progress && !checking
    ? reading.issue
      ? { title: 'Saved progress unavailable', detail: 'The latest check could not be completed. View saved progress to check this original update.' }
      : { title: 'Update progress not confirmed', detail: 'Continue the original request to check its saved result.' }
    : profileResult(progress, publication)
  const retained = !!reading.view && (!currentReading || !!reading.issue)
  const waitingForPhone = driving && authActions.some(action => action.kind === 'continue')
  const working = busy || checking || manualPending > 0 || progress?.state === 'running' || waitingForPhone
  const activity = busyAction === 'refresh-publication-checks' ? 'Refreshing publication checks…'
    : waitingForPhone ? 'Waiting for your phone confirmation…'
    : busy ? progress?.stage === 'authentication' ? 'Checking sign-in confirmation…' : progress ? stages[progress.stage].label + '…' : 'Continuing the original request…'
    : checking || manualPending > 0 ? 'Checking saved progress…'
    : progress?.state === 'running' ? stages[progress.stage].label + '…'
    : retained ? 'Showing the last checked result'
    : checked ? 'Showing the latest saved result' : 'Reading saved progress…'
  const label = (action: Action) => action.kind === 'confirm-account' ? 'Use this account & update bot'
    : action.kind === 'renew' ? 'Get a new sign-in code'
    : action.kind === 'continue' ? 'Continue sign-in'
    : action.kind === 'refresh-publication-checks' ? 'Refresh publication checks'
    : action.kind === 'recover-configuration-effect' ? 'Finish saving the original result'
    : action.kind === 'create-application-version' ? 'Publish this reviewed version'
    : progress?.stage === 'publication-status' ? 'Check the original version'
    : progress?.stage === 'publication-create' ? 'Publish updated profile'
    : progress?.stage === 'publication-submit' ? 'Submit this version' : 'Continue this update'
  return <div className="mote-bot-task mote-profile-task" data-console-profile-task={id}>
    <ConsoleProfileProgress progress={progress} started sourceConfirmed unconfirmed={progress ? undefined : reading.view?.operation || operation.setup ? 'progress' : 'request'} authenticationConfirmed={authentication?.stage === 'confirmed' && authentication.request === 'confirmed' && authentication.secureStorage === 'stored'} />
    <div className="mote-bot-task__content">
      <div className="bot-task-eyebrow">{operation.snapshot.name} · Profile update</div>
      <section className="mote-profile-result" data-profile-result data-state={progress?.state ?? 'unknown'} aria-label="Current profile update result">
        <span className="mote-profile-result__icon" aria-hidden="true">{progress?.state === 'complete' ? <CompletedIcon size={18} /> : progress?.state === 'attention' ? <WarningIcon size={18} /> : <RefreshIcon size={18} />}</span>
        <div><h4>{result.title}</h4><p>{result.detail}</p>{retained ? <p className="mote-profile-result__retained">Showing the last checked result. {reading.issue ? 'The latest check could not be completed.' : 'Refreshing the updated progress.'}</p> : null}</div>
      </section>
      <div className="mote-profile-activity" role="status" aria-live="polite" data-profile-activity data-working={working}>
        <span className="mote-profile-activity__icon" aria-hidden="true">{working ? <LoadingIcon size={14} animation="spin" /> : checked && !retained ? <CompletedIcon size={14} /> : <RefreshIcon size={14} />}</span><span>{activity}</span>
      </div>
      {view?.challenge ? <div className="mote-bot-confirmation" data-mote-profile-code><BotSignInPrompt url={view.challenge.qrPayload} title="Sign in to manage this bot" platform={operation.connection?.application.domain === 'open.larksuite.com' ? 'Lark' : 'Feishu'} scanned={authentication?.stage === 'scanned'} /></div> : null}
      {account ? <ConnectorAccountSummary identityKey={JSON.stringify([hostingTarget, id])} account={account} label="Account and enterprise to confirm" /> : null}
      {publication?.review && (publication.review.changes.length || publication.review.issues.length) ? <section className="mote-profile-checks" aria-label="Publication checks"><div><strong>{publication.review.changes.length ? 'Review the other pending changes' : 'Publication checks'}</strong>{publication.review.changes.length ? <p>Publishing includes these application changes along with this profile update. Confirm the complete version before continuing.</p> : null}
        {publication.review.changes.map(change => <div key={change.category}><strong>{change.category}</strong><ul>{change.details.map(detail => <li key={detail}>{detail}</li>)}</ul></div>)}
        <p>{publication.review.audience ? 'The complete current audience is kept.' : 'The current audience is not confirmed yet.'} Candidate version: {publication.draft?.kind === 'create-version' ? publication.draft.version : 'Not confirmed'}.</p>
        {publication.review.issues.length ? <ul className="mote-profile-checks__issues">{publication.review.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
      </div></section> : null}
      {publicationIssue ? <p role="status" className="mote-details__hint" data-publication-unavailable>{publicationIssue}</p> : null}
      <div className="mote-bot-actions mote-profile-actions" aria-busy={busy}>
        {!reading.view?.operation && !operation.setup ? <button type="button" className="primary-button" disabled={busy} onClick={() => void perform(undefined, true)}>Continue original request</button> : null}
        {actions.filter(action => action.kind !== 'continue' || !driving).map(action => <button type="button" key={action.kind} className={action.kind === 'renew' || action.kind === 'refresh-publication-checks' ? 'small-button' : 'primary-button'} data-mote-profile-action={action.kind} disabled={busy} onClick={() => void advance(action)}>{action.kind === 'refresh-publication-checks' || action.kind === 'renew' ? <RefreshIcon size={14} /> : null}<span>{label(action)}</span></button>)}
        <button type="button" className="small-button mote-profile-actions__inspect" aria-busy={manualPending > 0} onClick={() => void inspect(true)}>{manualPending > 0 ? <LoadingIcon size={14} animation="spin" /> : <RefreshIcon size={14} />}<span>View saved progress</span></button>
      </div>
      {progress?.blockedBy ? <p role="status" className="mote-details__hint" data-profile-blocked>An earlier profile write for this bot is still unconfirmed. No new profile write was sent. Inspect its earlier profile receipt: <code>{progress.blockedBy.operationId}</code>.</p> : null}
      {reading.issue ? <p role="status" className="mote-details__issue">{reading.issue} The original bot and request are kept.</p> : null}
      <p className="mote-profile-scope">Updates this same bot using the saved Mote profile. Its current audience is kept. Other Motes and groups sharing the bot will see the published change.</p>
      <details className="bot-profile-details"><summary>Original update details</summary><dl className="connector-identity"><div><dt>Application</dt><dd><code>{operation.connection?.application.appId}</code></dd></div><div><dt>Management request</dt><dd><code>{id}</code></dd></div>{progress?.versionId ? <div><dt>Original version</dt><dd><code>{progress.versionId}</code></dd></div> : null}</dl></details>
    </div>
    <ConnectionRequestTrace hostingTarget={hostingTarget} source={{ kind: 'setup', operationId: id }} revision={reading.view?.operation?.revision} setupView={reading.view} diagnosisTarget={{ kind: 'mote', operationId: parentId, sourceTarget: operation.source.target, action: 'sync' }} title="Profile update requests" />
  </div>
}
