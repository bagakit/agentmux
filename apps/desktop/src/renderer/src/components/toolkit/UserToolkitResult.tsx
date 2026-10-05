import { Textarea } from '@agentmux/client-ui/input'
import { ArrowLeft, Code2, Play, RefreshCw, Settings2, Square, X } from 'lucide-react'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ToolkitAction, ToolkitConfirmedResult } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitIcon } from './ToolkitIcon'
import type { ToolkitToolIdentity } from './use-toolkit-packages'
import { ToolkitResultLink } from './ToolkitResultLink'
import { toolkitResultDocument } from './toolkit-result-document'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'

const stateLabel = { idle: 'Not run yet', disabled: 'Hidden · new runs disabled', pending: 'Starting saved version', running: 'Running saved version', stopping: 'Stopping this execution', unknown: 'Execution unconfirmed', succeeded: 'Finished', failed: 'Failed', stopped: 'Stopped' } as const
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
  const reading = useToolkitScriptObservation(api.toolkit, definition.id, active && !scriptOpen)
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
    const link = toolkitResultDocument(result.text)?.links[0]
    if (link) void api.ui.writeClipboardText(link.url).then(() => setCopyNotice('Link copied. Open it in your phone browser.'), () => setCopyNotice('Link ready. Use Copy link below.')).finally(() => setConnecting(false))
    else { setConnecting(false); setOperationError('The tool finished without a connection link.') }
  }, [snapshot?.latestConfirmed])
  const execution = snapshot?.admission ?? snapshot?.latestConfirmed
  const unknown = reading.error || snapshot?.state === 'unknown'
  const changed = execution && snapshot && execution.definition.revision !== snapshot.definition.revision
  const canRun = snapshot && !snapshot.admission && !unknown && !reading.sourceReason && !reading.pending && definition.enabled && snapshot.definition.enabled
  const canStop = snapshot?.admission?.run !== null && snapshot?.admission !== null && snapshot?.admission !== undefined
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
  const capturedScript = execution?.action ? capturedAction?.script : capturedDefinition?.script
  const capturedArgs = execution?.action ? capturedAction?.args : capturedDefinition?.args
  const source = snapshot?.latestConfirmed
  const document = execution?.text ? toolkitResultDocument(execution.text) : null
  return <>
    <header className="performance-header"><div className="performance-title"><ToolkitIcon icon={icon} size={17} /><div className="toolkit-result__identity"><small>{official ? 'Official toolkit' : 'Custom tool'}</small><h2>{name}</h2></div></div><button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><X size={14} /></button></header>
    <div className="performance-observation"><span className="performance-status" data-state={unknown ? 'unknown' : snapshot?.state ?? 'idle'}><i />{reading.error ? 'Result unconfirmed' : reading.pending && !snapshot ? 'Reading result…' : snapshot ? stateLabel[snapshot.state] : 'Result not loaded'}</span>
      {execution ? <time dateTime={new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toISOString()}>{new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toLocaleTimeString()}</time> : null}
    </div>
    <div className="performance-body toolkit-result">
      {scriptOpen ? <><button type="button" className="small-button" onClick={() => setScriptOpen(false)}><ArrowLeft size={13} /> Back to result</button><p className="settings-hint">{execution ? `Captured ${execution.action ? 'action' : 'entry'} script for this execution. ${capturedDefinition?.package ? 'Local package files are captured; external files and the environment remain live.' : 'Imports, local files and environment are not frozen.'}` : 'Current entry script · read only'}</p><Textarea className="toolkit-result__script" aria-label="Read-only toolkit script" value={capturedScript ?? ''} readOnly /><p className="settings-hint">Arguments · {capturedArgs?.length ? JSON.stringify(capturedArgs) : 'None'}</p></> : <>
        {reading.error ? <p className="toolkit-result__notice" role="status">{reading.error} The last confirmed facts are kept. Check status before starting again.</p> : null}
        {reading.sourceReason ? <p className="toolkit-result__notice" role="status">Package source unavailable: {reading.sourceReason} The retained execution can still be stopped.</p> : null}
        {snapshot?.reason ? <p className="toolkit-result__notice" role="status">{snapshot.reason}</p> : null}
        {changed ? <p className="toolkit-result__notice" role="status">Configuration changed since this execution. Its captured script and directory remain available.</p> : null}
        {execution?.action ? <p className="toolkit-result__origin">Action · {capturedAction?.label ?? 'Captured action unavailable'}</p> : null}
        {document ? <section className="toolkit-result__document"><h3>{document.summary}</h3>{document.notice && <p className="settings-hint">{document.notice}</p>}<dl>{document.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>{document.links.map((link, index) => <ToolkitResultLink key={index} label={link.label} url={link.url} disabled={Boolean(copyOnRun && primaryActionId && (!canRun || busy || connecting))} copy={url => { if (copyOnRun && primaryActionId) { void primary(); return } setOperationError(''); setCopyNotice(''); void api.ui.writeClipboardText(url).then(() => setCopyNotice('Link copied.'), cause => setOperationError(presentError(cause))) }} />)}</section> : execution?.text ? <Output executionId={execution.executionId} text={execution.text} /> : <p className="toolkit-result__empty">{snapshot?.state === 'succeeded' ? 'Finished · No output' : snapshot?.admission ? 'No confirmed terminal text yet.' : official ? 'Generate a link, then open it on your phone. Connect both devices to the same Wi-Fi.' : 'Run your saved script when you choose. Hovering only reads its result.'}</p>}
        {source?.definition.actions?.some(action => action.id !== primaryActionId) ? <section className="toolkit-result__configured-actions" aria-label="Actions for the confirmed result"><header><span>Result actions</span><small>Saved with this result</small></header><div>{source.definition.actions.filter(action => action.id !== primaryActionId).map(action => <button type="button" className="small-button" key={action.id} data-toolkit-action={action.id} disabled={!canRun || busy || connecting} onClick={() => void runAction(action, source)}><Play size={12} /><span>{action.label}</span></button>)}</div></section> : null}
        {execution ? <details className="toolkit-result__details"><summary>Execution details</summary><dl><dt>Directory</dt><ExecutionDirectory path={execution.target.workspacePath} hostId={execution.run?.hostId ?? 'local'} /><dt>Execution</dt><dd>{execution.executionId}</dd><dt>Configuration</dt><dd>{execution.definition.revision}</dd><dt>Started</dt><dd>{new Date(execution.startedAt).toLocaleString()}</dd>{'endedAt' in execution ? <><dt>Ended</dt><dd>{new Date(execution.endedAt).toLocaleString()}</dd><dt>Exit code</dt><dd>{execution.exitCode ?? 'Unconfirmed'}</dd></> : null}<dt>Output</dt><dd>Bounded terminal text · combined stream</dd></dl></details> : null}
        {snapshot?.admission && snapshot.latestConfirmed ? <details className="toolkit-result__details"><summary>Previous confirmed result</summary><p>{new Date(snapshot.latestConfirmed.endedAt).toLocaleString()} · {stateLabel[snapshot.latestConfirmed.state]}</p><Output executionId={snapshot.latestConfirmed.executionId} text={snapshot.latestConfirmed.text} /></details> : null}
      </>}
      {copyNotice ? <p className="settings-hint" role="status">{copyNotice}</p> : null}
      {operationError ? <p className="toolkit-result__notice" role="alert">{operationError}</p> : null}
    </div>
    <footer className="performance-actions toolkit-result__actions">
      <button type="button" className="small-button" disabled={!canRun || busy || connecting} onClick={() => void primary()}>{connecting ? <RefreshCw size={13} className="toolkit-result__spinner" /> : <Play size={13} />} {connecting ? 'Generating & copying…' : runLabel ?? 'Run saved tool'}</button>
      {primaryActionId ? <button type="button" className="small-button" disabled={!canRun || busy || connecting} onClick={() => void operate('run')}><RefreshCw size={13} /> {entryLabel ?? 'Run saved tool'}</button> : null}
      {snapshot?.admission ? <button type="button" className="small-button" disabled={!canStop || busy} onClick={() => void operate('stop')}><Square size={12} /> Stop</button> : null}
      {unknown || reading.sourceReason ? <button type="button" className="small-button" disabled={reading.pending || busy} onClick={() => void reading.check()}><RefreshCw size={13} /> Check status</button> : null}
      {capturedScript && !scriptOpen ? <button type="button" className="small-button" onClick={() => setScriptOpen(true)}><Code2 size={13} /> Script</button> : null}
      <button type="button" className="small-button" onClick={() => { close(); navigation.openToolkit(definition.id) }}><Settings2 size={13} /> Configure</button>
    </footer>
  </>
}
