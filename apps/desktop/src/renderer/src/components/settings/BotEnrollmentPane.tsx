import { useEffect, useRef, useState } from 'react'
import { BotConfirmationCode } from '../BotConfirmationCode'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type {
  ConnectionEnrollmentBeginInput,
  ConnectionEnrollmentCapability,
  ConnectionEnrollmentDiagnostic,
  ConnectionEnrollmentOperation,
  ConnectionEnrollmentView,
  ConnectionEnrollmentAction,
  ConnectionEnrollmentActionKind,
  ConnectionEnrollmentPreset,
  ConnectionRecord
} from '@agentmux/core/connections'
import { api } from '../../lib/api'
import { setBotTaskSelection, useAppStore } from '../../store'
import { botTaskSelectionKey } from '../../lib/bot-task-selection'
import { SelectionField } from '../SelectionField'
import { ConnectionSetupResult } from './ConnectionSetupResult'
import { BrandIcon } from '../BrandIcon'
import { desktopBotCreationPreset, generatedBotName, initialBotPublication } from '../../lib/bot-creation-preset'
import { ConnectionRequestTrace } from './ConnectionRequestTrace'
import { BotSetupGuide, type BotSetupGuideStage } from './BotSetupGuide'
import { InitialBotSetupResult, initialSetupStageLabels } from './InitialBotSetupResult'

const BotIcon = semanticIconComponent('object.conversations')
const BackIcon = semanticIconComponent('navigation.back')
const CheckIcon = semanticIconComponent('status.completed')
const LoadingIcon = semanticIconComponent('status.loading')
const issuerKey = (issuer: ConnectionEnrollmentCapability) =>
  JSON.stringify([issuer.adapterId, issuer.domain])
function checkedSetupMessage(operation: ConnectionEnrollmentOperation): string {
  if (operation.configured) return 'The original connection save is confirmed.'
  if (operation.authentication?.stage === 'account')
    return 'Review this account. Confirming it does not create an application.'
  if (operation.authentication?.stage === 'confirmed' && !operation.application)
    return ''
  if (operation.authentication && ['waiting', 'scanned', 'handoff'].includes(operation.authentication.stage))
    return 'Sign-in is still in progress. Your original request is kept.'
  if (operation.application)
    return 'This application is recorded. Check its original credential and local save; it will not be created again.'
  return 'No new confirmation was found. The original request and facts are kept.'
}
const actionLabel: Record<ConnectionEnrollmentActionKind, string> = {
  'continue-authentication': 'Check sign-in',
  'confirm-account': 'Confirm this account',
  'renew-authentication': 'Get a new sign-in code',
  create: 'Create this bot',
  'read-credential': 'Read this application’s credential',
  'recover-local': 'Check saved progress',
  'continue-setup': 'Continue original setup'
}

