import { Textarea } from '@agentmux/client-ui/input'
import { Copy, LoaderCircle, QrCode, RefreshCw, Settings2, Smartphone, X } from 'lucide-react'
import { useContext, useEffect, useState } from 'react'
import type { ToolkitConfirmedResult } from '@agentmux/core/control'
import { MOBILE_CONNECTION_TOOL_ID } from '../../../../shared/toolkit-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { SettingsNavigation } from '../SettingsNavigation'
import { ConnectionLinkCode } from './ConnectionLinkCode'
import { continueToolkitRequest, CONTINUE_TOOLKIT_NOTICE } from './continue-toolkit-request'
import { toolkitResultDocument, type ToolkitResultDocument } from './toolkit-result-document'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'

type Connection = { url: string; result: ToolkitConfirmedResult; current: boolean }

/** The declared display program owns current phone facts; original actions keep their own receipts. */
export function MobileConnectionResult({ active, close }: { active: boolean; close(): void }) {
  const reading = useToolkitScriptObservation(api.toolkit, MOBILE_CONNECTION_TOOL_ID, active, true)
  const { snapshot } = reading
  const navigation = useContext(SettingsNavigation)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [devices, setDevices] = useState<{ document: ToolkitResultDocument; at: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false), [continuing, setContinuing] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [copyError, setCopyError] = useState(''), [previousError, setPreviousError] = useState('')
  const display = snapshot?.display
  const admission = snapshot?.admission
  const evaluating = display?.state === 'pending' || display?.state === 'running' || display?.state === 'stopping'
  const canEvaluate = Boolean(snapshot?.definition.enabled && !reading.sourceReason && !evaluating && !refreshing)
  const name = snapshot?.definition.name ?? 'Phone connection'

  useEffect(() => {
    const displayResult = display?.latestConfirmed?.state === 'succeeded' ? display.latestConfirmed : display?.lastSucceeded
    const result = displayResult ?? snapshot?.latestConfirmed
    if (result?.state !== 'succeeded') return
    const document = toolkitResultDocument(result.text)
    if (!document) return
    setDevices({ document, at: result.endedAt })
    const link = document.links[0]
    if (link) setConnection({ url: link.url, result, current: Boolean(displayResult) })
  }, [display?.latestConfirmed, display?.lastSucceeded, snapshot?.latestConfirmed])

  async function refresh() {
    if (!canEvaluate) return
    setRefreshing(true); setError(''); setNotice('')
    try { await api.toolkit.evaluate(MOBILE_CONNECTION_TOOL_ID); await reading.check() }
    catch (cause) { setError(presentError(cause)); await reading.check() }
    finally { setRefreshing(false) }
  }
  async function continueOriginal() {
    if (!admission || continuing) return
    setContinuing(true); setPreviousError('')
    try { await continueToolkitRequest(api.toolkit, MOBILE_CONNECTION_TOOL_ID, admission); await reading.check() }
    catch (cause) { setPreviousError(presentError(cause)); await reading.check() }
    finally { setContinuing(false) }
  }
  async function copy() {
    if (!connection) return
    setNotice(''); setCopyError('')
    try { await api.ui.writeClipboardText(connection.url); setNotice('Connection link copied.') }
    catch (cause) { setCopyError(`Could not copy the link. Select the full link below. ${presentError(cause)}`) }
  }
  const displayIssue = reading.error || reading.sourceReason || error || (display?.state === 'unknown' || display?.state === 'failed' || display?.state === 'stopped' ? display.reason || 'Current connection details could not be confirmed.' : '')
  const oldUnknown = snapshot?.state === 'unknown'
  const oldRunning = Boolean(admission && !oldUnknown)
  const currentCode = connection?.current && display?.state === 'succeeded' && !reading.error
  return <>
    <header className="performance-header phone-connection__header"><div className="performance-title"><Smartphone size={18} /><h2>{name}</h2></div>
      <button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><X size={15} /></button></header>
    <div className="performance-body phone-connection">
      <section className="phone-connection__connect" aria-label="Connect your phone">
        <p className="phone-connection__intro">Your workspace, on your phone.</p>
        <p className="phone-connection__hint">Connect both devices to the same Wi-Fi.</p>
        {connection ? <>
          {!currentCode ? <p className="phone-connection__code-state">{evaluating || refreshing ? 'Updating connection details…' : 'Saved code · current details not confirmed'}</p> : null}
          <ConnectionLinkCode url={connection.url} />
          <p className="phone-connection__scan">Scan with your phone’s camera</p>
          <p className="phone-connection__address">{new URL(connection.url).host}</p>
          <div className="phone-connection__buttons"><button type="button" className="primary-button" onClick={() => void copy()}><Copy size={14} /> Copy link</button>
            <button type="button" className="small-button" disabled={!canEvaluate} onClick={() => void refresh()}>{evaluating || refreshing ? <LoaderCircle size={14} className="toolkit-result__spinner" /> : <RefreshCw size={14} />} Refresh</button></div>
          <p className="phone-connection__updated">{connection.current ? 'Checked' : 'Saved'} <time dateTime={new Date(connection.result.endedAt).toISOString()}>{new Date(connection.result.endedAt).toLocaleString()}</time></p>
          <details className="phone-connection__link"><summary>View full connection link</summary><Textarea aria-label="Phone connection link" rows={3} readOnly value={connection.url} onFocus={event => event.target.select()} /></details>
        </> : <>
          <div className="phone-connection__placeholder"><QrCode size={48} strokeWidth={1.2} aria-hidden="true" /></div>
          <p className="phone-connection__scan">{evaluating || reading.pending || refreshing ? 'Preparing your connection code…' : 'Scan a code to open AgentMux'}</p>
          {!(evaluating || reading.pending || refreshing) ? <button type="button" className="primary-button phone-connection__generate" disabled={!canEvaluate} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh connection</button> : null}
        </>}
        {notice ? <p className="phone-connection__feedback" role="status">{notice}</p> : null}
        {copyError ? <p className="phone-connection__feedback" role="alert">{copyError}</p> : null}
      </section>
      {displayIssue ? <section className="phone-connection__service" role="status">
        <strong>Current connection details are unavailable</strong><p>{displayIssue}</p>
        {connection ? <p>The saved code and its original time are kept. Refresh to check current details.</p> : null}
        <button type="button" className="small-button" disabled={!canEvaluate} onClick={() => void refresh()}><RefreshCw size={13} /> Retry connection</button>
      </section> : null}
      <section className="phone-connection__devices" aria-label="Device status">
        <header><h3>Devices</h3><button type="button" className="performance-icon-button" aria-label="Refresh devices" title="Refresh devices" disabled={!canEvaluate} onClick={() => void refresh()}>{evaluating || refreshing ? <LoaderCircle size={14} className="toolkit-result__spinner" /> : <RefreshCw size={14} />}</button></header>
        {devices ? <><p className="phone-connection__device-summary">{devices.document.summary}<time dateTime={new Date(devices.at).toISOString()}>Checked {new Date(devices.at).toLocaleTimeString()}</time></p>
          {devices.document.items.length ? <ul>{devices.document.items.map((device, index) => <li key={index}><Smartphone size={15} aria-hidden="true" /><span>{device.label}</span><small>{device.value}</small></li>)}</ul> : <p className="phone-connection__hint">Your phone appears here while connected.</p>}
          {devices.document.notice ? <details className="phone-connection__device-details"><summary>Connection information</summary><p>{devices.document.notice}</p></details> : null}
        </> : <p className="phone-connection__hint">{evaluating || reading.pending ? 'Checking connected devices…' : 'Refresh to check your connected devices.'}</p>}
      </section>
      {oldUnknown || oldRunning || snapshot?.state === 'failed' ? <details className="phone-connection__service phone-connection__previous" data-toolkit-previous-request>
        <summary>{oldUnknown ? admission?.action?.id === 'link' ? 'Previous link request is unconfirmed' : 'Previous request is unconfirmed' : oldRunning ? 'Previous request is still in progress' : 'Previous request failed'}</summary>
        <p>This earlier request has its own execution record. Checking the current connection does not confirm or replace it.</p>
        {snapshot?.reason ? <p>{snapshot.reason}</p> : null}
        {previousError ? <p role="alert">{previousError}</p> : null}
        {admission ? <p>Execution · {admission.executionId}</p> : null}
        {oldUnknown && admission?.run === null ? <><p>{CONTINUE_TOOLKIT_NOTICE}</p><button type="button" className="small-button" disabled={continuing} onClick={() => void continueOriginal()}><RefreshCw size={13} />{continuing ? 'Continuing…' : 'Continue original request'}</button></> : null}
        <button type="button" className="small-button" disabled={reading.pending} onClick={() => void reading.check()}><RefreshCw size={13} /> Check previous request</button>
      </details> : null}
    </div>
    <footer className="performance-actions phone-connection__footer"><button type="button" onClick={() => { close(); navigation?.open('devices') }}><Smartphone size={14} /> Manage devices</button><button type="button" aria-label="Phone connection settings" title="Phone connection settings" onClick={() => { close(); navigation?.openToolkit(MOBILE_CONNECTION_TOOL_ID) }}><Settings2 size={14} /></button></footer>
  </>
}
