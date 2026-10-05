import { Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionStopIcon = semanticIconComponent('action.stop')
const ThemeObjectSourceCodeIcon = semanticIconComponent('object.source-code')
const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseToolkitResultDocument, type ToolkitAction, type ToolkitConfirmedResult } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitIcon } from './ToolkitIcon'
import type { ToolkitToolIdentity } from './use-toolkit-packages'
import { ToolkitResultLink } from './ToolkitResultLink'
import { ToolkitAgentCards } from './ToolkitAgentCards'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'
import { continueToolkitRequest, CONTINUE_TOOLKIT_NOTICE } from './continue-toolkit-request'

const stateLabel = { idle: 'Not run yet', disabled: 'Hidden · new runs disabled', pending: 'Starting saved version', running: 'Running saved version', stopping: 'Stopping this execution', unknown: 'Execution unconfirmed', succeeded: 'Finished', failed: 'Failed', stopped: 'Stopped' } as const
function resultDocument(text: string) {
  try { return parseToolkitResultDocument(JSON.parse(text.trim())) } catch { return null }
}
function Output({ executionId, text }: { executionId: string; text: string }) {
  const pre = useRef<HTMLPreElement>(null)
  const previous = useRef<{ id: string; text: string } | null>(null)
  useLayoutEffect(() => {
    const node = pre.current
    if (!node) return
    const old = previous.current
    // Appending to the same text node preserves an existing Range and reading position.
    if (old?.id === executionId && text.startsWith(old.text) && node.firstChild instanceof Text) node.firstChild.appendData(text.slice(old.text.length))
    else node.replaceChildren(document.createTextNode(text))
    previous.current = { id: executionId, text }
  }, [executionId, text])
  return <pre ref={pre} className="toolkit-result__text" data-toolkit-output aria-label="Terminal output" />
}

function ExecutionDirectory({ path, hostId }: { path: string; hostId: string }) {
  const displayPath = usePathDisplay()
  return <dd>{displayPath(path, hostId)}</dd>
}