/** A bounded reading window. The Host owns every durable attempt and its recovery. */
export function useBotEnrollment(active: boolean) {
  const [operations, setOperations] = useState<ConnectionEnrollmentOperation[]>([])
  const observedOperations = useRef(operations)
  const [privateView, setPrivateView] = useState<ConnectionEnrollmentView | null>(null)
  const [preparing, setPreparing] = useState(false), [driving, setDriving] = useState(false)
  const currentInput = useRef<ConnectionEnrollmentBeginInput | null>(null)
  const [capabilities, setCapabilities] = useState<ConnectionEnrollmentCapability[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [catalogState, setCatalogState] = useState<'initial' | 'reading' | 'ready' | 'unconfirmed'>('initial')
  const [progressIssue, setProgressIssue] = useState<{ id: string; text: string } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(() => useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'enrollment' })] ?? null)
  const [checkingId, setChecking] = useState<string | null>(selectedId)
  const [issuer, setIssuer] = useState(''),
    [label, setLabel] = useState(generatedBotName)
  const [submissions, setSubmissions] = useState<ConnectionEnrollmentBeginInput[]>([])
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const submitted =
    submissions.find((item) => item.operationId === submittedId) ??
    operations.find((item) => item.operationId === submittedId) ??
    null
  const [feedback, setFeedback] = useState<{ text: string; detail?: string | undefined }>({ text: '' })
  const setIssue = (text: string, detail?: string) => setFeedback({ text, detail })
  const [pendingWrites, setPendingWrites] = useState<string[]>([])
  const selection = useRef<string | null>(selectedId),
    selectionEpoch = useRef(0)
  const observationEpoch = useRef(0)
  const epoch = useRef(0),
    listRead = useRef(0),
    writing = useRef(new Set<string>()),
    draft = useRef(0),
    creating = useRef<number | null>(null)
  const busy = selectedId && pendingWrites.includes(selectedId) ? selectedId : null
  const startWrite = (operationId: string) => {
    if (writing.current.has(operationId)) return false
    writing.current.add(operationId)
    setPendingWrites([...writing.current])
    return true
  }
  const finishWrite = (operationId: string) => {
    writing.current.delete(operationId)
    setPendingWrites([...writing.current])
  }
  const accept = (operation: ConnectionEnrollmentOperation) => {
    setSubmissions((previous) => previous.filter((item) => item.operationId !== operation.operationId))
    const previous = observedOperations.current,
      known = previous.find((item) => item.operationId === operation.operationId)
    if (known && known.revision >= operation.revision) return known
    // The same bounded reading window supplies both the rendered state and this request's feedback.
    observedOperations.current = known
      ? previous.map((item) => (item.operationId === operation.operationId ? operation : item))
      : [operation, ...previous]
    setOperations(observedOperations.current)
    return operation
  }
  const read = async (cursor?: string, current = epoch.current) => {
    const request = ++listRead.current,
      message = selectionEpoch.current
    setCatalogState('reading')
    try {
      const result = await api.connections.call('connection.enrollment.ls', {
        limit: 25,
        ...(cursor ? { cursor } : {})
      })
      if (current !== epoch.current || request !== listRead.current) return
      for (const operation of result.operations) accept(operation)
      setCapabilities(result.capabilities)
      setNext(result.next)
      setCatalogState('ready')
      if (message === selectionEpoch.current) setIssue('')
    } catch (error) {
      if (current === epoch.current && request === listRead.current) {
        setCatalogState('unconfirmed')
        setIssue(
          'Could not load your bot setups. You can check again or connect an existing bot.',
          presentError(error)
        )
      }
    }
  }
  useEffect(() => {
    const current = ++epoch.current
    setPrivateView(null)
    setDriving(false)
    currentInput.current = null
    if (active) {
      void read(undefined, current)
      if (selection.current) void inspect(selection.current)
    }
    return () => {
      epoch.current++
      listRead.current++
    }
  }, [active])
  const acceptView = (value: ConnectionEnrollmentView, id: string, current: number, occurrence: number) => {
    const observed = value.operation ? accept(value.operation) : null
    if (
      current === epoch.current &&
      selection.current === id &&
      occurrence === selectionEpoch.current &&
      (!observed || observed.revision === value.operation?.revision)
    ) { observationEpoch.current++; setPrivateView(value) }
    return observed
  }
  const begin = async (issuer: ConnectionEnrollmentCapability, label: string, preset?: ConnectionEnrollmentPreset) => {
    const intent = draft.current, current = epoch.current
    if (creating.current === intent || issuer.availability !== 'available') return
    const name = label.trim()
    if (!name) { setIssue('Enter a bot name before signing in.'); return }
    creating.current = intent
    setPreparing(true)
    setIssue('')
    let input: ConnectionEnrollmentBeginInput | null = null
    let occurrence = selectionEpoch.current
    try {
      const frozen = preset ?? await desktopBotCreationPreset(name)
      if (current !== epoch.current || intent !== draft.current) return
      input = { operationId: crypto.randomUUID(), connectionId: crypto.randomUUID(), adapterId: issuer.adapterId, domain: issuer.domain, label: name, preset: frozen, initialPublication: initialBotPublication }
      occurrence = ++selectionEpoch.current
      currentInput.current = input
      startWrite(input.operationId)
      setSubmissions(previous => [...previous, input!])
      setSubmittedId(input.operationId)
      selection.current = input.operationId
      setBotTaskSelection({ kind: 'enrollment' }, input.operationId)
      setPrivateView(null)
      setSelectedId(input.operationId)
      const result = await api.connections.call('connection.enrollment.begin', input)
      if (current === epoch.current) {
        acceptView(result, input.operationId, current, occurrence)
        if (selection.current === input.operationId && occurrence === selectionEpoch.current)
          setDriving(result.actions.some(action => action.kind === 'continue-authentication'))
      }
    } catch (error) {
      if (current === epoch.current && intent === draft.current && (!input || selection.current === input.operationId && occurrence === selectionEpoch.current)) {
        setDriving(false)
        setIssue(input ? 'The sign-in result is not confirmed. Your original request is kept; check it before continuing.' : 'Could not prepare the bot image. Your name is kept; try again when the image is available.', presentError(error))
      }
    } finally {
      if (creating.current === intent) { creating.current = null; setPreparing(false) }
      if (input) finishWrite(input.operationId)
    }
  }
  const inspect = async (id = selection.current) => {
    if (!id) return
    setDriving(false)
    setChecking(id)
    const operationId = id,
      current = epoch.current,
      occurrence = ++selectionEpoch.current
    setIssue('Reading the original result…')
    try {
      const result = await api.connections.call('connection.enrollment.inspect', { operationId })
      if (current === epoch.current) {
        const observed = acceptView(result, operationId, current, occurrence)
        if (selection.current === operationId && occurrence === selectionEpoch.current)
          setIssue(
            observed
              ? checkedSetupMessage(observed)
              : 'The last lookup did not find a recorded result. Keep this setup; it does not confirm that no application was created.'
          )
      }
    } catch (error) {
      if (
        current === epoch.current &&
        selection.current === operationId &&
        occurrence === selectionEpoch.current
      ) {
        setPrivateView(null)
        setIssue(
          'Could not read the saved result. This request is kept; you can check again.',
          presentError(error)
        )
      }
    } finally { if (current === epoch.current && selection.current === operationId && occurrence === selectionEpoch.current) setChecking(null) }
  }
  const advance = async (action?: ConnectionEnrollmentAction, automatic = false) => {
    if (!selectedId || !startWrite(selectedId)) return
    const operationId = selectedId,
      current = epoch.current,
      occurrence = ++selectionEpoch.current
    setIssue('')
    try {
      const offered = action ?? privateView?.actions.find((item) => item.kind === 'recover-local')
      if (!offered || privateView?.operation?.operationId !== operationId)
        throw new Error('Read this original request before choosing its current action.')
      const result = await api.connections.call('connection.enrollment.advance', {
        operationId,
        ownRevision: offered.ownRevision,
        decision: { actionId: offered.actionId, kind: offered.kind }
      })
      if (current === epoch.current) {
        const observed = acceptView(result, operationId, current, occurrence)
        if (selection.current === operationId && occurrence === selectionEpoch.current) {
          setDriving(['continue-authentication', 'renew-authentication'].includes(offered.kind) && result.actions.some(item => item.kind === 'continue-authentication'))
          if (!automatic) setIssue(observed ? checkedSetupMessage(observed) : 'The original result is not confirmed.')
        }
      }
    } catch (error) {
      if (
        current === epoch.current &&
        selection.current === operationId &&
        occurrence === selectionEpoch.current
      )
        { setDriving(false); setPrivateView(null); setIssue('This step is not confirmed. Your original request is kept; read its result before continuing.', presentError(error)) }
    } finally {
      finishWrite(operationId)
    }
  }
  const selectedOperation = operations.find((item) => item.operationId === selectedId) ?? null
  const view =
    privateView?.operation?.operationId === selectedId &&
    privateView.operation.revision === selectedOperation?.revision
      ? privateView
      : null
  useEffect(() => {
    if (!active || !busy || !selectedId) { setProgressIssue(null); return }
    let current = true, timer: ReturnType<typeof setTimeout>
    const id = selectedId, token = epoch.current
    async function observe() {
      try {
        const observation = ++observationEpoch.current
        const value = await api.connections.call('connection.enrollment.inspect', { operationId: id })
        if (observation === observationEpoch.current && current && token === epoch.current && selection.current === id && writing.current.has(id)) {
          if (value.operation) { accept(value.operation); setPrivateView(value); setProgressIssue(null) }
          else setProgressIssue({ id, text: 'The original request is pending here, but its progress is not available yet. Earlier results are kept.' })
        }
      } catch {
        if (current && token === epoch.current && selection.current === id && writing.current.has(id)) setProgressIssue({ id, text: 'The request is still pending here. Its latest progress could not be read; earlier results are kept.' })
      }
      if (current) timer = setTimeout(() => void observe(), 1000)
    }
    void observe()
    return () => { current = false; clearTimeout(timer) }
  }, [active, busy, selectedId])
  useEffect(() => {
    if (!active || !driving || busy || !view) return
    const action = view.actions.find(item => item.kind === 'continue-authentication')
    if (!action) return
    const timer = setTimeout(() => void advance(action, true), view.challenge ? Math.max(0, view.challenge.nextPollAt - Date.now()) : 0)
    return () => clearTimeout(timer)
  }, [active, driving, busy, view])
  return {
    operations,
    view: active ? view : null,
    preparing,
    driving,
    preset: currentInput.current?.operationId === selectedId ? currentInput.current.preset : null,
    capabilities,
    next,
    catalogState,
    selectedId,
    checking: active && checkingId === selectedId && selectedId !== null,
    submitted,
    submissions,
    issue: feedback.text,
    issueDetail: feedback.detail,
    busy,
    issuer,
    setIssuer,
    label,
    setLabel,
    read,
    begin,
    inspect,
    advance,
    select(operationId: string | null) {
      if (!operationId) draft.current++
      selectionEpoch.current++
      selection.current = operationId
      setBotTaskSelection({ kind: 'enrollment' }, operationId)
      setPrivateView(null)
      setDriving(false)
      currentInput.current = null
      setSelectedId(operationId)
      if (operationId) setSubmittedId(operationId)
      setIssue('')
      if (operationId) void inspect(operationId)
    },
    startAnother() {
      draft.current++
      selectionEpoch.current++
      selection.current = null
      setBotTaskSelection({ kind: 'enrollment' }, null)
      setPrivateView(null)
      setDriving(false)
      setPreparing(false)
      currentInput.current = null
      setSelectedId(null)
      setSubmittedId(null)
      setLabel(generatedBotName())
      setIssue('')
    },
    progressIssue: progressIssue?.id === selectedId ? progressIssue.text : '',
    operation: view?.operation ?? selectedOperation
  }
}

