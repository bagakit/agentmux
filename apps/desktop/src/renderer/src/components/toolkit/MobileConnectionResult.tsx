import { Textarea } from '@agentmux/client-ui/input'
import { mintObjectId } from '@agentmux/core/object-id'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectConnectionCodeIcon = semanticIconComponent('object.connection-code')
const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')
import { useContext, useEffect, useRef, useState } from 'react'
import type { ToolkitConfirmedResult, ToolkitResultDocument, ToolkitRunInput } from '@agentmux/core/control'
import { MOBILE_CONNECTION_TOOL_ID } from '../../../../shared/toolkit-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { SettingsNavigation } from '../SettingsNavigation'
import { DevicePresence, PhoneConnectionCard } from './PhoneConnectionVisuals'
import { OpenInSurveyButton } from './ToolkitResultLink'
import { continueToolkitRequest, CONTINUE_TOOLKIT_NOTICE } from './continue-toolkit-request'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'

type Connection = { url: string; result: ToolkitConfirmedResult; current: boolean }
type CopyRequest = ToolkitRunInput & { workspacePath: string; executionId: string | null; phase: 'reading' | 'clipboard' }

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
  const [copyRequest, setCopyRequest] = useState<CopyRequest | null>(null)
  const pendingCopy = useRef<CopyRequest | null>(null)
  const current = useRef({ active, snapshot, sourceReason: reading.sourceReason })
  current.current = { active, snapshot, sourceReason: reading.sourceReason }
  const retainCopy = (value: CopyRequest | null) => { pendingCopy.current = value; setCopyRequest(value) }
  const ownsInvocation = (request: CopyRequest) => pendingCopy.current?.invocationId === request.invocationId
  const ownsCopy = (request: CopyRequest) => pendingCopy.current === request && current.current.active && !current.current.sourceReason &&
    current.current.snapshot?.definition.revision === request.expectedRevision && current.current.snapshot.definition.workspacePath === request.workspacePath
  useEffect(() => () => { current.current.active = false; pendingCopy.current = null }, [])
  const display = snapshot?.display
  const admission = snapshot?.admission
  const evaluating = display?.state === 'pending' || display?.state === 'running' || display?.state === 'stopping'
  const canEvaluate = Boolean(snapshot?.definition.enabled && !reading.sourceReason && !evaluating && !refreshing && !copyRequest)
  const name = snapshot?.definition.name ?? 'Phone connection'

  useEffect(() => {
    const displayResult = display?.latestConfirmed?.state === 'succeeded' && display.latestConfirmed.document ? display.latestConfirmed : display?.lastSucceeded
    const result = displayResult ?? snapshot?.latestConfirmed
    if (result?.state !== 'succeeded') return
    const copying = pendingCopy.current
    if (copying && (result.executionId !== copying.executionId || result.invocationId !== copying.invocationId ||
      result.definition.revision !== copying.expectedRevision || result.target.workspacePath !== copying.workspacePath)) return
    const document = result.document
    if (!document) return
    setDevices({ document, at: result.endedAt })
    const link = document.links[0]
    if (link) setConnection({ url: link.url, result, current: result === display?.latestConfirmed })
    else setConnection(current => current ? { ...current, current: false } : null)
  }, [display?.latestConfirmed, display?.lastSucceeded, snapshot?.latestConfirmed])

  useEffect(() => {
    if (!copyRequest) return
    if (!ownsCopy(copyRequest)) {
      retainCopy(null)
      if (active) setCopyError('The phone connection source changed. The shown link is kept; refresh to read it again.')
      return
    }
    if (copyRequest.phase !== 'reading' || !copyRequest.executionId) return
    const result = display?.latestConfirmed
    if (result?.executionId === copyRequest.executionId) {
      const exact = result.invocationId === copyRequest.invocationId && result.expectedLatestExecutionId === copyRequest.expectedLatestExecutionId &&
        result.definition.id === MOBILE_CONNECTION_TOOL_ID && result.definition.revision === copyRequest.expectedRevision && result.target.workspacePath === copyRequest.workspacePath
      const link = result.state === 'succeeded' && exact ? result.document?.links[0] : undefined
      if (!link) { retainCopy(null); setCopyError(result.reason || 'This connection lookup did not confirm a link. The shown link is kept; refresh to try again.'); return }
      const copying = { ...copyRequest, phase: 'clipboard' as const }
      retainCopy(copying)
      setError('')
      setConnection({ url: link.url, result, current: true })
      setDevices({ document: result.document!, at: result.endedAt })
      void api.ui.writeClipboardText(link.url).then(() => { if (ownsCopy(copying)) setNotice('Current connection link copied.') }, cause => {
        if (ownsCopy(copying)) setCopyError(`Could not copy the current link. The new code and full link are kept. ${presentError(cause)}`)
      }).finally(() => { if (pendingCopy.current === copying) retainCopy(null) })
    } else if (display?.state === 'unknown' || reading.error || result && result.executionId !== copyRequest.expectedLatestExecutionId && !display?.admission) {
      retainCopy(null); setCopyError(reading.error || display?.reason || 'This connection lookup is unconfirmed. The shown link is kept; check or refresh to try again.')
    }
  }, [snapshot, copyRequest, active, reading.sourceReason, reading.error])

  async function refreshAndCopy() {
    if (!snapshot || !canEvaluate || pendingCopy.current) return
    const request: CopyRequest = { invocationId: mintObjectId(), expectedRevision: snapshot.definition.revision,
      expectedLatestExecutionId: display?.latestConfirmed?.executionId ?? null, workspacePath: snapshot.definition.workspacePath, executionId: null, phase: 'reading' }
    retainCopy(request); setNotice(''); setCopyError('')
    try {
      const value = await api.toolkit.evaluate(MOBILE_CONNECTION_TOOL_ID, { invocationId: request.invocationId,
        expectedRevision: request.expectedRevision, expectedLatestExecutionId: request.expectedLatestExecutionId })
      if (!ownsCopy(request)) return
      const lane = value.kind === 'script' && value.toolId === MOBILE_CONNECTION_TOOL_ID ? value.display : undefined
      const execution = lane?.admission?.invocationId === request.invocationId ? lane.admission
        : lane?.latestConfirmed?.invocationId === request.invocationId ? lane.latestConfirmed : undefined
      if (!execution || execution.definition.revision !== request.expectedRevision || execution.target.workspacePath !== request.workspacePath ||
        execution.expectedLatestExecutionId !== request.expectedLatestExecutionId) throw new Error('This lookup did not return its original display execution. The shown link is kept.')
      retainCopy({ ...request, executionId: execution.executionId })
      await reading.check()
    } catch (cause) {
      if (ownsInvocation(request)) {
        retainCopy(null)
        if (current.current.active) setCopyError(presentError(cause))
      }
    }
  }

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
    retainCopy(null)
    setNotice(''); setCopyError('')
    try { await api.ui.writeClipboardText(connection.url); setNotice('Connection link copied.') }
    catch (cause) { setCopyError(`Could not copy the link. Select the full link below. ${presentError(cause)}`) }
  }
  const missingDocument = display?.latestConfirmed?.state === 'succeeded' && !display.latestConfirmed.document?.links.length
  const displayIssue = reading.error || reading.sourceReason || error || (missingDocument ? display.latestConfirmed?.reason || 'The connection lookup finished without a confirmed connection document. Refresh to check current details.' : '') || (display?.state === 'unknown' || display?.state === 'failed' || display?.state === 'stopped' ? display.reason || 'Current connection details could not be confirmed.' : '')
  const oldUnknown = snapshot?.state === 'unknown'
  const oldRunning = Boolean(admission && !oldUnknown)
  const currentCode = connection?.current && display?.state === 'succeeded' && !displayIssue
  return <>
    <header className="performance-header phone-connection__header"><div className="performance-title"><ThemeObjectPhoneIcon size={18} /><h2>{name}</h2></div>
      <button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><ThemeActionCloseIcon size={15} /></button></header>
    <div className="performance-body phone-connection">
      <section className="phone-connection__connect" aria-label="Connect your phone">
        <p className="phone-connection__intro">Your workspace, on your phone.</p>
        <p className="phone-connection__hint">Connect both devices to the same local network.</p>
        {connection ? <>
          {!currentCode ? <p className="phone-connection__code-state">{evaluating || refreshing ? 'Updating connection details…' : 'Saved code · current details not confirmed'}</p> : null}
          <PhoneConnectionCard url={connection.url} network={null} state={evaluating || refreshing ? 'updating' : currentCode ? 'current' : 'saved'} />
          <p className="phone-connection__scan">Scan with your phone’s camera</p>
          <div className="phone-connection__buttons"><button type="button" className="primary-button" disabled={!canEvaluate || Boolean(copyRequest)} onClick={() => void refreshAndCopy()}>{copyRequest ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionCopyIcon size={14} />} {copyRequest ? 'Reading current link…' : 'Refresh & copy link'}</button>
            <OpenInSurveyButton url={connection.url} note="Opens your phone page in Survey on this Mac. It connects as another device." />
            <button type="button" className="small-button" disabled={!canEvaluate} onClick={() => void refresh()}>{evaluating || refreshing ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionRefreshIcon size={14} />} Refresh</button></div>
          <p className="phone-connection__hint">Opening in Survey connects this Mac as another device. Choose a different network in Phone settings.</p>
          <p className="phone-connection__updated">{connection.current ? 'Checked' : 'Saved'} <time dateTime={new Date(connection.result.endedAt).toISOString()}>{new Date(connection.result.endedAt).toLocaleString()}</time></p>
          <details className="phone-connection__link"><summary>View full connection link</summary><Textarea aria-label="Phone connection link" rows={3} readOnly value={connection.url} onFocus={event => event.target.select()} /><button type="button" className="small-button" onClick={() => void copy()}><ThemeActionCopyIcon size={14} /> Copy shown link</button></details>
        </> : <>
          <div className="phone-connection__placeholder"><ThemeObjectConnectionCodeIcon size={48} strokeWidth={1.2} aria-hidden="true" /></div>
          <p className="phone-connection__scan">{evaluating || reading.pending || refreshing ? 'Preparing your connection code…' : 'Connection code is not available yet'}</p>
          {!(evaluating || reading.pending || refreshing) ? <button type="button" className="primary-button phone-connection__generate" disabled={!canEvaluate} onClick={() => void refresh()}><ThemeActionRefreshIcon size={15} /> Refresh connection</button> : null}
        </>}
        {notice ? <p className="phone-connection__feedback" role="status">{notice}</p> : null}
        {copyError ? <p className="phone-connection__feedback" role="alert">{copyError}</p> : null}
      </section>
      {displayIssue ? <section className="phone-connection__service" role="status">
        <strong>Current connection details are unavailable</strong><p>{displayIssue}</p>
        {connection ? <p>The saved code and its original time are kept. Refresh to check current details.</p> : null}
        <button type="button" className="small-button" disabled={!canEvaluate} onClick={() => void refresh()}><ThemeActionRefreshIcon size={13} /> Retry connection</button>
      </section> : null}
      <section className="phone-connection__devices" aria-label="Device status">
        <header><h3>Devices</h3><button type="button" className="performance-icon-button" aria-label="Refresh devices" title="Refresh devices" disabled={!canEvaluate} onClick={() => void refresh()}>{evaluating || refreshing ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionRefreshIcon size={14} />}</button></header>
        {devices ? <><p className="phone-connection__device-summary">{devices.document.summary}<time dateTime={new Date(devices.at).toISOString()}>Checked {new Date(devices.at).toLocaleTimeString()}</time></p>
          {devices.document.items.length ? <ul>{devices.document.items.map((device, index) => <li key={index}><span className="phone-device-avatar"><ThemeObjectPhoneIcon size={15} aria-hidden="true" /><DevicePresence online={true} /></span><span>{device.label}</span><small>{device.value}</small></li>)}</ul> : <p className="phone-connection__hint">Your phone appears here while connected.</p>}
          {devices.document.notice ? <details className="phone-connection__device-details"><summary>Connection information</summary><p>{devices.document.notice}</p></details> : null}
        </> : <p className="phone-connection__hint">{evaluating || reading.pending ? 'Checking connected devices…' : 'Refresh to check your connected devices.'}</p>}
      </section>
      {oldUnknown || oldRunning || snapshot?.state === 'failed' ? <details className="phone-connection__service phone-connection__previous" data-toolkit-previous-request>
        <summary>{oldUnknown ? admission?.action?.id === 'link' ? 'Previous link request is unconfirmed' : 'Previous request is unconfirmed' : oldRunning ? 'Previous request is still in progress' : 'Previous request failed'}</summary>
        <p>This earlier request has its own execution record. Checking the current connection does not confirm or replace it.</p>
        {snapshot?.reason ? <p>{snapshot.reason}</p> : null}
        {previousError ? <p role="alert">{previousError}</p> : null}
        {admission ? <p>Execution · {admission.executionId}</p> : null}
        {oldUnknown && admission?.run === null ? <><p>{CONTINUE_TOOLKIT_NOTICE}</p><button type="button" className="small-button" disabled={continuing} onClick={() => void continueOriginal()}><ThemeActionRefreshIcon size={13} />{continuing ? 'Continuing…' : 'Continue original request'}</button></> : null}
        <button type="button" className="small-button" disabled={reading.pending} onClick={() => void reading.check()}><ThemeActionRefreshIcon size={13} /> Check previous request</button>
      </details> : null}
    </div>
    <footer className="performance-actions phone-connection__footer"><button type="button" className="phone-connection__settings" data-phone-settings onClick={() => { close(); navigation?.open('mobile') }}><ThemeObjectPhoneIcon size={14} /> Phone settings</button><button type="button" aria-label="Phone connection settings" title="Phone connection settings" onClick={() => { close(); navigation?.openToolkit(MOBILE_CONNECTION_TOOL_ID) }}><ThemeObjectSettingsIcon size={14} /></button></footer>
  </>
}