export function UserToolkitResult({ definition, active, close, official = false, runLabel, copyOnRun = false, primaryActionId, entryLabel }: { definition: ToolkitToolIdentity; active: boolean; close(): void; official?: boolean; runLabel?: string; copyOnRun?: boolean; primaryActionId?: string; entryLabel?: string }) {
  const [connecting, setConnecting] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const reading = useToolkitScriptObservation(api.toolkit, definition.id, active && !scriptOpen, true)
  const { snapshot } = reading
  const name = snapshot?.definition.name ?? definition.name, icon = snapshot?.definition.icon ?? definition.icon
  const navigation = useContext(SettingsNavigation)!
  const [operationError, setOperationError] = useState('')
  const [busy, setBusy] = useState(false)
  const bootstrap = useRef<{ invocationId: string; actionId: string } | null>(null)
  const copyInvocation = useRef<string | null>(null)
  const [copyNotice, setCopyNotice] = useState('')
  useEffect(() => {
    const result = snapshot?.latestConfirmed
    if (!result || result.invocationId !== copyInvocation.current) return
    copyInvocation.current = null
    if (result.state !== 'succeeded') { setConnecting(false); return }
    const link = resultDocument(result.text)?.links[0]
    if (link) void api.ui.writeClipboardText(link.url).then(() => setCopyNotice('Link copied. Open it in your phone browser.'), () => setCopyNotice('Link ready. Use Copy link below.')).finally(() => setConnecting(false))
    else { setConnecting(false); setOperationError('The tool finished without a connection link.') }
  }, [snapshot?.latestConfirmed])
  const display = snapshot?.display
  const showDisplay = Boolean(snapshot?.definition.display || display)
  const lane = showDisplay ? display : snapshot
  const retainedDisplay = display?.latestConfirmed?.state === 'succeeded' ? display.latestConfirmed : display?.lastSucceeded
  const execution = showDisplay ? retainedDisplay ?? display?.admission ?? display?.latestConfirmed : lane?.admission ?? lane?.latestConfirmed
  const unknown = reading.error || lane?.state === 'unknown'
  const ordinaryUnknown = snapshot?.state === 'unknown'
  const [evaluating, setEvaluating] = useState(false)
  const displayRunning = display?.state === 'pending' || display?.state === 'running' || display?.state === 'stopping'
  const canEvaluate = Boolean((display?.admission || snapshot?.definition.display && snapshot.definition.enabled && !reading.sourceReason) && !displayRunning && !evaluating)
  async function evaluate() {
    if (!canEvaluate) return
    setEvaluating(true); setOperationError('')
    try { await api.toolkit.evaluate(definition.id); await reading.check() }
    catch (cause) { setOperationError(presentError(cause)); await reading.check() }
    finally { setEvaluating(false) }
  }
  const changed = execution && snapshot && execution.definition.revision !== snapshot.definition.revision
  const canRun = snapshot && !snapshot.admission && !ordinaryUnknown && !reading.error && !reading.sourceReason && !reading.pending && definition.enabled && snapshot.definition.enabled
  const canStop = snapshot?.admission?.run !== null && snapshot?.admission !== null && snapshot?.admission !== undefined
  async function continueOriginal() {
    if (!snapshot?.admission || busy) return
    setBusy(true); setOperationError('')
    try { await continueToolkitRequest(api.toolkit, definition.id, snapshot.admission); await reading.check() }
    catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function operate(operation: 'run' | 'stop') {
    if (!snapshot || busy) return
    setBusy(true); setOperationError(''); setCopyNotice('')
    try {
      if (operation === 'stop') {
        const captured = snapshot.admission
        if (!captured?.run) return
        await api.toolkit.stop(definition.id, captured.executionId)
      } else {
        if (!canRun) return
        const invocationId = crypto.randomUUID()
        if (copyOnRun && !primaryActionId) copyInvocation.current = invocationId
        await api.toolkit.run(definition.id, { invocationId, expectedRevision: snapshot.definition.revision, expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null })
      }
      await reading.check()
    } catch (cause) { copyInvocation.current = null; setConnecting(false); setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function runAction(action: ToolkitAction, source: ToolkitConfirmedResult) {
    if (!snapshot || !canRun || busy) return
    const expectedAdmissionExecutionId = snapshot.admission?.executionId ?? null
    setBusy(true); setOperationError(''); setCopyNotice('')
    try {
      await api.toolkit.action(definition.id, action.id, { invocationId: crypto.randomUUID(), expectedRevision: source.definition.revision, sourceExecutionId: source.executionId, expectedAdmissionExecutionId })
      await reading.check()
    } catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const result = snapshot?.latestConfirmed, requested = bootstrap.current
    if (!result || !requested || result.invocationId !== requested.invocationId || snapshot?.admission) return
    bootstrap.current = null
    if (result.state !== 'succeeded') { setConnecting(false); return }
    const action = result.definition.actions?.find(item => item.id === requested.actionId)
    if (!action || snapshot?.admission || result.definition.revision !== snapshot?.definition.revision) {
      setConnecting(false); setOperationError('The tool configuration or result changed. Run it again.'); return
    }
    void invokeAction(action, result, copyOnRun)
  }, [snapshot?.latestConfirmed, snapshot?.admission, snapshot?.definition.revision, copyOnRun])
  async function invokeAction(action: ToolkitAction, source: ToolkitConfirmedResult, copy: boolean) {
    const invocationId = crypto.randomUUID()
    setConnecting(copy)
    if (copy) copyInvocation.current = invocationId
    setBusy(true); setOperationError(''); setCopyNotice('')
    try {
      await api.toolkit.action(definition.id, action.id, { invocationId, expectedRevision: source.definition.revision,
        sourceExecutionId: source.executionId, expectedAdmissionExecutionId: null })
      await reading.check()
    } catch (cause) { copyInvocation.current = null; setConnecting(false); setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function primary() {
    if (!primaryActionId) { await operate('run'); return }
    if (!snapshot || !canRun || busy || connecting) return
    const source = snapshot.latestConfirmed
    const action = source?.definition.revision === snapshot.definition.revision ? source.definition.actions?.find(item => item.id === primaryActionId) : undefined
    if (source && action) { await invokeAction(action, source, copyOnRun); return }
    // The explicit action first queries its declared entry to capture a result identity.
    // No visibility, hover or passive result read reaches this path.
    const invocationId = crypto.randomUUID()
    bootstrap.current = { invocationId, actionId: primaryActionId }
    setConnecting(true)
    setBusy(true); setOperationError(''); setCopyNotice('')
    try {
      await api.toolkit.run(definition.id, { invocationId, expectedRevision: snapshot.definition.revision,
        expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null })
      await reading.check()
    } catch (cause) { bootstrap.current = null; setConnecting(false); setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  const capturedDefinition = execution?.definition ?? snapshot?.definition
  const capturedAction = execution?.action ? capturedDefinition?.actions?.find(item => item.id === execution.action!.id) : undefined
  const capturedScript = showDisplay ? capturedDefinition?.display?.script : execution?.action ? capturedAction?.script : capturedDefinition?.script
  const capturedArgs = showDisplay ? capturedDefinition?.display?.args : execution?.action ? capturedAction?.args : capturedDefinition?.args
  const source = snapshot?.latestConfirmed
  const document = useMemo(() => execution?.text ? resultDocument(execution.text) : null, [execution?.text])
  return <>
    <header className="performance-header"><div className="performance-title"><ToolkitIcon icon={icon} size={17} /><div className="toolkit-result__identity"><small>{official ? 'Official toolkit' : 'Custom tool'}</small><h2>{name}</h2></div></div><button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><ThemeActionCloseIcon size={14} /></button></header>
    <div className="performance-observation"><span className="performance-status" data-state={unknown ? 'unknown' : lane?.state ?? 'idle'}><i />{reading.error ? 'Result unconfirmed' : reading.pending && !snapshot ? 'Reading result…' : lane ? showDisplay && lane.state === 'succeeded' ? 'Display checked' : stateLabel[lane.state] : showDisplay ? 'Preparing display…' : 'Result not loaded'}</span>
      {execution ? <time dateTime={new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toISOString()}>{new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toLocaleTimeString()}</time> : null}
    </div>
    <div className="performance-body toolkit-result">
      {scriptOpen ? <><button type="button" className="small-button" onClick={() => setScriptOpen(false)}><ThemeNavigationBackIcon size={13} /> Back to result</button><p className="settings-hint">{execution ? `Captured ${showDisplay ? 'display' : execution.action ? 'action' : 'entry'} script for this execution. ${capturedDefinition?.package ? 'Local package files are captured; external files and the environment remain live.' : 'Imports, local files and environment are not frozen.'}` : 'Current entry script · read only'}</p><Textarea className="toolkit-result__script" aria-label="Read-only toolkit script" value={capturedScript ?? ''} readOnly /><p className="settings-hint">Arguments · {capturedArgs?.length ? JSON.stringify(capturedArgs) : 'None'}</p></> : <>
        {reading.error ? <p className="toolkit-result__notice" role="status">{reading.error} The last confirmed facts are kept. Check status before starting again.</p> : null}
        {reading.sourceReason ? <p className="toolkit-result__notice" role="status">Package source unavailable: {reading.sourceReason} Captured requests and confirmed results are kept.</p> : null}
        {lane?.reason ? <p className="toolkit-result__notice" role="status">{lane.reason}</p> : null}
        {lane?.state === 'unknown' && lane.admission?.run === null ? <p className="settings-hint">{CONTINUE_TOOLKIT_NOTICE}</p> : null}
        {changed ? <p className="toolkit-result__notice" role="status">Configuration changed since this execution. Its captured script and directory remain available.</p> : null}
        {showDisplay ? <p className="toolkit-result__origin">Evaluated when displayed · Refresh to check again</p> : execution?.action ? <p className="toolkit-result__origin">Action · {capturedAction?.label ?? 'Captured action unavailable'}</p> : null}
        {document ? <section className="toolkit-result__document"><h3>{document.summary}</h3>{document.notice && <p className="settings-hint">{document.notice}</p>}<dl>{document.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>{document.agentCards ? <ToolkitAgentCards cards={document.agentCards} active={active && !scriptOpen} /> : null}{document.links.map((link, index) => <ToolkitResultLink key={index} label={link.label} url={link.url} disabled={Boolean(!showDisplay && copyOnRun && primaryActionId && (!canRun || busy || connecting))} copy={url => { if (!showDisplay && copyOnRun && primaryActionId) { void primary(); return } setOperationError(''); setCopyNotice(''); void api.ui.writeClipboardText(url).then(() => setCopyNotice('Link copied.'), cause => setOperationError(presentError(cause))) }} />)}</section> : execution?.text ? <Output executionId={execution.executionId} text={execution.text} /> : <p className="toolkit-result__empty">{lane?.state === 'succeeded' ? 'Finished · No output' : lane?.admission ? 'No confirmed terminal text yet.' : showDisplay ? 'Preparing the declared display script…' : official ? 'Generate a link, then open it on your phone. Connect both devices to the same Wi-Fi.' : 'Run your saved script when you choose. Hovering only reads its result.'}</p>}
        {source?.definition.actions?.some(action => action.id !== primaryActionId) ? <section className="toolkit-result__configured-actions" aria-label="Actions for the confirmed result"><header><span>Result actions</span><small>Saved with this result</small></header><div>{source.definition.actions.filter(action => action.id !== primaryActionId).map(action => <button type="button" className="small-button" key={action.id} data-toolkit-action={action.id} disabled={!canRun || busy || connecting} onClick={() => void runAction(action, source)}><ThemeActionStartIcon size={12} /><span>{action.label}</span></button>)}</div></section> : null}
        {execution ? <details className="toolkit-result__details"><summary>Execution details</summary><dl><dt>Directory</dt><ExecutionDirectory path={execution.target.workspacePath} hostId={execution.run?.hostId ?? 'local'} /><dt>Execution</dt><dd>{execution.executionId}</dd><dt>Configuration</dt><dd>{execution.definition.revision}</dd><dt>Started</dt><dd>{new Date(execution.startedAt).toLocaleString()}</dd>{'endedAt' in execution ? <><dt>Ended</dt><dd>{new Date(execution.endedAt).toLocaleString()}</dd><dt>Exit code</dt><dd>{execution.exitCode ?? 'Unconfirmed'}</dd></> : null}<dt>Output</dt><dd>Bounded terminal text · combined stream</dd></dl></details> : null}
        {!showDisplay && snapshot?.admission && snapshot.latestConfirmed ? <details className="toolkit-result__details"><summary>Previous confirmed result</summary><p>{new Date(snapshot.latestConfirmed.endedAt).toLocaleString()} · {stateLabel[snapshot.latestConfirmed.state]}</p><Output executionId={snapshot.latestConfirmed.executionId} text={snapshot.latestConfirmed.text} /></details> : null}
      </>}
      {showDisplay && (snapshot?.admission || ordinaryUnknown || snapshot?.state === 'failed') ? <details className="toolkit-result__details toolkit-result__previous" data-toolkit-previous-request>
        <summary>{ordinaryUnknown ? 'Previous request is unconfirmed' : snapshot?.admission ? 'Previous request is in progress' : 'Previous request failed'}</summary>
        <p>This earlier run or action keeps its own record. Display evaluation does not confirm or replace it.</p>
        {snapshot?.reason ? <p className="toolkit-result__notice">{snapshot.reason}</p> : null}
        {snapshot?.admission ? <p>Execution · {snapshot.admission.executionId}</p> : null}
        {ordinaryUnknown && snapshot?.admission?.run === null ? <p className="settings-hint">{CONTINUE_TOOLKIT_NOTICE}</p> : null}
        {snapshot?.latestConfirmed ? <Output executionId={snapshot.latestConfirmed.executionId} text={snapshot.latestConfirmed.text} /> : null}
      </details> : null}
      {copyNotice ? <p className="settings-hint" role="status">{copyNotice}</p> : null}
      {operationError ? <p className="toolkit-result__notice" role="alert">{operationError}</p> : null}
    </div>
    <footer className="performance-actions toolkit-result__actions">
      {showDisplay ? <button type="button" className="small-button" disabled={!canEvaluate} onClick={() => void evaluate()}><ThemeActionRefreshIcon size={13} className={displayRunning || evaluating ? 'toolkit-result__spinner' : undefined} /> {display?.admission ? 'Continue display request' : 'Refresh display'}</button> : null}
      <button type="button" className="small-button" disabled={!canRun || busy || connecting} onClick={() => void primary()}>{connecting ? <ThemeActionRefreshIcon size={13} className="toolkit-result__spinner" /> : <ThemeActionStartIcon size={13} />} {connecting ? 'Generating & copying…' : runLabel ?? 'Run saved tool'}</button>
      {primaryActionId ? <button type="button" className="small-button" disabled={!canRun || busy || connecting} onClick={() => void operate('run')}><ThemeActionRefreshIcon size={13} /> {entryLabel ?? 'Run saved tool'}</button> : null}
      {snapshot?.admission ? <button type="button" className="small-button" disabled={!canStop || busy} onClick={() => void operate('stop')}><ThemeActionStopIcon size={12} /> Stop</button> : null}
      {snapshot?.state === 'unknown' && snapshot.admission?.run === null ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal()}><ThemeActionStartIcon size={13} /> Continue original request</button> : null}
      {unknown || ordinaryUnknown || reading.sourceReason ? <button type="button" className="small-button" disabled={reading.pending || busy} onClick={() => void reading.check()}><ThemeActionRefreshIcon size={13} /> Check status</button> : null}
      {capturedScript && !scriptOpen ? <button type="button" className="small-button" onClick={() => setScriptOpen(true)}><ThemeObjectSourceCodeIcon size={13} /> Script</button> : null}
      <button type="button" className="small-button" onClick={() => { close(); navigation.openToolkit(definition.id) }}><ThemeObjectSettingsIcon size={13} /> Configure</button>
    </footer>
  </>
}
