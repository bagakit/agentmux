import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionRequestTrace as RequestTracePage, ConnectionSetupView, ConnectionEnrollmentView } from '@agentmux/core/connections'
import { collectConnectionDiagnosis, formatConnectionDiagnosis, type ConnectionDiagnosisTarget } from '../../lib/connection-diagnosis'
import { api } from '../../lib/api'

export type ConnectionTraceSource = { kind: 'enrollment' | 'setup'; operationId: string }
const LoadingIcon = semanticIconComponent('status.loading')
const RefreshIcon = semanticIconComponent('action.refresh')
const CopyIcon = semanticIconComponent('action.copy')
const labels: Record<string, string> = {
  initialize: 'Start sign-in', 'enrollment-handoff': 'Continue saved sign-in', authentication: 'Sign-in check',
  upload: 'Upload bot image', create: 'Create application', credential: 'Read original credential',
  continue: 'Continue sign-in', 'confirm-account': 'Confirm account', renew: 'Renew sign-in code',
  'inspect-application': 'Check application access', 'read-application': 'Read settings', 'configure-application': 'Change settings',
  'bot-settings': 'Bot messages', 'permission-catalog': 'Permission directory', 'application-permissions': 'Application permissions',
  'event-settings': 'Event delivery', 'event-catalog': 'Event directory', 'callback-settings': 'Card callbacks',
  'publication-pending': 'Pending changes', 'publication-versions': 'Version list', 'publication-visibility': 'Application audience',
  'publication-sharing': 'External sharing', 'publication-features': 'Publication features', 'publication-version': 'Exact version',
  'enable-messaging': 'Enable bot messages', 'use-persistent-connection': 'Persistent event delivery',
  'use-persistent-callback': 'Persistent card callbacks', 'add-card-actions': 'Card replies',
  'add-application-permissions': 'Request permissions', 'add-message-reception': 'Message reception',
  'create-application-version': 'Create version', 'submit-application-version': 'Submit version',
  'upload-profile-avatar': 'Upload bot image', 'update-application-profile': 'Write bot profile'
}
const requestLabels: Record<string, string> = { 'not-dispatched': 'Not sent', claimed: 'Claimed', settled: 'Step recorded', dispatching: 'In progress', confirmed: 'Confirmed', unknown: 'Unconfirmed', refused: 'Refused' }
const storageLabels: Record<string, string> = { 'not-started': 'Not started', storing: 'Saving', stored: 'Saved', unknown: 'Unconfirmed' }

