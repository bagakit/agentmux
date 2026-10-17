import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfileDiagnostic, ConnectionProfileOperation } from '@agentmux/core/connections'
import { api } from '../../lib/api'
import { profileEffectLabels } from '../ConnectionProfileProgress'

function safeEffect(effect: ConnectionProfileOperation['upload']) {
  const diagnostic = effect.diagnostic
  return { state: effect.state, ...(diagnostic ? { diagnostic: {
    stage: diagnostic.stage,
    ...(diagnostic.nativeCode === undefined ? {} : { nativeCode: diagnostic.nativeCode }),
    ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
    ...(diagnostic.transportCode === undefined ? {} : { transportCode: diagnostic.transportCode })
  } } : {}) }
}
function Diagnostic({ diagnostic }: { diagnostic?: ConnectionProfileDiagnostic | undefined }) {
  return diagnostic ? <>{diagnostic.stage}{diagnostic.nativeCode === undefined ? null : ` · Platform code ${diagnostic.nativeCode}`}{diagnostic.httpStatus === undefined ? null : ` · HTTP ${diagnostic.httpStatus}`}{diagnostic.transportCode ? ` · ${diagnostic.transportCode}` : null}{diagnostic.nativeCode === undefined && diagnostic.httpStatus === undefined && !diagnostic.transportCode ? ' · Network details not recorded' : null}</> : <>Network details not recorded</>
}

/** Reads the existing original profile receipt; never refreshes platform observations or advances writes. */
export function ConnectionProfileTrace({ operationId, parentId, original }: {
  operationId?: string | undefined; parentId: string; original?: ConnectionProfileOperation | null | undefined
}) {
  const [open, setOpen] = useState(false), epoch = useRef(0)
  const [reading, setReading] = useState<{ id?: string | undefined; operation: ConnectionProfileOperation | null; busy: boolean; issue: string }>({ id: operationId, operation: original ?? null, busy: false, issue: '' })
  const [copied, setCopied] = useState('')
  const visible = reading.id === operationId ? reading : null
  const operation = visible?.operation ?? (original?.operationId === operationId ? original : null)
  async function load() {
    if (!operationId) return
    const token = ++epoch.current
    setReading(previous => ({ id: operationId, operation: previous.id === operationId ? previous.operation : null, busy: true, issue: '' }))
    try {
      const result = await api.connections.call('connection.profile.inspect', { operationId })
      if (token !== epoch.current) return
      if (!result.operation || result.operation.operationId !== operationId) throw new Error('Original profile receipt unavailable')
      setReading({ id: operationId, operation: result.operation, busy: false, issue: '' })
    } catch {
      if (token === epoch.current) setReading(previous => ({ ...previous, busy: false, issue: 'The original profile receipt could not be read. Earlier results and the original request are kept.' }))
    }
  }
  useEffect(() => {
    if (original && original.operationId === operationId) setReading({ id: operationId, operation: original, busy: false, issue: '' })
  }, [operationId, original])
  useEffect(() => { setCopied(''); if (open) void load(); return () => { epoch.current++ } }, [operationId, original, open])
  return <details className="connector-request-trace connector-profile-trace" data-profile-trace open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>Request trace</strong><span>{visible?.busy ? 'Reading…' : operation ? '2 effect receipts' : 'Original profile request'}</span></summary>
    <div className="connector-request-trace__body">
      <p>Original image upload and profile write receipts. These do not confirm publication or the current online profile. Missing HTTP details cannot be reconstructed.</p>
      <div className="connector-request-trace__actions">
        <button type="button" className="small-button" disabled={!operationId || visible?.busy} onClick={() => void load()}>Refresh trace</button>
        <button type="button" className="small-button" disabled={!operation} onClick={async () => {
          if (!operation) return
          try {
            await api.ui.writeClipboardText(JSON.stringify({ operationId: operation.operationId, parentOperationId: parentId, upload: safeEffect(operation.upload), patch: safeEffect(operation.patch), publication: operation.publication, reason: operation.reason ?? null }, null, 2))
            setCopied('Sanitized trace copied.')
          } catch { setCopied('Could not copy. The original receipt remains available here.') }
        }}>Copy diagnosis</button>
      </div>
      <p role="status" className="connector-request-trace__feedback">{visible?.issue || copied}</p>
      {operation ? <div className="connector-request-trace__scroll" tabIndex={0} aria-label="Original profile effects"><table>
        <thead><tr><th>Original effect</th><th>Result</th></tr></thead>
        <tbody>{([['upload', 'Upload bot image'], ['patch', 'Write bot profile']] as const).map(([key, label]) => <tr key={key}><td>{label}</td><td data-result={operation[key].state}>{profileEffectLabels[operation[key].state]}<small><Diagnostic diagnostic={operation[key].diagnostic} /></small></td></tr>)}</tbody>
      </table></div> : <p>The original profile request is kept. Its effect receipts are not available yet.</p>}
      <div className="connector-request-trace__identity"><span>Original profile update</span><code>{operationId ?? 'Awaiting the original child receipt'}</code><span>Mote request</span><code>{parentId}</code></div>
    </div>
  </details>
}
