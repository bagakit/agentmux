import { useEffect, useRef, useState } from 'react'
import type { ConnectionRequestTrace as RequestTracePage } from '@agentmux/core/connections'
import { api } from '../../lib/api'

export type ConnectionTraceSource = { kind: 'enrollment' | 'setup'; operationId: string }
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
export function ConnectionRequestTrace({ source, revision, title = 'Request trace' }: { source: ConnectionTraceSource | null; revision?: number | string | undefined; title?: string | undefined }) {
  const key = source ? JSON.stringify([source.kind, source.operationId]) : ''
  const [open, setOpen] = useState(false), [reading, setReading] = useState<{ key: string; page: RequestTracePage | null; issue: string; busy: boolean }>({ key, page: null, issue: '', busy: false })
  const [copied, setCopied] = useState(''), [copying, setCopying] = useState(false), epoch = useRef(0), exportRead = useRef(0)
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
  useEffect(() => { setCopying(false); setCopied(''); return () => { exportRead.current++ } }, [key, open])
  const page = visible?.page
  async function copyDiagnosis() {
    if (!page || copying) return
    const token = ++exportRead.current, entries: RequestTracePage['entries'] = []
    let cursor: string | null | undefined
    setCopying(true); setCopied('Reading the complete original trace…')
    try {
      do {
        const next = await readPage(cursor ?? undefined, cursor ? 100 : 25)
        if (token !== exportRead.current) return
        entries.push(...next.entries); cursor = next.next
      } while (cursor)
      if (token !== exportRead.current) return
      await api.ui.writeClipboardText(JSON.stringify({ operationId: page.operationId, entries, next: null }, null, 2))
      if (token === exportRead.current) setCopied('Complete sanitized trace copied.')
    } catch {
      if (token === exportRead.current) setCopied('Could not copy the complete diagnosis. The original trace remains available here.')
    } finally { if (token === exportRead.current) setCopying(false) }
  }
  return <details className="connector-request-trace" data-request-trace open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{title}</strong><span>{visible?.busy ? 'Reading…' : page ? page.entries.length + (page.next ? '+' : '') + ' steps' : source ? 'Original request' : 'No request yet'}</span></summary>
    <div className="connector-request-trace__body">
      <p>Original operation-step receipts, with recorded error codes where available. No request URLs, bodies, cookies, secrets, sign-in codes or account details are included.</p>
      {source ? <><div className="connector-request-trace__actions"><button className="small-button" disabled={visible?.busy} onClick={() => void load()}>Refresh trace</button><button className="small-button" disabled={!page || copying} onClick={() => void copyDiagnosis()}>{copying ? 'Copying…' : 'Copy diagnosis'}</button></div><p className="connector-request-trace__feedback" role="status">{copied || visible?.issue}</p>
      {page?.entries.length ? <div className="connector-request-trace__scroll" tabIndex={0} aria-label="Original request steps"><table><thead><tr><th>#</th><th>Request step</th><th>Result</th><th>Local record</th><th>Original step</th></tr></thead><tbody>{page.entries.map(entry => <tr key={entry.stepId}><td>{entry.sequence}</td><td><strong>{labels[entry.action] ?? entry.action}</strong>{entry.subject || entry.effect ? <small>{labels[entry.subject ?? entry.effect!] ?? entry.subject ?? entry.effect}</small> : null}</td><td data-result={entry.request}>{requestLabels[entry.request]}{entry.diagnostic ? <small>{entry.diagnostic.httpStatus === undefined ? null : `HTTP ${entry.diagnostic.httpStatus}`}{entry.diagnostic.nativeCode === undefined ? null : ` · Platform code ${entry.diagnostic.nativeCode}`}{entry.diagnostic.code ? ` · ${entry.diagnostic.code}` : null}</small> : null}</td><td>{entry.secureStorage ? storageLabels[entry.secureStorage] : 'Not recorded'}</td><td><code>{entry.stepId}</code></td></tr>)}</tbody></table></div> : page ? <p>No request steps are recorded for this original operation.</p> : null}
      {page?.next ? <button className="small-button" disabled={visible?.busy} onClick={() => void load(page.next!)}>More original steps</button> : null}<div className="connector-request-trace__identity"><span>Original request</span><code>{source.operationId}</code></div></> : <p>Requests will appear here when this setup starts.</p>}
    </div>
  </details>
}
