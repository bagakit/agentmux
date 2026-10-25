import { ConnectorAccountSummary } from './ConnectorEntityIdentity'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useRef, useState } from 'react'
import { connectionProfileAvatarDigest, type ConnectionRecord, type ConnectionEnrollmentActionKind } from '@agentmux/core/connections'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteConnectionOperation } from '@agentmux/core/mote-connections'
import { useMoteBotSetup } from '../lib/use-mote-bot-setup'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { generatedBotName } from '../lib/bot-creation-preset'
import { api } from '../lib/api'
import { SelectionField } from './SelectionField'
import { BotSignInPrompt } from './BotConfirmationCode'
import { ConnectionProfileResult } from './ConnectionProfileResult'
import { ConnectionProfileProgress } from './ConnectionProfileProgress'
import { ConsoleProfileProgress, MoteProfileSetup } from './MoteProfileSetup'
import { InitialBotSetupResult, initialSetupStageLabels } from './settings/InitialBotSetupResult'
import { ConnectionProfileTrace } from './settings/ConnectionProfileTrace'
import { ConnectionRequestTrace } from './settings/ConnectionRequestTrace'
import { BotSetupGuide, type BotSetupGuideStage } from './settings/BotSetupGuide'
import '../styles/connector-experience.css'

const LoadingIcon = semanticIconComponent('status.loading')
const creationComplete = (operation: MoteConnectionOperation, enrollment = operation.enrollment) => !!enrollment?.configured && operation.defaultLink.state === 'saved' &&
  (!enrollment.initialPublication || enrollment.initialSetup?.progress?.state === 'complete')

const enrollmentActionLabel: Record<ConnectionEnrollmentActionKind, string> = {
  'continue-authentication': 'Check sign-in',
  'confirm-account': 'Confirm this account',
  'renew-authentication': 'Get a new sign-in code',
  create: 'Create this bot',
  'read-credential': 'Read this application’s credential',
  'recover-local': 'Check saved progress',
  'continue-setup': 'Continue original setup'
}

