import { useEffect, useRef, useState } from 'react'
import { BotConfirmationCode } from '../BotConfirmationCode'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionEnrollmentBeginInput, ConnectionEnrollmentCapability, ConnectionEnrollmentDiagnostic, ConnectionEnrollmentOperation, ConnectionRecord } from '@agentmux/core/connections'
import { api } from '../../lib/api'
import { SelectionField } from '../SelectionField'
import { ConnectionSetupResult } from './ConnectionSetupResult'

const BotIcon = semanticIconComponent('object.conversations')
const ExternalIcon = semanticIconComponent('action.open-external')
const BackIcon = semanticIconComponent('navigation.back')
const CheckIcon = semanticIconComponent('status.completed')
const issuerKey = (issuer: ConnectionEnrollmentCapability) => JSON.stringify([issuer.adapterId, issuer.domain])
function checkedSetupMessage(operation: ConnectionEnrollmentOperation): string {
  if (operation.authorization === 'unknown') return operation.reason === 'begin-unconfirmed'
    ? 'Still no setup link. We cannot confirm whether the bot was created. This request is kept.'
    : 'No new confirmation was found. This request is kept; checking it does not create another bot.'
  if (operation.authorization === 'pending') return operation.challenge && Date.now() < operation.challenge.nextPollAt
    ? 'Still waiting for platform confirmation. Give it a moment, then check again.'
    : 'Still waiting for platform confirmation. Complete the confirmation on the platform, then check again.'
  if (operation.authorization === 'not-started') return 'This setup has not started on the platform. Its original details are kept.'
  if (operation.authorization === 'authorized' && !operation.configured) return 'This check did not confirm a completed local connection. Your original setup is kept.'
  return ''
}

