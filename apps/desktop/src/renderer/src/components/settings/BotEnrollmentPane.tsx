import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionEnrollmentBeginInput, ConnectionEnrollmentCapability, ConnectionEnrollmentOperation, ConnectionRecord } from '@agentmux/core/connections'
import { api } from '../../lib/api'
import { SelectionField } from '../SelectionField'

const BotIcon = semanticIconComponent('object.conversations')
class ConfirmationCode extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="status" className="settings-group-note">The code could not be displayed. Open the confirmation page instead.</p> : this.props.children }
}
const issuerKey = (issuer: ConnectionEnrollmentCapability) => JSON.stringify([issuer.adapterId, issuer.domain])

/** A bounded reading window. The Host owns every durable attempt and its recovery. */
export function useBotEnrollment(active: boolean) {
  const [operations, setOperations] = useState<ConnectionEnrollmentOperation[]>([])
  const [capabilities, setCapabilities] = useState<ConnectionEnrollmentCapability[]>([])
  const [next, setNext] = useState<string | null>(null), [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [issuer, setIssuer] = useState(''), [label, setLabel] = useState('')
  const [submitted, setSubmitted] = useState<ConnectionEnrollmentBeginInput | null>(null)
  const [issue, setIssue] = useState(''), [pendingWrites, setPendingWrites] = useState<string[]>([])
  const selection = useRef<string | null>(null), selectionEpoch = useRef(0)
  const epoch = useRef(0), listRead = useRef(0), writing = useRef(new Set<string>()), creating = useRef(false)
  const busy = selectedId && pendingWrites.includes(selectedId) ? selectedId : null
  const startWrite = (operationId: string) => {
    if (writing.current.has(operationId)) return false
    writing.current.add(operationId); setPendingWrites([...writing.current]); return true
  }
  const finishWrite = (operationId: string) => { writing.current.delete(operationId); setPendingWrites([...writing.current]) }
  const accept = (operation: ConnectionEnrollmentOperation) => {
    setOperations(previous => {
      const known = previous.find(item => item.operationId === operation.operationId)
      if (known && known.revision >= operation.revision) return previous
      return known ? previous.map(item => item.operationId === operation.operationId ? operation : item) : [operation, ...previous]
    })
  }
  const read = async (cursor?: string, current = epoch.current) => {
    const request = ++listRead.current
    try {
      const result = await api.connections.call('connection.enrollment.ls', { limit: 25, ...(cursor ? { cursor } : {}) })
      if (current !== epoch.current || request !== listRead.current) return
      for (const operation of result.operations) accept(operation)
      setCapabilities(result.capabilities); setNext(result.next); setLoaded(true); setIssue('')
    } catch (error) {
      if (current === epoch.current && request === listRead.current) { setLoaded(true); setIssue(presentError(error)) }
    }
  }
  useEffect(() => {
    const current = ++epoch.current
    if (active) void read(undefined, current)
    return () => { epoch.current++; listRead.current++ }
  }, [active])
  const begin = async (issuer: ConnectionEnrollmentCapability, label: string) => {
    if (creating.current || issuer.availability !== 'available') return
    const input: ConnectionEnrollmentBeginInput = { operationId: crypto.randomUUID(), connectionId: crypto.randomUUID(), adapterId: issuer.adapterId, domain: issuer.domain, label: label.trim() || `${issuer.label} bot` }
    const current = epoch.current, occurrence = ++selectionEpoch.current
    creating.current = true; startWrite(input.operationId); setSubmitted(input); selection.current = input.operationId; setSelectedId(input.operationId); setIssue('')
    try {
      const result = await api.connections.call('connection.enrollment.begin', input)
      if (current === epoch.current) accept(result)
    } catch (error) { if (current === epoch.current && selection.current === input.operationId && occurrence === selectionEpoch.current) setIssue(`The creation result is not confirmed. Keep this setup and check its original result. ${presentError(error)}`) }
    finally { creating.current = false; finishWrite(input.operationId) }
  }
  const inspect = async () => {
    if (!selectedId) return
    const operationId = selectedId, current = epoch.current, occurrence = ++selectionEpoch.current
    setIssue('Reading the original result…')
    try {
      const result = await api.connections.call('connection.enrollment.inspect', { operationId })
      if (current === epoch.current) {
        if (result.operation) accept(result.operation)
        if (selection.current === operationId && occurrence === selectionEpoch.current) setIssue(result.operation ? '' : 'The last lookup did not find a recorded result. Keep this setup; it does not confirm that no application was created.')
      }
    } catch (error) { if (current === epoch.current && selection.current === operationId && occurrence === selectionEpoch.current) setIssue(presentError(error)) }
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
      if (current === epoch.current) accept(result)
    } catch (error) { if (current === epoch.current && selection.current === operationId && occurrence === selectionEpoch.current) setIssue(`This setup is not confirmed yet. Check or continue this same setup. ${presentError(error)}`) }
    finally { finishWrite(operationId) }
  }
  return { operations, capabilities, next, loaded, selectedId, submitted, issue, busy, issuer, setIssuer, label, setLabel, read, begin, inspect, advance,
    select(operationId: string | null) { selectionEpoch.current++; selection.current = operationId; setSelectedId(operationId); setIssue('') },
    operation: operations.find(item => item.operationId === selectedId) ?? null }
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
  if (submitted && !submittedResult) history.unshift({ input: submitted, operation: null })
  const preparing = !!current && !operation && busy === selectedId
  const title = preparing ? 'Preparing your bot setup' : saved ? 'Application saved' : operation?.authorization === 'pending' ? 'Scan to connect your bot' : operation?.authorization === 'authorized' ? 'Finish connecting your bot' : current ? 'Your bot setup' : unfinished ? 'Resume your bot setup' : 'Connect your bot'
  const summary = preparing ? 'Preparing a secure confirmation for this setup. You can leave and return to its original result.' : saved ? 'Your application is saved. Its live connection and group access are checked separately.'
    : operation?.authorization === 'pending' ? `Scan with ${issuerLabel} and confirm the bot’s creation there. Then check the confirmation here.`
    : operation?.authorization === 'denied' ? 'The platform did not approve this setup. Its original result is kept below.'
    : operation?.authorization === 'expired' ? 'The platform confirmation has expired. This does not confirm whether an application was created.'
    : operation?.authorization === 'authorized' ? 'The application was created. Continue this same setup to finish saving it on this environment.'
    : current ? 'The result is not confirmed. Check the original result or continue its local recovery without creating another bot.'
    : unfinished ? 'Resume the same bot setup to check or finish its original result.' : ''
  useEffect(() => { openAttempt.current++; setOpenIssue(''); return () => { openAttempt.current++ } }, [selectedId, operation?.challenge?.verificationUrl])
  const openConfirmation = async () => {
    if (!operation?.challenge) return
    const attempt = ++openAttempt.current
    try { await api.ui.openExternal(operation.challenge.verificationUrl) }
    catch (error) { if (attempt === openAttempt.current) setOpenIssue(presentError(error)) }
  }
  const canContinue = !!operation && !saved && !['denied', 'expired'].includes(operation.authorization) && operation.configuration !== 'refused'
  return <section className="connector-setup connector-enrollment" data-bot-enrollment data-enrollment-operation={selectedId ?? undefined}>
    {current ? <button className="connector-back small-button" onClick={() => { enrollment.select(null); void enrollment.read() }}>All bot setups</button> : null}
    <header className="connector-setup__heading"><span className="connector-setup__mark"><BotIcon size={22} /></span><div><h3 className="connector-editor-title">{title}</h3>{summary ? <p>{summary}</p> : null}</div></header>
    {!current ? <>
      {unfinished ? <p className="connector-enrollment__identity"><strong>{submitted!.label}</strong><span>{enrollment.capabilities.find(item => item.adapterId === submitted!.adapterId && item.domain === submitted!.domain)?.label ?? submitted!.domain}</span></p> : <>
      {available.length > 1 ? <SelectionField label="Bot creation platform" value={selectedIssuer ? issuerKey(selectedIssuer) : issuer} options={available.map(item => ({ value: issuerKey(item), label: item.label }))} onValueChange={setIssuer} /> : selectedIssuer ? <p className="settings-group-note">Create with {selectedIssuer.label}. Confirmation stays with your platform.</p> : <p role="status" className="settings-group-note">{!enrollment.loaded ? 'Reading bot setup options…' : 'Scan setup is not available here. You can still connect an existing bot.'}</p>}
      <details className="connector-optional"><summary>Name in AgentMux</summary><label className="settings-field"><span>Bot name <small>Optional</small></span><TextInput aria-label="New bot name" value={label} onChange={event => setLabel(event.target.value)} placeholder="Your bot’s name here" /></label></details>
      </>}
      <div className="connector-editor-actions">{unfinished ? <button data-enrollment-resume className="primary-button" onClick={() => enrollment.select(submitted!.operationId)}>Resume this setup</button> : selectedIssuer ? <button data-enrollment-create className="primary-button" disabled={!!busy} onClick={() => void enrollment.begin(selectedIssuer, label)}>Create and connect a bot</button> : <button className="small-button" onClick={() => void enrollment.read()}>Check setup options</button>}<button data-enrollment-existing className="small-button" onClick={onExisting}>Connect an existing bot</button></div>
    </> : <>
      <p className={`connector-enrollment__identity${saved ? ' connector-connection-state' : ''}`} role={saved ? 'status' : undefined}><strong>{current.label}</strong><span>{issuerLabel}</span></p>
      {operation?.authorization === 'pending' && operation.challenge ? <div className="connector-enrollment__confirmation">
        <ConfirmationCode key={operation.challenge.verificationUrl}><div className="connector-enrollment__code" data-enrollment-code><QRCodeSVG value={operation.challenge.verificationUrl} size={232} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111715" title="Bot application confirmation" role="img" /></div></ConfirmationCode>
        <div>{operation.challenge.userCode ? <p className="connector-enrollment__public-code">Confirmation code <strong>{operation.challenge.userCode}</strong></p> : null}<button className="small-button" data-enrollment-open onClick={() => void openConfirmation()}>Open confirmation page</button><p className="settings-group-note">Keep this setup while you confirm on your platform. Closing Settings only leaves this page.</p>{operation.challenge.expiresAt !== null ? <p className="settings-group-note">Confirmation valid until {new Date(operation.challenge.expiresAt).toLocaleTimeString()}.</p> : null}</div>
      </div> : null}
      <div className="connector-editor-actions">{saved ? <button data-enrollment-saved className="primary-button" onClick={() => onSaved(saved)}>View connection</button> : <>
        {canContinue ? <button data-enrollment-advance className="primary-button" disabled={!!busy} onClick={() => void enrollment.advance()}>{busy === selectedId ? 'Checking setup…' : operation?.authorization === 'pending' ? `Check ${issuerLabel} confirmation` : 'Continue this setup'}</button> : null}
        {operation?.authorization !== 'pending' ? <button data-enrollment-inspect className={canContinue ? 'small-button' : 'primary-button'} onClick={() => void enrollment.inspect()}>View original result</button> : null}
      </>}</div>
      {saved ? <div className="connector-next-step"><BotIcon size={18} /><div><strong>Next, choose an Agent and a group</strong><p>Open an Agent’s menu → Create group or Connect existing group. You choose the audience and what to share there.</p></div></div> : null}
      <details className="connector-diagnostics"><summary>Setup details</summary><dl className="connector-identity"><div><dt>Original setup</dt><dd><code>{selectedId}</code></dd></div><div><dt>Platform</dt><dd>{current.domain}</dd></div>{operation ? <><div><dt>Revision</dt><dd>{operation.revision}</dd></div><div><dt>Platform confirmation</dt><dd>{operation.authorization}</dd></div><div><dt>Credential storage</dt><dd>{operation.credential}</dd></div><div><dt>Application save</dt><dd>{operation.configuration}</dd></div>{operation.application ? <div><dt>App ID</dt><dd><code>{operation.application.appId}</code></dd></div> : null}{operation.reason ? <div><dt>Original result</dt><dd>{operation.reason}</dd></div> : null}</> : null}</dl>{operation?.authorization === 'pending' || saved ? <button data-enrollment-inspect className="small-button" onClick={() => void enrollment.inspect()}>View original result</button> : null}</details>
    </>}
    {openIssue ? <p role="status" className="connector-issue">{openIssue}</p> : null}
    {enrollment.issue ? <p role="status" className="connector-issue">{enrollment.issue}</p> : null}
    {!current && history.length ? <details className="connector-enrollment__history"><summary>Previous bot setups</summary>{history.map(({ input: item, operation: receipt }) => <button key={item.operationId} data-enrollment-select={item.operationId} className="connector-enrollment__previous" onClick={() => enrollment.select(item.operationId)}><strong>{item.label}</strong><span>{receipt ? receipt.configured ? 'Saved' : receipt.authorization === 'pending' ? 'Waiting for confirmation' : receipt.authorization === 'authorized' ? 'Application created · setup incomplete' : receipt.authorization === 'unknown' ? 'Result not confirmed' : receipt.authorization : 'Result not confirmed'}</span></button>)}</details> : null}
    {!current && enrollment.next ? <button data-enrollment-more className="small-button connector-back" onClick={() => void enrollment.read(enrollment.next!)}>Load earlier setups</button> : null}
  </section>
}