export function MoteBotSetup({
  target,
  topicId,
  record,
  hasSavedBot,
  onChoose,
  onCurrent,
  createOnOpen = false,
  onCreateIntentConsumed,
  onContinue,
  hostingTarget
}: {
  target: MotePreferencesTarget | null
  hostingTarget?: ConnectionHostingTarget | null | undefined
  topicId: string
  record: ConnectionRecord | null
  hasSavedBot: boolean
  onChoose(): void
  onCurrent(): void
  createOnOpen?: boolean
  onCreateIntentConsumed?: (() => void) | undefined
  onContinue?: ((record: ConnectionRecord, source: { kind: 'enrollment'; operationId: string; expectedRevision: number }, hostingTarget: ConnectionHostingTarget) => void) | undefined
}) {
  const setup = useMoteBotSetup(target, topicId, hostingTarget),
    [avatar, setAvatar] = useState(true),
    [issuer, setIssuer] = useState('')
  const [nameSource, setNameSource] = useState('mote'), [manualName, setManualName] = useState<string | null>(null)
  const newDraft = () => { setNameSource('mote'); setManualName(null); setup.newIntent() }
  const [separate, setSeparate] = useState(false), [replacing, setReplacing] = useState(false)
  const shortcut = useRef(createOnOpen)
  const available = setup.capabilities.filter((item) => item.availability === 'available')
  const capability =
    available.find((item) => JSON.stringify([item.adapterId, item.domain]) === issuer) ??
    available[0]
  const operation = setup.operation,
    raw = setup.requests.find((item) => item.input.operationId === setup.selectedId)
  const selected = operation ?? raw ?? setup.selectedId,
    ids = new Set(setup.operations.map((item) => item.operationId))
  const history = [
    ...setup.operations.map((item) => ({
      id: item.operationId,
      name: item.snapshot.name,
      action: item.action
    })),
    ...setup.requests
      .filter((item) => !ids.has(item.input.operationId))
      .map((item) => ({
        id: item.input.operationId,
        name: 'Unconfirmed bot setup',
        action: item.action
      }))
  ]
  const unfinished = setup.operations.find(
    (item) => item.action === 'create' && !creationComplete(item)
  )
  const resumeId =
    unfinished?.operationId ??
    setup.requests.find((item) => item.action === 'create' && !ids.has(item.input.operationId))?.input.operationId
  useEffect(() => {
    if (!shortcut.current) return
    if (setup.selectedId) {
      if (setup.checking) return
      let current = true
      const consume = (complete: boolean) => {
        if (!current) return
        shortcut.current = false
        onCreateIntentConsumed?.()
        if (complete) newDraft()
      }
      if (operation?.action === 'sync' && operation.setupOperationId) {
        const operationId = operation.setupOperationId
        void api.connections.call('connection.setup.inspect', { operationId }, setup.hostingTarget ?? undefined)
          .then(view => consume(view.operation?.operationId === operationId && view.profileUpdate?.state === 'complete'))
          .catch(() => consume(false))
      } else consume(operation?.action === 'create' && creationComplete(operation))
      return () => { current = false }
    }
    if (!setup.historyReady || setup.loading || !setup.profile || !capability) return
    shortcut.current = false
    onCreateIntentConsumed?.()
    if (resumeId) void setup.check(resumeId)
  }, [setup.selectedId, setup.checking, operation, setup.historyReady, setup.loading, setup.profile, capability, resumeId])
  const enrollment = setup.enrollmentView?.operation && setup.enrollmentView.operation.operationId === operation?.enrollmentOperationId && setup.enrollmentView.operation.revision >= (operation?.enrollment?.revision ?? 0) && (!operation?.enrollment?.initialSetup || setup.enrollmentView.operation.initialSetup?.operationId === operation.enrollment.initialSetup.operationId) ? setup.enrollmentView.operation : operation?.enrollment
  const initialSetup = enrollment?.initialSetup, initialProgress = initialSetup?.progress
  const completedCreation = operation?.action === 'create' && !!enrollment?.initialPublication && creationComplete(operation, enrollment)
  const publishedWithoutChoice = operation?.action === 'create' && initialProgress?.state === 'complete' && operation.defaultLink.state !== 'saved'
  const challenge = setup.enrollmentView?.challenge,
    busy = !!setup.selectedId && setup.busy.includes(setup.selectedId)
  const enrollmentActions = (setup.enrollmentView?.actions ?? []).filter(
    action => action.kind !== 'recover-local'
  )
  const primaryEnrollmentAction =
    enrollmentActions.find(action => action.kind !== 'renew-authentication') ?? enrollmentActions[0]
  const enrollmentTitle = primaryEnrollmentAction
    ? {
        'continue-authentication': 'Sign in to your account',
        'confirm-account': 'Check the account and enterprise',
        'renew-authentication': enrollment?.authentication?.stage === 'expired' ? 'Sign-in code expired' : 'Sign-in result not confirmed',
        create: 'Ready to create this bot',
        'read-credential': 'Finish saving this bot',
        'recover-local': 'Check the original save',
        'continue-setup': 'Continue original setup'
      }[primaryEnrollmentAction.kind]
    : null
  const enrollmentPlatform = enrollment
    ? (setup.capabilities.find(
        (item) => item.adapterId === enrollment.adapterId && item.domain === enrollment.domain
      )?.label ?? enrollment.domain)
    : ''
  const savedConnection = enrollment?.configured?.connection
  const profileTask = selected ? operation?.action === 'sync' || raw?.action === 'sync' : !!record && !replacing
  const candidateImage = raw && !raw.inspectOnly ? raw.input.desired.avatar?.pngDataUrl : setup.profile?.image
  const originalImage = candidateImage && connectionProfileAvatarDigest(candidateImage) === operation?.snapshot.avatarSha256 ? candidateImage : null
  const hasCurrentAction = !!primaryEnrollmentAction || !!savedConnection && !enrollment?.initialPublication && !!onContinue && !!setup.hostingTarget
  const guideStage: BotSetupGuideStage = !selected ? 'prepare'
    : savedConnection ? enrollment?.initialPublication && initialProgress?.state !== 'complete' ? initialProgress?.state === 'attention' ? 'attention' : 'connect' : operation?.defaultLink.state === 'saved' ? 'ready' : 'bind'
    : primaryEnrollmentAction?.kind === 'confirm-account' ? 'account'
    : primaryEnrollmentAction?.kind === 'create' ? 'create'
    : challenge || primaryEnrollmentAction?.kind === 'continue-authentication' ? 'scan'
    : primaryEnrollmentAction?.kind === 'read-credential' || enrollment?.application ? 'connect'
    : 'attention'
  const originalResults = operation ? (
    <dl className="mote-bot-stages" aria-label="Original bot setup results">
      {enrollment ? (
        <>
          <div>
            <dt>Application</dt>
            <dd>
              {enrollment.authorization === 'authorized'
                ? 'Created'
                : enrollment.authorization === 'pending'
                  ? 'Waiting for platform confirmation'
                  : enrollment.authorization === 'denied'
                    ? 'Platform declined'
                    : enrollment.authorization === 'expired'
                      ? 'Confirmation expired; creation not inferred'
                      : 'Creation not confirmed'}
            </dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>
              {enrollment.configured ? 'Saved on this environment' : 'Save not complete'}
            </dd>
          </div>
        </>
      ) : null}
      {operation.action === 'create' ? (
        <div>
          <dt>Mote default</dt>
          <dd>
            {operation.defaultLink.state === 'saved'
              ? 'Original save confirmed'
              : operation.defaultLink.state === 'conflict'
                ? 'The saved choice changed. Review a new association.'
                : operation.defaultLink.state === 'unknown'
                  ? 'Original save not confirmed'
                  : 'Not saved yet'}
          </dd>
        </div>
      ) : null}
    </dl>
  ) : null
  const originalActions = operation ? (
    <div className="mote-bot-actions">
      <button
        type="button"
        className={completedCreation || publishedWithoutChoice || primaryEnrollmentAction ? 'small-button' : 'primary-button'}
        aria-busy={busy || setup.checking}
        disabled={busy}
        onClick={() => void setup.check(operation.operationId)}
      >
        {busy || setup.checking ? <LoadingIcon size={14} animation="spin" /> : null}Check saved progress
      </button>
    </div>
  ) : null
  const setupFeedback = setup.issue && setup.issueKind === 'issue' ? <p role="status" className="mote-details__issue">{setup.issue}</p> : null
  const taskTitle = completedCreation ? 'Bot setup complete'
    : publishedWithoutChoice ? 'Bot published. Choose it for your Mote.'
    : savedConnection && enrollment?.initialPublication ? initialProgress?.state === 'approval-required' ? 'Waiting for platform approval' : initialProgress?.state === 'attention' ? 'Check this setup step' : 'Setting up your bot'
    : challenge ? enrollment?.authentication?.stage === 'scanned' ? 'Confirm on your phone' : 'Sign in to connect your bot'
    : enrollmentTitle ?? (profileTask ? 'Update this bot’s profile' : 'Check your bot setup')
  const working = busy || setup.checking || initialProgress?.state === 'running' || setup.driving && !!challenge
  const activity = setup.driving && challenge ? 'Waiting for your phone confirmation…'
    : busy || setup.checking ? savedConnection && enrollment?.initialPublication ? 'Checking configuration and publication…' : 'Checking this setup…'
    : initialProgress?.state === 'approval-required' ? 'The platform is reviewing your application.'
    : initialProgress?.state === 'attention' ? 'Your next action is shown below.'
    : completedCreation ? 'Published and saved for this Mote.' : primaryEnrollmentAction?.kind === 'confirm-account' ? 'Your confirmation is needed to continue.' : 'Continue from the saved result below.'
  if (profileTask && operation?.setupOperationId) return <section className="mote-bot-setup" aria-label="Mote bot profile">
    <button type="button" className="small-button" onClick={() => { newDraft(); onCurrent() }}>Back to bot profile</button>
    <MoteProfileSetup key={operation.operationId} operation={operation} hostingTarget={operation.hostingTarget} automatic={setup.driving} onOperation={setup.acceptOperation} />
    {setupFeedback}
  </section>
  return (
    <section className="mote-bot-setup" aria-label="Mote bot profile" data-bot-journey-stage={profileTask ? undefined : guideStage}>
      <div className="mote-bot-task">
      {profileTask ? operation?.profileOperationId ? <ConnectionProfileProgress operation={operation.profile} started sourceConfirmed /> : <ConsoleProfileProgress started={!!selected} sourceConfirmed={selected ? !!operation?.snapshot : !!setup.profile} unconfirmed={selected && !operation?.setup ? 'request' : undefined} /> : <BotSetupGuide stage={guideStage} currentStatus={initialProgress ? initialProgress.state === 'complete' ? 'Confirmed' : initialSetupStageLabels[initialProgress.stage] : enrollment?.application && !savedConnection ? 'Created · saving' : undefined} confirmedSteps={[...(setup.profile || operation?.snapshot ? [1] : []), ...(enrollment?.authentication?.stage === 'confirmed' ? [2] : []), ...(enrollment?.application ? [3] : []), ...(completedCreation ? [4] : [])]} currentStep={completedCreation ? null : !selected ? 1 : savedConnection ? 4 : enrollment?.application || primaryEnrollmentAction?.kind === 'create' ? 3 : 2} />}
      <div className="mote-bot-task__content">
      {!selected ? (
        <>
          <header className="bot-task-heading"><span className="bot-task-eyebrow">{profileTask ? 'Saved bot' : hasSavedBot ? 'Another bot' : 'New bot'}</span><h3>{profileTask ? 'Bring your bot’s profile up to date' : 'Give your Mote a bot'}</h3><p>{profileTask ? 'Review the saved name, image and description before updating.' : 'Start with this Mote’s profile, then sign in to create its bot.'}</p></header>
          {setup.profile ? (
            <>
              <div className="mote-bot-profile">
                {setup.profile.image ? (
                  <img width={48} height={48} src={setup.profile.image} alt="Current Mote avatar" />
                ) : null}
                <div>
                  <span className="mote-details__hint">From the saved Mote profile</span>
                  <strong>{setup.profile.name}</strong>
                  {setup.profile.description ? (
                    <p>{setup.profile.description}</p>
                  ) : (
                    <p className="mote-details__hint">
                      No public description is saved. The bot’s primary description will be empty.
                    </p>
                  )}
                </div>
              </div>
              {setup.profile.image && record && !replacing ? (
                <label className="mote-bot-avatar">
                  <input
                    type="checkbox"
                    checked={avatar}
                    onChange={(event) => setAvatar(event.target.checked)}
                  />
                  Use this Mote’s avatar
                </label>
              ) : !setup.profile.image && record && !replacing ? (
                <p className="mote-details__hint">
                  {setup.profile.avatarIssue ??
                    'The current Mote avatar could not be read. The bot’s avatar will be kept.'}
                </p>
              ) : null}
            </>
          ) : (
            <p role="status" className="mote-details__hint">
              {setup.loading
                ? 'Reading the saved profile…'
                : 'Saved public profile not available yet.'}
            </p>
          )}
          {record && !replacing ? (
            <>
              <p className="mote-details__hint">
                Update <strong>{record.config.label}</strong>. This changes the same bot used by any
                other Motes and groups sharing this application.
              </p>
              <div className="mote-bot-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!setup.profile}
                  onClick={() => void setup.sync(record, avatar && !!setup.profile?.image)}
                >
                  Sync Mote profile
                </button>
                <button type="button" className="small-button" onClick={onChoose}>
                  Change bot
                </button>
              </div>
              <details className="mote-bot-replacement"><summary>Create a replacement identity</summary><p className="mote-details__hint">Create another bot using this Mote’s name and avatar. The current identity stays until the new one is saved; existing groups keep their bot.</p><button type="button" className="small-button" data-mote-identity-replace onClick={() => { setReplacing(true); setSeparate(true); setAvatar(true); newDraft() }}>Prepare replacement</button></details>
            </>
          ) : (
            <>
              {replacing ? <p className="mote-details__hint">A new identity for this Mote. Its current bot stays in place while you finish.</p> : null}
              {setup.profile ? <div className="mote-bot-name">
                <div className="mote-bot-name__heading"><span>Bot name</span><SelectionField label="Bot name source" value={nameSource}
                  options={[{ value: 'mote', label: 'Use Mote name' }, { value: 'manual', label: 'Enter manually' }]}
                  onValueChange={value => { if (value === 'manual' && manualName === null) setManualName(generatedBotName()); setNameSource(value) }} /></div>
                <TextInput aria-label="Bot name" readOnly={nameSource === 'mote'} value={nameSource === 'mote' ? setup.profile.name : manualName ?? ''}
                  onChange={event => setManualName(event.target.value)} autoComplete="off" spellCheck={false} />
                <small>{nameSource === 'mote' ? 'Uses this Mote’s saved name. Its profile stays unchanged.' : 'Only names the new bot. This Mote and existing bots stay unchanged.'}</small>
              </div> : null}
              {available.length > 1 ? (
                <SelectionField
                  label="Mote bot platform"
                  value={
                    capability ? JSON.stringify([capability.adapterId, capability.domain]) : ''
                  }
                  options={available.map((item) => ({
                    value: JSON.stringify([item.adapterId, item.domain]),
                    label: item.label
                  }))}
                  onValueChange={setIssuer}
                />
              ) : null}
              <div className="mote-bot-actions">
                {resumeId && !separate ? (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void setup.check(resumeId)}
                  >
                    Resume original setup
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-button"
                    data-mote-bot-create
                    disabled={!setup.profile?.image || !capability || nameSource === 'manual' && !manualName?.trim()}
                    onClick={() => {
                      setSeparate(false)
                      capability && void setup.begin(capability, true, nameSource === 'manual' ? manualName! : undefined)
                    }}
                  >
                    Sign in & continue
                  </button>
                )}
                <button type="button" className="small-button" onClick={onChoose}>
                  Choose existing bot
                </button>
              </div>
              {!capability ? (
                <p className="mote-details__hint">
                  Bot creation is unavailable here. Existing bot choices are still available.
                </p>
              ) : null}
            </>
          )}
          {!setup.profile?.image && setup.profile && (!record || replacing) ? <p className="mote-details__hint">{setup.profile.avatarIssue ?? 'The current Mote avatar could not be read. Refresh this profile to try again.'}</p> : null}
          <button type="button" className="connector-enrollment__text-action" onClick={() => { void setup.refreshSource(); void setup.list() }}>
            Refresh saved profile
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="small-button"
            onClick={() => {
              setSeparate(false)
              setReplacing(false)
              newDraft()
              onCurrent()
            }}
          >
            Back to bot profile
          </button>
          <header className="bot-task-heading">
            <span className="bot-task-eyebrow">{operation?.snapshot.name ?? 'Bot setup'}{enrollmentPlatform ? ` · ${enrollmentPlatform}` : ''}</span>
            <h3>{taskTitle}</h3>
            {completedCreation ? <p>Created, configured and published. To start a conversation, create or connect a group from your Agent’s menu.</p> : primaryEnrollmentAction?.kind === 'confirm-account' ? <p>Choose the account and enterprise that will own this bot.</p> : primaryEnrollmentAction?.kind === 'renew-authentication' ? <p>{enrollment?.authentication?.stage === 'expired' ? 'This code has expired. Get a new code to continue the same setup.' : 'Sign-in could not be confirmed. Get a new code to continue the same setup.'}</p> : null}
          </header>
          {completedCreation && operation ? <div className="mote-bot-profile bot-task-complete-profile">{originalImage ? <img width={48} height={48} src={originalImage} alt="Avatar chosen for this bot" /> : null}<div><strong>{operation.snapshot.name}</strong><span>Message delivery is checked when you connect a group.</span></div></div> : null}
          {publishedWithoutChoice ? <div className="mote-bot-next"><p>{operation.defaultLink.state === 'conflict' ? 'This Mote’s bot choice changed while setup was running.' : 'This bot is published, but its saved choice for this Mote is not confirmed.'} Choose the saved bot to use for new conversations.</p><button type="button" className="primary-button" onClick={onChoose}>Choose a saved bot</button></div> : null}
          {challenge ? <div className="mote-bot-confirmation" data-mote-bot-code><BotSignInPrompt url={challenge.qrPayload} title={enrollmentPlatform ? `Sign in to ${enrollmentPlatform}` : 'Sign in to the bot platform'} platform={enrollmentPlatform || 'the bot platform'} scanned={enrollment?.authentication?.stage === 'scanned'} /></div> : null}
          {setup.enrollmentView?.account ? <ConnectorAccountSummary identityKey={JSON.stringify([setup.hostingTarget, enrollment?.operationId])} account={setup.enrollmentView.account} label="Account and enterprise for this bot" /> : null}
          <div className="bot-task-activity" role="status" data-bot-task-reading={setup.checking || undefined} aria-busy={working}>
            {working ? <LoadingIcon size={14} animation="spin" /> : null}<span>{activity}</span>
          </div>
          {primaryEnrollmentAction?.kind === 'create' && operation ? <div className="mote-bot-creation" aria-label="Bot to create">
            <div className="mote-bot-profile">
              {originalImage ? <img width={48} height={48} src={originalImage} alt="Avatar chosen for this bot" /> : null}
              <div><span className="mote-details__hint">Your new bot</span><strong>{operation.snapshot.name}</strong>{operation.snapshot.description ? <p>{operation.snapshot.description}</p> : null}</div>
            </div>
            {!originalImage ? <p className="mote-details__hint">The avatar chosen for the original setup is kept. Its preview is unavailable.</p> : null}
            <p className="mote-details__hint">{enrollment?.initialPublication ? 'Creates this bot with the chosen public details, configures conversations and publishes its first version for your account only. Requests access to this app’s own resources to identify its creator for group invitations. Platform approval may still be required.' : 'Creates one bot with the chosen public details and saves it in AgentMux. Configuration and publication are separate steps.'}</p>
          </div> : null}
          {enrollmentActions.length ? (
            <div className="mote-bot-actions mote-bot-auth-actions">
              {enrollmentActions.map(action => (
                <button
                  key={action.actionId}
                  data-mote-enrollment-action={action.kind}
                  type="button"
                  className={action === primaryEnrollmentAction ? 'primary-button' : 'small-button'}
                  disabled={busy}
                  onClick={() => operation && void setup.check(operation.operationId, true, action)}
                >
                  {busy ? <LoadingIcon size={14} animation="spin" /> : null}{action.kind === 'create' && enrollment?.initialPublication ? 'Create, configure & publish' : action.kind === 'continue-setup' && initialProgress?.state === 'approval-required' ? 'Check approval status' : action.kind === 'continue-setup' && initialProgress?.state === 'attention' ? 'Check this setup' : enrollmentActionLabel[action.kind]}
                </button>
              ))}
            </div>
          ) : null}
          {setup.progressIssue ? <p role="status" className="mote-details__hint">{setup.progressIssue}</p> : null}{setupFeedback}
          {operation ? (
            <>
              {savedConnection && !enrollment?.initialPublication && onContinue && setup.hostingTarget ? <div className="mote-bot-next">
                <strong>Identity saved. Connect your bot.</strong>
                <p>Continue with this bot’s saved sign-in to review message settings and publish it.</p>
                <button type="button" className="primary-button" data-mote-bot-continue onClick={() => onContinue(savedConnection, { kind: 'enrollment', operationId: enrollment!.operationId, expectedRevision: enrollment!.revision }, setup.hostingTarget!)}>Continue bot setup</button>
              </div> : null}
              {enrollment?.configured && enrollment.initialPublication && !completedCreation ? <InitialBotSetupResult progress={initialProgress ?? null} /> : null}
              {operation.profile ? (
                profileTask ? <ConnectionProfileResult operation={operation.profile} /> : <details className="bot-profile-details"><summary>Profile sync result</summary>
                <ConnectionProfileResult operation={operation.profile} />
                </details>
              ) : profileTask && operation.connection ? (
                <p className="mote-details__hint">
                  The profile update has not been confirmed yet. The saved connection is kept.
                </p>
              ) : null}
              {operation.defaultLink.state === 'unknown' ||
              operation.defaultLink.state === 'conflict' ? (
                <p className="mote-details__hint">
                  Reading the current choice does not confirm the original save. Choose this same
                  saved bot explicitly to make a new association; its existing setup is kept.
                </p>
              ) : null}
              {!hasCurrentAction ? originalActions : null}
              <details className="bot-profile-details">
                <summary>Original setup details</summary>
                {originalResults}{hasCurrentAction ? originalActions : null}{setup.issueKind === 'notice' && setup.issue ? <p>{setup.issue}</p> : null}
                <dl>
                  <div>
                    <dt>Original request</dt>
                    <dd>
                      <code>{operation.operationId}</code>
                    </dd>
                  </div>
                  {operation.connection ? (
                    <div>
                      <dt>Application</dt>
                      <dd>
                        <code>{operation.connection.application.appId}</code>
                      </dd>
                    </div>
                  ) : null}
                  {operation.defaultLink.current ? (
                    <div>
                      <dt>Last observed default</dt>
                      <dd>
                        {operation.defaultLink.current.connection?.application.appId ??
                          'No default bot'}{' '}
                        — current value, not a save receipt
                      </dd>
                    </div>
                  ) : null}
                  {operation.issue ? (
                    <div>
                      <dt>Unconfirmed step</dt>
                      <dd>{operation.issue}</dd>
                    </div>
                  ) : null}
                  {enrollment?.diagnostic ? <div><dt>Platform check</dt><dd>{enrollment.diagnostic.stage} · {enrollment.diagnostic.code}{enrollment.diagnostic.stage === 'authentication' ? [enrollment.diagnostic.step, enrollment.diagnostic.failure, enrollment.diagnostic.boundary, enrollment.diagnostic.redirectReason].filter(Boolean).map(value => ` · ${value}`).join('') : ''}{'httpStatus' in enrollment.diagnostic && enrollment.diagnostic.httpStatus ? ` · HTTP ${enrollment.diagnostic.httpStatus}` : ''}</dd></div> : null}
                </dl>
              </details>
            </>
          ) : (
            <>
              {!setup.checking ? <p role="status">{!setup.hostingTarget ? 'The original bot hosting owner is unconfirmed. The original request is kept without contacting another Host.' : raw ? 'The result is not confirmed. Your original request is retained.' : 'The original request could not be read. Its identifier is kept; no new setup was started.'}</p> : null}
              {!raw ? <code>{setup.selectedId}</code> : null}
              {setup.hostingTarget ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void setup.check(setup.selectedId!)}
                >
                  Check original result
                </button>
              ) : null}
              {raw?.hostingTarget && raw.phase === 'not-dispatched' && !raw.inspectOnly ? (
                <button type="button" className="small-button" onClick={() => void setup.send(raw)}>
                  Continue this request
                </button>
              ) : null}
            </>
          )}
        </>
      )}
      </div>
      </div>
      {profileTask && operation?.profileOperationId ? <ConnectionProfileTrace hostingTarget={setup.hostingTarget} operationId={operation?.profileOperationId ?? undefined} parentId={operation?.operationId ?? setup.selectedId!} original={operation?.profile} /> : !profileTask || selected ? <ConnectionRequestTrace hostingTarget={setup.hostingTarget} source={enrollment ? { kind: 'enrollment', operationId: enrollment.operationId } : null} revision={enrollment?.revision} enrollmentView={setup.enrollmentView} diagnosisTarget={setup.selectedId ? { kind: 'mote', operationId: setup.selectedId, sourceTarget: target, ...(raw ? { action: raw.action, phase: raw.phase } : {}) } : null} title={profileTask ? "Profile update requests" : enrollment?.initialSetup ? "Sign-in & creation requests" : undefined} /> : null}
      {!profileTask && enrollment?.configured && initialSetup ? <ConnectionRequestTrace hostingTarget={setup.hostingTarget} source={{ kind: 'setup', operationId: initialSetup.operationId }} revision={JSON.stringify(initialProgress)} hideCopy title="Configuration & publication requests" /> : null}
      {resumeId || selected ? (
        <details className="mote-bot-history">
          <summary>Create another bot</summary>
          <p className="mote-details__hint">
            A separate setup may create another bot. All previous requests remain available.
          </p>
          <button
            type="button"
            className="small-button"
            onClick={() => {
              newDraft()
              setSeparate(true)
              onCurrent()
            }}
          >
            Start a separate setup
          </button>
        </details>
      ) : null}
      {!selected ? setupFeedback : null}
      {history.length ? (
        <details className="mote-bot-history">
          <summary>Previous bot operations</summary>
          {history.map((item) => (
            <button
              type="button"
              className="small-button"
              key={item.id}
              data-mote-bot-operation={item.id}
              onClick={() => {
                setup.select(item.id)
                void setup.check(item.id)
              }}
            >
              {item.name} · {item.action === 'create' ? 'Creation' : 'Profile update'}
            </button>
          ))}
          {setup.next ? (
            <button
              type="button"
              className="small-button"
              onClick={() => void setup.list(setup.next!)}
            >
              Load earlier operations
            </button>
          ) : null}
        </details>
      ) : null}
    </section>
  )
}
