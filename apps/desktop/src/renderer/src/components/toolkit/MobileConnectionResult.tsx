import { Textarea } from '@agentmux/client-ui/input'
import { Copy, LoaderCircle, QrCode, RefreshCw, Settings2, Smartphone, X } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import type { ToolkitConfirmedResult } from '@agentmux/core/control'
import { MOBILE_CONNECTION_TOOL_ID } from '../../../../shared/toolkit-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { SettingsNavigation } from '../SettingsNavigation'
import { ConnectionLinkCode } from './ConnectionLinkCode'
import { continueToolkitRequest, CONTINUE_TOOLKIT_NOTICE } from './continue-toolkit-request'
import { toolkitResultDocument, type ToolkitResultDocument } from './toolkit-result-document'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'

type Request = { invocationId: string; kind: 'entry-for-link' | 'link' | 'refresh' }
type Connection = { url: string; result: ToolkitConfirmedResult }

/** Phone presentation; all queries and actions still use the original public Toolkit owner. */
export function MobileConnectionResult({ active, close }: { active: boolean; close(): void }) {
  const reading = useToolkitScriptObservation(api.toolkit, MOBILE_CONNECTION_TOOL_ID, active)
  const { snapshot } = reading
  const navigation = useContext(SettingsNavigation)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [devices, setDevices] = useState<{ document: ToolkitResultDocument; at: number } | null>(null)
  const [operation, setOperation] = useState<'generate' | 'refresh' | 'continue' | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const requested = useRef<Request | null>(null)
  const admission = snapshot?.admission
  const unconfirmed = snapshot?.state === 'unknown' || Boolean(reading.error)
  const canRun = Boolean(snapshot && !admission && !unconfirmed && !reading.sourceReason && !reading.pending && snapshot.definition.enabled && !operation)
  const name = snapshot?.definition.name ?? 'Phone connection'

  useEffect(() => {
    const result = snapshot?.latestConfirmed
    if (result?.state !== 'succeeded') return
    const document = toolkitResultDocument(result.text)
    if (!document) return
    setDevices({ document, at: result.endedAt })
    const link = document.links[0]
    if (link) setConnection({ url: link.url, result })
  }, [snapshot?.latestConfirmed])

  async function invoke(request: Request, call: () => Promise<unknown>) {
    requested.current = request; setError(''); setNotice('')
    try { await call(); await reading.check() }
    catch (cause) { requested.current = null; setOperation(null); setError(presentError(cause)); await reading.check() }
  }
  async function link(source: ToolkitConfirmedResult) {
    const action = source.definition.actions?.find(item => item.id === 'link')
    if (!action) { requested.current = null; setOperation(null); setError('The connection action is unavailable. Open tool settings to inspect its source.'); return }
    const invocationId = crypto.randomUUID()
    await invoke({ invocationId, kind: 'link' }, () => api.toolkit.action(MOBILE_CONNECTION_TOOL_ID, action.id,
      { invocationId, expectedRevision: source.definition.revision, sourceExecutionId: source.executionId, expectedAdmissionExecutionId: null }))
  }
  useEffect(() => {
    const request = requested.current, result = snapshot?.latestConfirmed
    if (!request) return
    if (reading.error || snapshot?.state === 'unknown') { requested.current = null; setOperation(null); return }
    if (!result || result.invocationId !== request.invocationId || snapshot?.admission) return
    requested.current = null
    if (request.kind === 'entry-for-link' && result.state === 'succeeded' && result.definition.revision === snapshot.definition.revision) {
      void link(result); return
    }
    setOperation(null)
    if (result.state !== 'succeeded') setError(result.reason ?? 'The connection request did not finish. Previous connection details are kept.')
    else if (request.kind === 'link' && !toolkitResultDocument(result.text)?.links[0]) setError('The request finished without a connection link. Previous details are kept.')
  }, [snapshot?.latestConfirmed, snapshot?.admission, snapshot?.state, reading.error])

  async function generate() {
    if (!snapshot || !canRun || requested.current) return
    setOperation('generate')
    const source = snapshot.latestConfirmed
    if (source && source.definition.revision === snapshot.definition.revision) { await link(source); return }
    const invocationId = crypto.randomUUID()
    await invoke({ invocationId, kind: 'entry-for-link' }, () => api.toolkit.run(MOBILE_CONNECTION_TOOL_ID,
      { invocationId, expectedRevision: snapshot.definition.revision, expectedLatestExecutionId: source?.executionId ?? null }))
  }
  async function refresh() {
    if (!snapshot || !canRun || requested.current) return
    setOperation('refresh')
    const invocationId = crypto.randomUUID()
    await invoke({ invocationId, kind: 'refresh' }, () => api.toolkit.run(MOBILE_CONNECTION_TOOL_ID,
      { invocationId, expectedRevision: snapshot.definition.revision, expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null }))
  }
  async function continueOriginal() {
    if (!admission || operation || requested.current) return
    setOperation('continue')
    await invoke({ invocationId: admission.invocationId, kind: admission.action?.id === 'link' ? 'link' : 'refresh' },
      () => continueToolkitRequest(api.toolkit, MOBILE_CONNECTION_TOOL_ID, admission))
  }
  async function copy() {
    if (!connection) return
    setNotice(''); setError('')
    try { await api.ui.writeClipboardText(connection.url); setNotice('Connection link copied.') }
    catch (cause) { setError(`Could not copy the link. Select the full link below. ${presentError(cause)}`) }
  }
  const issue = reading.error || reading.sourceReason || error
  const running = Boolean(admission && !unconfirmed)
  return <>
    <header className="performance-header phone-connection__header"><div className="performance-title"><Smartphone size={18} /><h2>{name}</h2></div>
      <button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><X size={15} /></button></header>
    <div className="performance-body phone-connection">
      <section className="phone-connection__connect" aria-label="Connect your phone">
        <p className="phone-connection__intro">Your workspace, on your phone.</p>
        <p className="phone-connection__hint">Connect both devices to the same Wi-Fi.</p>
        {connection ? <>
          {unconfirmed ? <p className="phone-connection__code-state">Previously generated code · not rechecked</p> : null}
          <ConnectionLinkCode url={connection.url} />
          <p className="phone-connection__scan">Scan with your phone’s camera</p>
          <p className="phone-connection__address">{new URL(connection.url).host}</p>
          <div className="phone-connection__buttons"><button type="button" className="primary-button" onClick={() => void copy()}><Copy size={14} /> Copy link</button>
            <button type="button" className="small-button" disabled={!canRun} onClick={() => void generate()}>{operation === 'generate' ? <LoaderCircle size={14} className="toolkit-result__spinner" /> : <RefreshCw size={14} />} New code</button></div>
          <p className="phone-connection__updated">Generated <time dateTime={new Date(connection.result.endedAt).toISOString()}>{new Date(connection.result.endedAt).toLocaleString()}</time></p>
          <details className="phone-connection__link"><summary>View full connection link</summary><Textarea aria-label="Phone connection link" rows={3} readOnly value={connection.url} onFocus={event => event.target.select()} /></details>
        </> : <>
          <div className="phone-connection__placeholder"><QrCode size={48} strokeWidth={1.2} aria-hidden="true" /></div>
          <p className="phone-connection__scan">Scan a code to open AgentMux</p>
          <button type="button" className="primary-button phone-connection__generate" disabled={!canRun} onClick={() => void generate()}>{operation === 'generate' ? <LoaderCircle size={15} className="toolkit-result__spinner" /> : <QrCode size={15} />}{operation === 'generate' ? 'Generating…' : 'Generate connection code'}</button>
        </>}
        {notice ? <p className="phone-connection__feedback" role="status">{notice}</p> : null}
      </section>
      {unconfirmed || issue || running || snapshot?.state === 'failed' ? <section className="phone-connection__service" role="status">
        <strong>{snapshot?.state === 'unknown' ? admission?.action?.id === 'link' ? 'Last link request is unconfirmed' : 'Connection request is unconfirmed' : reading.error ? 'Connection status is unavailable' : running ? 'Connection request in progress' : 'Connection needs attention'}</strong>
        <p>{unconfirmed ? 'Previous connection details are kept. Check the request before generating another code.' : issue || snapshot?.reason || 'Waiting for the original request to finish.'}</p>
        {unconfirmed && admission?.run === null ? <><p>{CONTINUE_TOOLKIT_NOTICE}</p><button type="button" className="small-button" disabled={Boolean(operation)} onClick={() => void continueOriginal()}><RefreshCw size={13} />{operation === 'continue' ? 'Continuing…' : 'Continue original request'}</button></> : null}
        <button type="button" className="small-button" disabled={reading.pending} onClick={() => void reading.check()}><RefreshCw size={13} /> Check status</button>
        {snapshot?.reason || issue ? <details><summary>Request details</summary><p>{issue || snapshot?.reason}</p>{admission ? <p>Execution · {admission.executionId}</p> : null}</details> : null}
      </section> : null}
      <section className="phone-connection__devices" aria-label="Device status">
        <header><h3>Devices</h3><button type="button" className="performance-icon-button" aria-label="Refresh devices" title="Refresh devices" disabled={!canRun} onClick={() => void refresh()}>{operation === 'refresh' ? <LoaderCircle size={14} className="toolkit-result__spinner" /> : <RefreshCw size={14} />}</button></header>
        {devices ? <><p className="phone-connection__device-summary">{devices.document.summary}<time dateTime={new Date(devices.at).toISOString()}>Checked {new Date(devices.at).toLocaleTimeString()}</time></p>
          {devices.document.items.length ? <ul>{devices.document.items.map((device, index) => <li key={index}><Smartphone size={15} aria-hidden="true" /><span>{device.label}</span><small data-online={device.value === 'Online'}>{device.value}</small></li>)}</ul> : <p className="phone-connection__hint">No devices yet. Your phone will appear after connecting.</p>}
          {devices.document.notice ? <details className="phone-connection__device-details"><summary>Connection information</summary><p>{devices.document.notice}</p></details> : null}
        </> : <p className="phone-connection__hint">{reading.pending ? 'Reading saved device status…' : 'Refresh to check your connected devices.'}</p>}
      </section>
    </div>
    <footer className="performance-actions phone-connection__footer"><button type="button" onClick={() => { close(); navigation?.open('devices') }}><Smartphone size={14} /> Manage devices</button><button type="button" aria-label="Phone connection settings" title="Phone connection settings" onClick={() => { close(); navigation?.openToolkit(MOBILE_CONNECTION_TOOL_ID) }}><Settings2 size={14} /></button></footer>
  </>
}