const diagnosticCopy: Record<ConnectionEnrollmentDiagnostic['code'], string> = {
  'transport-unconfirmed': 'No response was confirmed from the platform.',
  cancelled: 'The check ended before a platform response was confirmed.',
  'http-status': 'The platform returned an unsuccessful response.',
  'platform-error': 'The platform reported an error for this step.',
  'invalid-json': 'The platform response could not be read.',
  'invalid-response': 'The platform response did not include usable setup information.',
  'missing-verification': 'The platform did not provide a usable confirmation link.',
  'unsafe-verification': 'The confirmation link could not be accepted for this setup.',
  'invalid-challenge': 'The platform’s confirmation information could not be validated.',
  'challenge-unconfirmed': 'Secure confirmation progress could not be checked or saved here.',
  'credential-unconfirmed': 'The bot’s credential storage is not confirmed here.',
  'native-unconfirmed': 'Sign-in progress could not be confirmed.',
  'invalid-state': 'The original private sign-in state could not be used.',
  'invalid-image': 'The frozen public PNG could not be used.',
  'unsupported-domain': 'Creating an application on this platform is not available here.',
  'invalid-application': 'The original application identity could not be validated.',
  'receipt-unconfirmed': 'The original step receipt could not be confirmed.',
  'claim-unconfirmed': 'The step could not be durably claimed here.',
  'asset-unconfirmed': 'The frozen public image could not be securely checked or saved.'
}