/** A bounded reading window. The Host owns every durable attempt and its recovery. */
export function useBotEnrollment(active: boolean) {
  const [operations, setOperations] = useState<ConnectionEnrollmentOperation[]>([])
  const observedOperations = useRef(operations)
  const [capabilities, setCapabilities] = useState<ConnectionEnrollmentCapability[]>([])
  const [next, setNext] = useState<string | null>(null), [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [issuer, setIssuer] = useState(''), [label, setLabel] = useState('')
  const [submissions, setSubmissions] = useState<ConnectionEnrollmentBeginInput[]>([])
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const submitted = submissions.find(item => item.operationId === submittedId) ?? operations.find(item => item.operationId === submittedId) ?? null
  const [feedback, setFeedback] = useState<{ text: string; detail?: string }>({ text: '' })
  const setIssue = (text: string, detail?: string) => setFeedback({ text, detail })
  const [pendingWrites, setPendingWrites] = useState<string[]>([])
  const selection = useRef<string | null>(null), selectionEpoch = useRef(0)
  const epoch = useRef(0), listRead = useRef(0), writing = useRef(new Set<string>()), draft = useRef(0), creating = useRef<number | null>(null)
  const busy = selectedId && pendingWrites.includes(selectedId) ? selectedId : null
  const startWrite = (operationId: string) => {
    if (writing.current.has(operationId)) return false
    writing.current.add(operationId); setPendingWrites([...writing.current]); return true
  }
  const finishWrite = (operationId: string) => { writing.current.delete(operationId); setPendingWrites([...writing.current]) }
  const accept = (operation: ConnectionEnrollmentOperation) => {
    setSubmissions(previous => previous.filter(item => item.operationId !== operation.operationId))
    const previous = observedOperations.current, known = previous.find(item => item.operationId === operation.operationId)
    if (known && known.revision >= operation.revision) return known
    // The same bounded reading window supplies both the rendered state and this request's feedback.
    observedOperations.current = known ? previous.map(item => item.operationId === operation.operationId ? operation : item) : [operation, ...previous]
    setOperations(observedOperations.current)
    return operation
  }
  const read = async (cursor?: string, current = epoch.current) => {
    const request = ++listRead.current
    try {
      const result = await api.connections.call('connection.enrollment.ls', { limit: 25, ...(cursor ? { cursor } : {}) })
      if (current !== epoch.current || request !== listRead.current) return
      for (const operation of result.operations) accept(operation)
      setCapabilities(result.capabilities); setNext(result.next); setLoaded(true); setIssue('')
    } catch (error) {
      if (current === epoch.current && request === listRead.current) { setLoaded(true); setIssue('Could not load your bot setups. You can check again or connect an existing bot.', presentError(error)) }
    }
  }
  useEffect(() => {
    const current = ++epoch.current
    if (active) void read(undefined, current)
    return () => { epoch.current++; listRead.current++ }
  }, [active])
  const begin = async (issuer: ConnectionEnrollmentCapability, label: string) => {
    const intent = draft.current
    if (creating.current === intent || issuer.availability !== 'available') return
    const input: ConnectionEnrollmentBeginInput = { operationId: crypto.randomUUID(), connectionId: crypto.randomUUID(), adapterId: issuer.adapterId, domain: issuer.domain, label: label.trim() || `${issuer.label} bot` }
    const current = epoch.current, occurrence = ++selectionEpoch.current
    creating.current = intent; startWrite(input.operationId); setSubmissions(previous => [...previous, input]); setSubmittedId(input.operationId); selection.current = input.operationId; setSelectedId(input.operationId); setIssue('')
    try {
      const result = await api.connections.call('connection.enrollment.begin', input)
      if (current === epoch.current) accept(result)
    } catch (error) { if (current === epoch.current && selection.current === input.operationId && occurrence === selectionEpoch.current) setIssue('Could not confirm this setup. Your request is kept so you can check its result.', presentError(error)) }
    finally { if (creating.current === intent) creating.current = null; finishWrite(input.operationId) }
  }
  const inspect = async () => {
    if (!selectedId) return
    const operationId = selectedId, current = epoch.current, occurrence = ++selectionEpoch.current
    setIssue('Reading the original result…')
    try {
      const result = await api.connections.call('connection.enrollment.inspect', { operationId })
      if (current === epoch.current) {
        const observed = result.operation ? accept(result.operation) : null
        if (selection.current === operationId && occurrence === selectionEpoch.current) setIssue(observed ? checkedSetupMessage(observed) : 'The last lookup did not find a recorded result. Keep this setup; it does not confirm that no application was created.')
      }
    } catch (error) { if (current === epoch.current && selection.current === operationId && occurrence === selectionEpoch.current) setIssue('Could not read the saved result. This request is kept; you can check again.', presentError(error)) }
  }
  const advance = async () => {
    if (!selectedId || !startWrite(selectedId)) return
    const operationId = selectedId, current = epoch.current, occurrence = ++selectionEpoch.current
    setIssue('')
    try {
      const original = operations.find(item => item.operationId === operationId)
      // Only the original owner's explicit not-started fact permits resuming the same begin.
      const result = original?.authorization === 'not-started'
        ? await api.connections.call('connection.enrollment.begin', { operationId, connectionId: original.connectionId, adapterId: original.adapterId, domain: original.domain, label: original.label })
        : await api.connections.call('connection.enrollment.advance', { operationId })
      if (current === epoch.current) {
        const observed = accept(result)
        if (selection.current === operationId && occurrence === selectionEpoch.current) setIssue(checkedSetupMessage(observed))
      }
    } catch (error) { if (current === epoch.current && selection.current === operationId && occurrence === selectionEpoch.current) setIssue('Could not check this request. Your request is kept; you can check again.', presentError(error)) }
    finally { finishWrite(operationId) }
  }
  return { operations, capabilities, next, loaded, selectedId, submitted, submissions, issue: feedback.text, issueDetail: feedback.detail, busy, issuer, setIssuer, label, setLabel, read, begin, inspect, advance,
    select(operationId: string | null) { if (!operationId) draft.current++; selectionEpoch.current++; selection.current = operationId; setSelectedId(operationId); if (operationId) setSubmittedId(operationId); setIssue('') },
    startAnother() { draft.current++; selectionEpoch.current++; selection.current = null; setSelectedId(null); setSubmittedId(null); setLabel(''); setIssue('') },
    operation: operations.find(item => item.operationId === selectedId) ?? null }
}

const diagnosticCopy: Record<ConnectionEnrollmentDiagnostic['code'], string> = {
  'transport-unconfirmed': 'No response was confirmed from the platform.',
  cancelled: 'The check ended before a platform response was confirmed.',
  'http-status': 'The platform returned an unsuccessful response.',
  'platform-error': 'The platform reported a registration error.',
  'invalid-json': 'The platform response could not be read.',
  'invalid-response': 'The platform response did not include usable setup information.',
  'missing-verification': 'The platform did not provide a usable confirmation link.',
  'unsafe-verification': 'The confirmation link could not be accepted for this setup.',
  'invalid-challenge': 'The platform’s confirmation information could not be validated.',
  'challenge-unconfirmed': 'Secure confirmation progress could not be checked or saved here.',
  'credential-unconfirmed': 'The bot’s credential storage is not confirmed here.'
}

export function BotEnrollmentPane({ enrollment, onExisting, onSaved }: {
  enrollment: ReturnType<typeof useBotEnrollment>; onExisting(): void; onSaved(record: ConnectionRecord): void
}) {
  const [openIssue, setOpenIssue] = useState('')
  const openAttempt = useRef(0)
  const { operation, submitted, selectedId, busy, issuer, setIssuer, label, setLabel } = enrollment
  const available = enrollment.capabilities.filter(item => item.availability === 'available')
  const selectedIssuer = available.find(item => issuerKey(item) === issuer) ?? (issuer ? undefined : available[0])
  const current = operation ?? (submitted?.operationId === selectedId ? submitted : null)
  const saved = operation?.configured?.connection ?? null
  const issuerLabel = current ? enrollment.capabilities.find(item => item.adapterId === current.adapterId && item.domain === current.domain)?.label ?? current.domain : ''
  const submittedResult = submitted && enrollment.operations.find(item => item.operationId === submitted.operationId)
  const unfinished = submitted && (!submittedResult || !submittedResult.configured && !['denied', 'expired'].includes(submittedResult.authorization))
  const history: Array<{ input: ConnectionEnrollmentBeginInput; operation: ConnectionEnrollmentOperation | null }> = enrollment.operations.map(item => ({ input: item, operation: item }))
  for (const input of enrollment.submissions) if (!enrollment.operations.some(item => item.operationId === input.operationId)) history.unshift({ input, operation: null })
  const preparing = !!current && !operation && busy === selectedId
  const title = preparing ? 'Getting your setup link' : saved ? 'Bot saved in AgentMux'
    : operation?.authorization === 'pending' ? `Scan with ${issuerLabel} to continue`
    : operation?.authorization === 'authorized' ? 'Bot created. Finish connecting it.'
    : operation?.authorization === 'denied' ? 'Platform did not approve this setup'
    : operation?.authorization === 'expired' ? 'Confirmation expired'
    : operation?.authorization === 'not-started' ? 'Bot setup has not started'
    : current ? operation?.challenge ? 'Bot creation is not confirmed' : 'We couldn’t get a setup link'
    : unfinished ? 'Continue your bot setup' : 'Bring your Agent into a group chat'
  const summary = preparing ? 'Requesting a confirmation page. You can leave and return to this request.'
    : saved ? 'Your bot is saved. Confirm its current connection here, then choose a group from your Agent’s menu.'
    : operation?.authorization === 'pending' ? 'Scan the code, approve the bot’s creation, then return here to check the confirmation.'
    : operation?.authorization === 'denied' ? 'The original result is kept. You can connect a bot you already have.'
    : operation?.authorization === 'expired' ? 'The confirmation has expired. The creation result is unconfirmed; your original setup is kept.'
    : operation?.authorization === 'authorized' ? 'The platform confirmed creation. AgentMux has not finished saving the connection yet.'
    : operation?.authorization === 'not-started' ? 'Continue this same setup when the required connection service is available.'
    : current ? operation?.challenge ? 'We cannot confirm whether the bot was created. Check the same request for its result.' : `There’s no QR code to scan yet, and we cannot confirm whether ${issuerLabel} created the bot.`
    : unfinished ? 'Your previous request is kept. Open it to check the result or finish connecting the bot.' : 'First create a Feishu or Lark bot. Then choose an Agent and connect its group from the Agent’s menu.'
  useEffect(() => { openAttempt.current++; setOpenIssue(''); return () => { openAttempt.current++ } }, [selectedId, operation?.challenge?.verificationUrl])
  const openConfirmation = async () => {
    if (!operation?.challenge) return
    const attempt = ++openAttempt.current
    try { await api.ui.openExternal(operation.challenge.verificationUrl) }
    catch (error) { if (attempt === openAttempt.current) setOpenIssue(presentError(error)) }
  }
  const canContinue = !!operation && !saved && !['denied', 'expired'].includes(operation.authorization) && operation.configuration !== 'refused'
  const existingIsPrimary = !!current && !!operation && !saved && !canContinue
  const localSaveUnconfirmed = operation?.authorization === 'authorized' && (operation.credential === 'unknown' || operation.configuration === 'unknown')
  const primaryInspectsOriginal = !!current && !operation
  const feedback = <>{openIssue ? <p role="status" className="connector-check-feedback">Could not open the confirmation page. You can still scan the code or check this request.</p> : null}{enrollment.issue ? <p role="status" className="connector-check-feedback" data-enrollment-feedback>{enrollment.issue}</p> : null}</>
  return <section className="connector-setup connector-enrollment" data-bot-enrollment data-enrollment-operation={selectedId ?? undefined}>
    {current ? <button className="connector-back connector-enrollment__text-action" onClick={() => { enrollment.select(null); void enrollment.read() }}><BackIcon size={13} />All bot setups</button> : null}
    <header className="connector-enrollment__heading">
      {current ? <p className={`connector-enrollment__identity${saved ? ' connector-connection-state' : ''}`} role={saved ? 'status' : undefined}>{saved ? <CheckIcon size={14} /> : null}<strong>{current.label}</strong>{current.label === `${issuerLabel} bot` ? null : <span>{issuerLabel}</span>}</p> : null}
      <h3 className="connector-editor-title">{title}</h3>
      <p className="connector-enrollment__summary">{summary}</p>
      {operation?.diagnostic ? <p className="connector-enrollment__diagnosis" data-enrollment-diagnosis>{diagnosticCopy[operation.diagnostic.code]}</p> : null}
    </header>
    {!current ? <>
      {unfinished ? <p className="connector-enrollment__identity"><strong>{submitted!.label}</strong><span>{enrollment.capabilities.find(item => item.adapterId === submitted!.adapterId && item.domain === submitted!.domain)?.label ?? submitted!.domain}</span></p> : <>
      {available.length > 1 ? <SelectionField label="Bot creation platform" value={selectedIssuer ? issuerKey(selectedIssuer) : issuer} options={available.map(item => ({ value: issuerKey(item), label: item.label }))} onValueChange={setIssuer} /> : selectedIssuer ? <p className="settings-group-note">Create with {selectedIssuer.label}.</p> : <p role="status" className="settings-group-note">{!enrollment.loaded ? 'Reading bot setup options…' : 'Scan setup is not available here. You can still connect an existing bot.'}</p>}
      <details className="connector-optional"><summary>Name in AgentMux</summary><label className="settings-field"><span>Bot name <small>Optional</small></span><TextInput aria-label="New bot name" value={label} onChange={event => setLabel(event.target.value)} placeholder="Your bot’s name here" /></label></details>
      </>}
      <div className="connector-enrollment__action">{unfinished ? <button data-enrollment-resume className="primary-button" onClick={() => enrollment.select(submitted!.operationId)}>Resume this setup</button> : selectedIssuer ? <button data-enrollment-create className="primary-button" disabled={!!busy} onClick={() => void enrollment.begin(selectedIssuer, label)}>Create and connect a bot</button> : <button className="small-button" onClick={() => void enrollment.read()}>Check setup options</button>}{feedback}</div>
      <div className="connector-enrollment__alternative"><span>Already have a bot?</span><button data-enrollment-existing className="connector-enrollment__text-action" onClick={onExisting}>Connect an existing bot</button></div>
    </> : <>
      {operation?.authorization === 'pending' && operation.challenge ? <div className="connector-enrollment__confirmation">
        <BotConfirmationCode url={operation.challenge.verificationUrl} />
        <div>{operation.challenge.userCode ? <p className="connector-enrollment__public-code">Confirmation code <strong>{operation.challenge.userCode}</strong></p> : null}<button className="connector-enrollment__text-action" data-enrollment-open onClick={() => void openConfirmation()}>Open confirmation page <ExternalIcon size={12} /></button>{operation.challenge.expiresAt !== null ? <p className="settings-group-note">Confirmation valid until {new Date(operation.challenge.expiresAt).toLocaleTimeString()}.</p> : null}</div>
      </div> : null}
      {saved ? <ConnectionSetupResult record={saved} /> : null}
      <div className="connector-enrollment__action">{saved ? <button data-enrollment-saved className="small-button" onClick={() => onSaved(saved)}>Manage bot</button>
        : canContinue ? <button data-enrollment-advance className="primary-button" disabled={!!busy} onClick={() => void enrollment.advance()}>{busy === selectedId ? 'Checking…' : operation?.authorization === 'pending' ? 'Check confirmation' : operation?.authorization === 'unknown' ? 'Check this creation' : localSaveUnconfirmed ? 'Check connection save' : 'Finish connecting'}</button>
        : existingIsPrimary ? <button data-enrollment-existing className="primary-button" onClick={onExisting}>Connect an existing bot</button>
        : <button data-enrollment-inspect className="primary-button" onClick={() => void enrollment.inspect()}>Check this creation</button>}
        {current && !saved && operation?.authorization === 'unknown' && !enrollment.issue ? <p className="settings-group-note">Checks this request without creating another bot.</p> : null}{feedback}</div>
      {!saved && !existingIsPrimary ? <div className="connector-enrollment__alternative"><span>Already created a bot in {issuerLabel}?</span><button data-enrollment-existing className="connector-enrollment__text-action" onClick={onExisting}>Connect an existing bot</button></div> : null}
      {saved ? <div className="connector-next-step"><BotIcon size={18} /><div><strong>Next, choose an Agent and a group</strong><p>Open an Agent’s menu → Create group or Connect existing group. You choose the audience and what to share there.</p></div></div> : null}
      <details className="connector-diagnostics">
        <summary>{saved ? 'Original setup details' : 'Technical details'}</summary>
        {enrollment.issueDetail ? <p className="connector-enrollment__technical" data-enrollment-error-detail>{enrollment.issueDetail}</p> : null}
        {openIssue ? <p className="connector-enrollment__technical">{openIssue}</p> : null}
        <dl className="connector-identity">
          <div><dt>Original setup</dt><dd><code>{selectedId}</code></dd></div>
          <div><dt>Platform</dt><dd>{current.domain}</dd></div>
          {operation ? <>
            <div><dt>Revision</dt><dd>{operation.revision}</dd></div>
            <div><dt>Platform confirmation</dt><dd>{operation.authorization}</dd></div>
            <div><dt>Credential storage</dt><dd>{operation.credential}</dd></div>
            <div><dt>Application save</dt><dd>{operation.configuration}</dd></div>
            {operation.application ? <div><dt>App ID</dt><dd><code>{operation.application.appId}</code></dd></div> : null}
            {operation.reason ? <div><dt>Original result</dt><dd>{operation.reason}</dd></div> : null}
            {operation.diagnostic ? <>
              <div><dt>Observed stage</dt><dd>{operation.diagnostic.stage}</dd></div>
              <div><dt>Stage result</dt><dd>{operation.diagnostic.code}</dd></div>
              {operation.diagnostic.stage === 'response' && operation.diagnostic.httpStatus !== undefined ? <div><dt>HTTP status</dt><dd>{operation.diagnostic.httpStatus}</dd></div> : null}
            </> : null}
          </> : null}
        </dl>
        {/* Local inspection stays available while the original platform effect is in flight. */}
        {!primaryInspectsOriginal ? <div className="connector-enrollment__local-read"><p className="settings-group-note">Read AgentMux’s stored receipt only. This does not contact the platform.</p><button data-enrollment-inspect className="small-button" onClick={() => void enrollment.inspect()}>Read stored receipt</button></div> : null}
      </details>
    </>}
    {!current && enrollment.issueDetail ? <details className="connector-diagnostics"><summary>Technical details</summary><p className="connector-enrollment__technical" data-enrollment-error-detail>{enrollment.issueDetail}</p></details> : null}
    {!saved && (current || unfinished) ? <details data-enrollment-separate className="connector-optional"><summary>Create a different bot</summary><p className="settings-group-note">This may create another bot. Your current request stays available.</p><button data-enrollment-start-another className="small-button" onClick={() => enrollment.startAnother()}>Set up another bot</button></details> : null}
    {!current && history.length ? <details className="connector-enrollment__history"><summary>Previous bot setups</summary>{history.map(({ input: item, operation: receipt }) => <button key={item.operationId} data-enrollment-select={item.operationId} className="connector-enrollment__previous" onClick={() => enrollment.select(item.operationId)}><strong>{item.label}</strong><span>{receipt ? receipt.configured ? 'Saved' : receipt.authorization === 'pending' ? 'Waiting for confirmation' : receipt.authorization === 'authorized' ? 'Application created · setup incomplete' : receipt.authorization === 'unknown' ? 'Result not confirmed' : receipt.authorization : 'Result not confirmed'}</span></button>)}</details> : null}
    {!current && enrollment.next ? <button data-enrollment-more className="small-button connector-back" onClick={() => void enrollment.read(enrollment.next!)}>Load earlier setups</button> : null}
  </section>
}