/** A disposable reader of the exact public journal. Opening never advances the original operation. */
export function ConnectionRequestTrace({ source, revision, title = 'Request trace', setupView, enrollmentView, diagnosisTarget, hideCopy = false }: { source: ConnectionTraceSource | null; revision?: number | string | undefined; title?: string | undefined; setupView?: ConnectionSetupView | null | undefined; enrollmentView?: ConnectionEnrollmentView | null | undefined; diagnosisTarget?: ConnectionDiagnosisTarget | null | undefined; hideCopy?: boolean | undefined }) {
  const key = source ? JSON.stringify([source.kind, source.operationId]) : ''
  const [open, setOpen] = useState(false), [reading, setReading] = useState<{ key: string; page: RequestTracePage | null; issue: string; busy: boolean }>({ key, page: null, issue: '', busy: false })
  const [copied, setCopied] = useState(''), [copying, setCopying] = useState(false), epoch = useRef(0), exportRead = useRef(0)
  const target = diagnosisTarget ?? source, exportKey = target ? JSON.stringify([target.kind, target.operationId, target.kind === 'mote' ? target.sourceTarget : null]) : ''
  const visible = reading.key === key ? reading : null
  async function readPage(cursor?: string, limit = 25) {
    if (!source) throw new Error('Original trace unavailable')
    const result = source.kind === 'enrollment'
      ? await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId, requestTrace: { limit, ...(cursor ? { cursor } : {}) } })
      : await api.connections.call('connection.setup.inspect', { operationId: source.operationId, requestTrace: { limit, ...(cursor ? { cursor } : {}) } })
    const page = result.requestTrace
    if (!page || page.operationId !== source.operationId) throw new Error('Original trace unavailable')
    return page
  }
  async function load(cursor?: string) {
    if (!source) return
    const token = ++epoch.current
    setCopied('')
    setReading(previous => ({ key, page: previous.key === key ? previous.page : null, issue: '', busy: true }))
    try {
      const page = await readPage(cursor)
      if (token !== epoch.current) return
      setReading(previous => ({ key, page: cursor && previous.key === key && previous.page ? { ...page, entries: [...previous.page.entries, ...page.entries.filter(entry => !previous.page!.entries.some(original => original.stepId === entry.stepId))] } : page, issue: '', busy: false }))
    } catch {
      if (token === epoch.current) setReading(previous => ({ key, page: previous.key === key ? previous.page : null, issue: 'The request trace could not be read. Your original operation and earlier results are kept.', busy: false }))
    }
  }
  useEffect(() => { setCopied(''); if (open && source) void load(); return () => { epoch.current++ } }, [key, open, revision])
  useEffect(() => { setCopying(false); setCopied(''); return () => { exportRead.current++ } }, [exportKey, open])
  const page = visible?.page
  async function copyDiagnosis() {
    if (!target || copying) return
    const token = ++exportRead.current
    setCopying(true); setCopied('Reading the complete original task…')
    try {
      const report = await collectConnectionDiagnosis(target, { setupView, enrollmentView, current: () => token === exportRead.current })
      if (token !== exportRead.current) return
      await api.ui.writeClipboardText(formatConnectionDiagnosis(report))
      if (token === exportRead.current) setCopied(report.complete ? 'Complete sanitized diagnosis copied.' : 'Diagnosis copied with unavailable sections; the report is incomplete.')
    } catch {
      if (token === exportRead.current) setCopied('Could not copy the diagnosis. The original task remains available here.')
    } finally { if (token === exportRead.current) setCopying(false) }
  }
  function cancelCopy() { exportRead.current++; setCopying(false); setCopied('Diagnosis copy canceled.') }
  return <section className="connector-request-trace">
    {!hideCopy ? <div className="connector-request-trace__export"><div className="connector-request-trace__actions"><button className="small-button" aria-busy={copying} disabled={!target || copying} onClick={() => void copyDiagnosis()}>{copying ? <LoadingIcon size={13} animation="spin" /> : <CopyIcon size={13} />}Copy diagnosis</button>{copying ? <button className="small-button" onClick={cancelCopy}>Cancel copy</button> : null}</div><p className="connector-request-trace__feedback" role="status">{copying ? 'Reading the complete original task…' : copied}</p></div> : null}
    <details data-request-trace data-connection-request-trace open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-busy={visible?.busy ?? false}><strong>{title}</strong><span>{page ? page.entries.length + (page.next ? '+' : '') + ' steps' : visible?.busy ? 'Reading…' : source ? 'Original request' : 'No request yet'}{visible?.busy ? <LoadingIcon size={13} animation="spin" /> : null}</span></summary>
    <div className="connector-request-trace__body">
      <p>Original operation-step receipts, with recorded error codes where available. No request URLs, bodies, cookies, secrets, sign-in codes or account details are included.{source?.kind === 'setup' && setupView?.operation?.operationId === source.operationId ? ' The copied context is one observed setup snapshot, separate from the paginated history.' : ''}</p>
      {source ? <><div className="connector-request-trace__actions"><button className="small-button" aria-busy={visible?.busy ?? false} disabled={visible?.busy} onClick={() => void load()}>{visible?.busy ? <LoadingIcon size={13} animation="spin" /> : <RefreshIcon size={13} />}Refresh trace</button></div><p className="connector-request-trace__feedback" role="status">{visible?.issue}</p>
      {page?.entries.length ? <div className="connector-request-trace__scroll" tabIndex={0} aria-label="Original request steps"><table><thead><tr><th>#</th><th>Request step</th><th>Result</th><th>Local record</th><th>Original step</th></tr></thead><tbody>{page.entries.map(entry => <tr key={entry.stepId}><td>{entry.sequence}</td><td><strong>{labels[entry.action] ?? entry.action}</strong>{entry.subject || entry.effect ? <small>{labels[entry.subject ?? entry.effect!] ?? entry.subject ?? entry.effect}</small> : null}</td><td data-result={entry.request}>{requestLabels[entry.request]}{entry.diagnostic ? <small>{entry.diagnostic.httpStatus === undefined ? null : `HTTP ${entry.diagnostic.httpStatus}`}{entry.diagnostic.nativeCode === undefined ? null : ` · Platform code ${entry.diagnostic.nativeCode}`}{entry.diagnostic.code ? ` · ${entry.diagnostic.code}` : null}</small> : null}</td><td>{entry.secureStorage ? storageLabels[entry.secureStorage] : 'Not recorded'}</td><td><code>{entry.stepId}</code></td></tr>)}</tbody></table></div> : page ? <p>No request steps are recorded for this original operation.</p> : null}
      {page?.next ? <button className="small-button" disabled={visible?.busy} onClick={() => void load(page.next!)}>More original steps</button> : null}<div className="connector-request-trace__identity"><span>Original request</span><code>{source.operationId}</code></div></> : <p>Requests will appear here when this setup starts.</p>}
    </div>
  </details></section>
}