function setupHeading(operation: ConnectionEnrollmentOperation | null, view: ConnectionEnrollmentView | null, started: boolean, preparing: boolean, platform: string, busy: boolean) {
  if (operation?.configured && operation.initialPublication && operation.initialSetup?.progress?.state !== 'complete') return { title: operation.initialSetup?.progress?.state === 'approval-required' ? 'Waiting for platform approval' : operation.initialSetup?.progress?.state === 'attention' ? 'Check the original configuration' : 'Configuring your bot', summary: 'Your bot is saved. Configuration and first publication continue on this same application.' }
  if (operation?.configured) return { title: 'Bot saved in AgentMux', summary: 'Check its connection here, then choose a group from your Agent’s menu.' }
  if (preparing && !operation) return { title: 'Getting your sign-in code', summary: 'Preparing this bot’s image and requesting a sign-in code. You can leave and return to this setup.' }
  if (!started) return { title: 'Create a bot for your Agents', summary: 'Sign in, check the account and enterprise, then create your bot here.' }
  if (!operation) return { title: 'Check your original setup', summary: 'The original request is kept. Read its result before continuing; this does not create another bot.' }
  if (operation.application) return { title: 'Bot created. Finish saving it.', summary: 'This application is recorded. Continue with the same bot; it will not be created again.' }
  if (operation.creation && [operation.creation.upload, operation.creation.create].some(state => state === 'unknown' || state === 'dispatching')) return { title: 'Bot creation is not confirmed', summary: 'The original step is kept. Check its saved progress before continuing.' }
  if (busy && view?.actions.some(action => action.kind === 'create')) return { title: 'Creating your bot', summary: 'Preparing the image, creating this bot and saving it securely. You can leave and check this same setup later.' }
  const stage = operation.authentication?.stage
  if (stage === 'scanned') return { title: 'Confirm on your phone', summary: 'Finish signing in on your phone. Keep this page open to continue.' }
  if (stage === 'handoff') return { title: 'Reading your account', summary: 'Your sign-in is being checked. The bot has not been created yet.' }
  if (stage === 'account') return { title: 'Is this the right account?', summary: 'Check the account and enterprise you want to use for this bot.' }
  if (stage === 'confirmed') return { title: 'Ready to create your bot', summary: 'Your account is confirmed. Creating the bot is the next, separate step.' }
  if (stage === 'expired') return { title: 'This sign-in code expired', summary: 'Show a new code to continue this setup. Signing in does not create a bot.' }
  if (view?.challenge) return { title: `Scan with ${platform} to sign in`, summary: 'Use the account that will manage this bot. Confirm the sign-in on your phone.' }
  if (stage === 'waiting') return { title: 'Continue your sign-in', summary: 'Read the original setup to continue. The bot has not been created yet.' }
  if (stage) return { title: 'Sign-in result not confirmed', summary: 'Your original request is kept. Check its progress or explicitly show a new sign-in code.' }
  return { title: 'Bot creation is not confirmed', summary: 'We cannot confirm whether the original request created a bot. Its original result is kept.' }
}

export function BotEnrollmentPane({ enrollment, onExisting, onSaved, onContinue }: {
  enrollment: ReturnType<typeof useBotEnrollment>; onExisting(): void; onSaved(record: ConnectionRecord): void; onContinue?: ((record: ConnectionRecord) => void) | undefined
}) {
  const { operation, view, submitted, selectedId, busy, issuer, label } = enrollment
  const available = enrollment.capabilities.filter(item => item.availability === 'available')
  const selectedIssuer = available.find(item => issuerKey(item) === issuer) ?? (issuer ? undefined : available[0])
  const current = operation ?? (submitted?.operationId === selectedId ? submitted : null)
  const saved = operation?.configured?.connection ?? null
  const platform = current ? enrollment.capabilities.find(item => item.adapterId === current.adapterId && item.domain === current.domain)?.label ?? current.domain : selectedIssuer?.label ?? ''
  const unfinished = submitted && !enrollment.operations.find(item => item.operationId === submitted.operationId)?.configured
  const history = enrollment.operations.map(item => ({ operationId: item.operationId, label: item.label, domain: item.domain }))
  for (const input of enrollment.submissions) if (!history.some(item => item.operationId === input.operationId)) history.unshift(input)
  const order: ConnectionEnrollmentActionKind[] = ['continue-setup', 'confirm-account', 'create', 'read-credential', 'continue-authentication', 'renew-authentication', 'recover-local']
  const recover = view?.actions.find(action => action.kind === 'recover-local')
  const primary = (['secure-storage', 'journal'].includes(operation?.diagnostic?.stage ?? '') && !view?.actions.some(action => action.kind === 'read-credential') ? recover : undefined)
    ?? order.map(kind => view?.actions.find(action => action.kind === kind)).find(Boolean)
  const heading = setupHeading(operation, view, !!current || !!selectedId, enrollment.preparing, platform, !!busy)
  const renew = view?.actions.find(action => action.kind === 'renew-authentication' && action.actionId !== primary?.actionId)
  const stage = saved ? 'saved' : operation?.application ? 'saving' : operation?.authentication?.stage ?? (current || selectedId ? 'original' : 'start')
  const creationUnconfirmed = operation?.creation && [operation.creation.upload, operation.creation.create].some(state => state === 'unknown' || state === 'dispatching')
  const initialSetup = operation?.initialSetup, initialProgress = initialSetup?.progress
  const guideStage: BotSetupGuideStage = saved ? operation?.initialPublication && initialProgress?.state !== 'complete' ? initialProgress?.state === 'attention' ? 'attention' : 'connect' : 'ready'
    : operation?.application ? 'connect'
    : creationUnconfirmed ? 'attention'
    : enrollment.preparing ? 'scan'
    : !current ? selectedId || unfinished ? 'attention' : 'prepare'
    : stage === 'account' ? 'account'
    : stage === 'confirmed' ? 'create'
    : view?.challenge || ['waiting', 'scanned', 'handoff'].includes(stage) ? 'scan'
    : 'attention'
  const name = operation?.preset?.name ?? (submitted && 'preset' in submitted ? submitted.preset?.name : null) ?? current?.label ?? label.trim()
  const feedback = enrollment.issue ? <p role="status" className="connector-check-feedback" data-enrollment-feedback>{enrollment.issue}</p> : null
  const identity = <div className="connector-enrollment__bot-preview">
    {enrollment.preset ? <img src={enrollment.preset.avatar.pngDataUrl} alt="Bot avatar" width={40} height={40} /> : current ? <BotIcon size={28} /> : <BrandIcon size={40} />}
    <div><strong>{name}</strong><span>{current ? enrollment.preset ? 'The name and image chosen for this bot' : 'The name and image already chosen for this setup are kept' : 'Uses the AgentMux image'}</span></div>
  </div>
  return <section className="connector-setup connector-enrollment" data-bot-enrollment data-enrollment-operation={selectedId ?? undefined} data-enrollment-stage={stage}>
    {current || selectedId ? <button className="connector-back connector-enrollment__text-action" onClick={() => { enrollment.select(null); void enrollment.read() }}><BackIcon size={13} />All bot setups</button> : null}
    <BotSetupGuide stage={guideStage} currentStatus={initialProgress ? initialProgress.state === 'complete' ? 'Confirmed' : initialSetupStageLabels[initialProgress.stage] : operation?.application && !saved ? 'Created · saving' : undefined} confirmedSteps={[...(current || label.trim() ? [1] : []), ...(operation?.authentication?.stage === 'confirmed' ? [2] : []), ...(operation?.application ? [3] : [])]} currentStep={!current ? 1 : saved ? 4 : operation?.application || creationUnconfirmed || stage === 'confirmed' ? 3 : 2} title={enrollment.preparing ? 'Preparing your sign-in' : undefined} description={saved ? operation?.initialPublication ? 'This bot keeps its original application while configuration and first publication continue.' : 'Continue with this saved identity. Your original setup is kept here.' : enrollment.preparing ? 'Preparing a sign-in code for this bot. You can return to this same setup.' : stage === 'scanned' ? 'Confirm the sign-in on your phone, then return to this same setup.' : stage === 'handoff' ? 'Your sign-in is being checked. Stay with this original setup.' : guideStage === 'connect' ? 'The bot has been created. Finish saving this same identity securely.' : undefined} />
    <header className="connector-enrollment__heading">
      {current ? <p className="connector-enrollment__identity"><strong>{current.label}</strong><span>{platform}</span></p> : null}
      <h3 className="connector-editor-title">{heading.title}</h3>
      <p className="connector-enrollment__summary">{saved && operation?.initialPublication ? 'Configuration and first publication use this original application and your confirmed account.' : saved && onContinue ? 'Continue with your saved sign-in. You’ll confirm the management account before reviewing this bot.' : heading.summary}</p>
      {operation?.diagnostic ? <p className="connector-enrollment__diagnosis" data-enrollment-diagnosis>{diagnosticCopy[operation.diagnostic.code]}</p> : null}
    </header>
    {enrollment.checking ? <p role="status" data-bot-task-reading aria-busy="true"><LoadingIcon size={14} animation="spin" /> Reading the original saved result…</p> : null}
    {!current ? selectedId ? <div className="connector-enrollment__resume" data-enrollment-unavailable>
      {!enrollment.checking ? <p>The original setup could not be read. Its identifier is kept; no new setup was started.</p> : null}<code>{selectedId}</code>
      <button className="small-button" onClick={() => void enrollment.inspect()}>Read stored result</button>{feedback}
    </div> : <>
      {unfinished ? <div className="connector-enrollment__resume"><strong>{submitted!.label}</strong><p>Your previous setup is kept. Open it to check the result.</p><button data-enrollment-resume className="primary-button" onClick={() => enrollment.select(submitted!.operationId)}>Resume this setup</button>{feedback}</div> : <>
        <div className="connector-enrollment__identity-editor">
          <BrandIcon size={40} />
          <label className="settings-field connector-enrollment__name"><span>Bot name</span><TextInput aria-label="New bot name" value={label} disabled={enrollment.preparing} onChange={event => enrollment.setLabel(event.target.value)} placeholder="AMUX-…" /><small>Uses the AgentMux avatar</small></label>
        </div>
        {available.length > 1 ? <SelectionField label="Bot creation platform" value={selectedIssuer ? issuerKey(selectedIssuer) : issuer} options={available.map(item => ({ value: issuerKey(item), label: item.label }))} onValueChange={enrollment.setIssuer} /> : null}
        <div className="connector-enrollment__action" aria-busy={enrollment.preparing}>
          {selectedIssuer ? <button data-enrollment-create className="primary-button" disabled={enrollment.preparing} onClick={() => void enrollment.begin(selectedIssuer, label)}>{enrollment.preparing ? 'Getting sign-in code…' : `Sign in with ${selectedIssuer.label}`}</button> : <><p className="settings-group-note">{enrollment.catalogState === 'ready' ? 'In-app bot creation is not available here. You can still connect an existing bot.' : enrollment.catalogState === 'unconfirmed' ? 'Sign-in options could not be checked. Refresh them or connect an existing bot.' : 'Reading available sign-in options…'}</p><button className="small-button" onClick={() => void enrollment.read()}>Check setup options</button></>}
          {feedback}
        </div>
      </>}
      <div className="connector-enrollment__alternative"><span>Already have a bot?</span><button data-enrollment-existing className="connector-enrollment__text-action" onClick={onExisting}>Connect an existing bot</button></div>
    </> : <>
      {view?.challenge ? <div className="connector-management__scan" data-enrollment-code><BotConfirmationCode url={view.challenge.qrPayload} title={`${platform} sign-in code`} failureMessage="The sign-in code could not be displayed. Your original setup is kept; check its result before continuing." /></div> : null}
      {view?.account ? <dl className="connector-management__account" aria-label="Account and enterprise for this bot">
        <div><dt>Account</dt><dd>{view.account.userName ?? view.account.userId}{view.account.userName ? <small>{view.account.userId}</small> : null}</dd></div>
        <div><dt>Enterprise</dt><dd>{view.account.tenantName ?? view.account.tenantId}{view.account.tenantName ? <small>{view.account.tenantId}</small> : null}</dd></div>
      </dl> : null}
      {primary?.kind === 'create' ? <div className="connector-enrollment__creation">{identity}<p>Creates one bot, gets its credentials and saves it securely here. Message setup and publishing come next.</p></div> : null}
      {saved ? onContinue ? <details className="connector-optional"><summary>Connection status and checks</summary><ConnectionSetupResult record={saved} /></details> : <ConnectionSetupResult record={saved} /> : null}
      <div className="connector-enrollment__action" aria-busy={!!busy}>
        {saved ? <>{primary?.kind === 'continue-setup' ? <button className="primary-button" disabled={!!busy} onClick={() => void enrollment.advance(primary)}>Continue original setup</button> : null}{onContinue && !operation?.initialPublication ? <button data-enrollment-continue className="primary-button" onClick={() => onContinue(saved)}>Continue bot setup</button> : null}<button data-enrollment-saved className="small-button" onClick={() => onSaved(saved)}>Manage bot</button></> : primary ? <button data-enrollment-advance data-enrollment-action={primary.kind} className="primary-button" disabled={!!busy} onClick={() => void enrollment.advance(primary)}>{busy ? primary.kind === 'create' ? 'Creating your bot…' : 'Checking…' : primary.kind === 'confirm-account' ? 'Use this account' : primary.kind === 'read-credential' ? 'Finish saving this bot' : primary.kind === 'create' && operation?.initialPublication ? 'Create, configure & publish' : actionLabel[primary.kind]}</button> : <button data-enrollment-inspect className="primary-button" onClick={() => void enrollment.inspect()}>Check original setup</button>}
        {operation?.authentication?.stage === 'confirmed' && !saved && operation.initialPublication ? <p className="settings-group-note">Creates this bot with the chosen public details, configures conversations and publishes its first version for your account only. Platform approval may still be required.</p> : null}
      {saved && operation?.initialPublication ? <InitialBotSetupResult progress={initialProgress ?? null} /> : null}
      {enrollment.progressIssue ? <p role="status" className="settings-group-note">{enrollment.progressIssue}</p> : null}
      {enrollment.driving && view && !enrollment.issue ? <p role="status" className="settings-group-note">{view.challenge ? 'Waiting for your phone confirmation…' : 'Continuing this sign-in…'}</p> : null}
        {feedback}
      </div>
      {!saved ? <div className="connector-enrollment__alternative"><button data-enrollment-existing className="connector-enrollment__text-action" onClick={onExisting}>Connect an existing bot</button></div> : onContinue && !operation?.initialPublication ? <div className="connector-next-step"><CheckIcon size={18} /><div><strong>Next, review this bot’s setup</strong><p>Confirm the management account before reviewing its settings. Configuration and publishing are separate steps.</p></div></div> : operation?.initialPublication && initialProgress?.state !== 'complete' ? null : <div className="connector-next-step"><CheckIcon size={18} /><div><strong>Next, choose an Agent and a group</strong><p>Open an Agent’s menu → Create group or Connect existing group. Choose the audience and what to share there.</p></div></div>}
      {renew ? <details className="connector-optional"><summary>Use another sign-in</summary><p className="settings-group-note">Sign in again for this same {operation?.application ? 'bot' : 'setup'}. The original result is kept; signing in does not create a bot.</p><button data-enrollment-renew className="small-button" disabled={!!busy} onClick={() => void enrollment.advance(renew)}>Show a new sign-in code</button></details> : null}
      <details className="connector-diagnostics"><summary>{saved ? 'Original setup details' : 'Technical details'}</summary>
        {enrollment.issueDetail ? <p className="connector-enrollment__technical" data-enrollment-error-detail>{enrollment.issueDetail}</p> : null}
        <dl className="connector-identity"><div><dt>Original setup</dt><dd><code>{selectedId}</code></dd></div><div><dt>Platform</dt><dd>{current.domain}</dd></div>
          {operation ? <><div><dt>Revision</dt><dd>{operation.revision}</dd></div><div><dt>Platform confirmation</dt><dd>{operation.authorization}</dd></div><div><dt>Credential storage</dt><dd>{operation.credential}</dd></div><div><dt>Application save</dt><dd>{operation.configuration}</dd></div>{operation.application ? <div><dt>App ID</dt><dd><code>{operation.application.appId}</code></dd></div> : null}{operation.reason ? <div><dt>Original result</dt><dd>{operation.reason}</dd></div> : null}{operation.diagnostic ? <><div><dt>Observed stage</dt><dd>{operation.diagnostic.stage}</dd></div><div><dt>Stage result</dt><dd>{operation.diagnostic.code}</dd></div>{operation.diagnostic.stage === 'authentication' && (operation.diagnostic.step || operation.diagnostic.failure || operation.diagnostic.boundary || operation.diagnostic.redirectReason) ? <div><dt>Authentication check</dt><dd>{[operation.diagnostic.step, operation.diagnostic.failure, operation.diagnostic.boundary, operation.diagnostic.redirectReason].filter(Boolean).join(' · ')}</dd></div> : null}{'httpStatus' in operation.diagnostic && operation.diagnostic.httpStatus !== undefined ? <div><dt>HTTP status</dt><dd>{operation.diagnostic.httpStatus}</dd></div> : null}</> : null}</> : null}
        </dl>
        {primary || saved ? <div className="connector-enrollment__local-read"><p className="settings-group-note">Checks the original local progress. No platform request is sent.</p>{recover && recover.actionId !== primary?.actionId ? <button data-enrollment-recover className="small-button" disabled={!!busy} onClick={() => void enrollment.advance(recover)}>Check saved progress</button> : <button data-enrollment-inspect className="small-button" onClick={() => void enrollment.inspect()}>Read stored result</button>}</div> : null}
      </details>
    </>}
    {!current && enrollment.issueDetail ? <details className="connector-diagnostics"><summary>Setup service details</summary><p className="connector-enrollment__technical">{enrollment.issueDetail}</p></details> : null}
    {history.length ? <details className="connector-enrollment__history"><summary>Previous bot setups</summary>{history.map(item => <button key={item.operationId} data-enrollment-history={item.operationId} className="connector-enrollment__previous" onClick={() => enrollment.select(item.operationId)}><strong>{item.label}</strong><span>{item.domain}</span></button>)}{enrollment.next ? <button className="small-button" onClick={() => void enrollment.read(enrollment.next!)}>More setups</button> : null}</details> : null}
    <ConnectionRequestTrace source={selectedId ? { kind: 'enrollment', operationId: selectedId } : null} revision={operation?.revision} enrollmentView={view} title={initialSetup ? "Sign-in & creation requests" : undefined} />
    {saved && initialSetup ? <ConnectionRequestTrace source={{ kind: 'setup', operationId: initialSetup.operationId }} revision={JSON.stringify(initialProgress)} hideCopy title="Configuration & publication requests" /> : null}
    {current || unfinished ? <details className="connector-optional"><summary>Set up another bot</summary><p className="settings-group-note">Opens a separate setup. Every original request is kept; opening this form does not create a bot.</p><button data-enrollment-another className="small-button" onClick={enrollment.startAnother}>Open another setup</button></details> : null}
  </section>
}
