import { ArrowLeft, Code2, Play, RefreshCw, Settings2, Square, X } from 'lucide-react'
import { useContext, useLayoutEffect, useRef, useState } from 'react'
import type { ToolkitAction, ToolkitConfirmedResult, ToolkitToolDefinition } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitIcon } from './ToolkitIcon'
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

export function UserToolkitResult({ definition, active, close }: { definition: ToolkitToolDefinition; active: boolean; close(): void }) {
  const [scriptOpen, setScriptOpen] = useState(false)
  const reading = useToolkitScriptObservation(api.toolkit, definition.id, active && !scriptOpen)
  const { snapshot } = reading
  const navigation = useContext(SettingsNavigation)!
  const [operationError, setOperationError] = useState('')
  const [busy, setBusy] = useState(false)
  const execution = snapshot?.admission ?? snapshot?.latestConfirmed
  const unknown = reading.error || snapshot?.state === 'unknown'
  const changed = execution && execution.definition.revision !== definition.revision
  const canRun = snapshot && !snapshot.admission && !unknown && !reading.pending && definition.enabled
  const canStop = snapshot?.admission?.run !== null && snapshot?.admission !== null && snapshot?.admission !== undefined
  async function operate(operation: 'run' | 'stop') {
    if (!snapshot || busy) return
    setBusy(true); setOperationError('')
    try {
      if (operation === 'stop') {
        const captured = snapshot.admission
        if (!captured?.run) return
        await api.toolkit.stop(definition.id, captured.executionId)
      } else {
        if (!canRun) return
        await api.toolkit.run(definition.id, { invocationId: crypto.randomUUID(), expectedRevision: definition.revision, expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null })
      }
      await reading.check()
    } catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function runAction(action: ToolkitAction, source: ToolkitConfirmedResult) {
    if (!snapshot || !canRun || busy) return
    const expectedAdmissionExecutionId = snapshot.admission?.executionId ?? null
    setBusy(true); setOperationError('')
    try {
      await api.toolkit.action(definition.id, action.id, { invocationId: crypto.randomUUID(), expectedRevision: source.definition.revision, sourceExecutionId: source.executionId, expectedAdmissionExecutionId })
      await reading.check()
    } catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  const capturedDefinition = execution?.definition ?? snapshot?.definition
  const capturedAction = execution?.action ? capturedDefinition?.actions?.find(item => item.id === execution.action!.id) : undefined
  const capturedScript = execution?.action ? capturedAction?.script : capturedDefinition?.script
  const capturedArgs = execution?.action ? capturedAction?.args : capturedDefinition?.args
  const source = snapshot?.latestConfirmed
  return <>
    <header className="performance-header"><div className="performance-title"><ToolkitIcon icon={definition.icon} size={17} /><h2>{definition.name}</h2></div><button type="button" className="performance-icon-button" data-toolkit-close aria-label={`Close ${definition.name}`} onClick={close}><X size={14} /></button></header>
    <div className="performance-observation"><span className="performance-status" data-state={unknown ? 'unknown' : snapshot?.state ?? 'idle'}><i />{reading.error ? 'Result unconfirmed' : reading.pending && !snapshot ? 'Reading result…' : snapshot ? stateLabel[snapshot.state] : 'Result not loaded'}</span>
      {execution ? <time dateTime={new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toISOString()}>{new Date('endedAt' in execution ? execution.endedAt : execution.startedAt).toLocaleTimeString()}</time> : null}
    </div>
    <div className="performance-body toolkit-result">
      {scriptOpen ? <><button type="button" className="small-button" onClick={() => setScriptOpen(false)}><ArrowLeft size={13} /> Back to result</button><p className="settings-hint">{execution ? `Captured ${execution.action ? 'action' : 'entry'} script for this execution. Imports, local files and environment are not frozen.` : 'Saved script · read only'}</p><textarea className="toolkit-result__script" aria-label="Read-only toolkit script" value={capturedScript ?? ''} readOnly /><p className="settings-hint">Arguments · {capturedArgs?.length ? JSON.stringify(capturedArgs) : 'None'}</p></> : <>
        {reading.error ? <p className="toolkit-result__notice" role="status">{reading.error} The last confirmed facts are kept. Check status before starting again.</p> : null}
        {snapshot?.reason ? <p className="toolkit-result__notice" role="status">{snapshot.reason}</p> : null}
        {changed ? <p className="toolkit-result__notice" role="status">Configuration changed since this execution. Its captured script and directory remain available.</p> : null}
        {execution?.action ? <p className="toolkit-result__origin">Action · {capturedAction?.label ?? 'Captured action unavailable'}</p> : null}
        {execution?.text ? <Output executionId={execution.executionId} text={execution.text} /> : <p className="toolkit-result__empty">{snapshot?.state === 'succeeded' ? 'Finished · No output' : snapshot?.admission ? 'No confirmed terminal text yet.' : 'Run your saved script when you choose. Hovering only reads its result.'}</p>}
        {source?.definition.actions?.length ? <section className="toolkit-result__configured-actions" aria-label="Actions for the confirmed result"><header><span>Result actions</span><small>Saved with this result</small></header><div>{source.definition.actions.map(action => <button type="button" className="small-button" key={action.id} data-toolkit-action={action.id} disabled={!canRun || busy} onClick={() => void runAction(action, source)}><Play size={12} /><span>{action.label}</span></button>)}</div></section> : null}
        {execution ? <details className="toolkit-result__details"><summary>Execution details</summary><dl><dt>Directory</dt><dd>{execution.target.workspacePath}</dd><dt>Execution</dt><dd>{execution.executionId}</dd><dt>Configuration</dt><dd>{execution.definition.revision}</dd><dt>Started</dt><dd>{new Date(execution.startedAt).toLocaleString()}</dd>{'endedAt' in execution ? <><dt>Ended</dt><dd>{new Date(execution.endedAt).toLocaleString()}</dd><dt>Exit code</dt><dd>{execution.exitCode ?? 'Unconfirmed'}</dd></> : null}<dt>Output</dt><dd>Bounded terminal text · combined stream</dd></dl></details> : null}
        {snapshot?.admission && snapshot.latestConfirmed ? <details className="toolkit-result__details"><summary>Previous confirmed result</summary><p>{new Date(snapshot.latestConfirmed.endedAt).toLocaleString()} · {stateLabel[snapshot.latestConfirmed.state]}</p><Output executionId={snapshot.latestConfirmed.executionId} text={snapshot.latestConfirmed.text} /></details> : null}
      </>}
      {operationError ? <p className="toolkit-result__notice" role="alert">{operationError}</p> : null}
    </div>
    <footer className="performance-actions toolkit-result__actions">
      <button type="button" className="small-button" disabled={!canRun || busy} onClick={() => void operate('run')}><Play size={13} /> Run saved tool</button>
      {snapshot?.admission ? <button type="button" className="small-button" disabled={!canStop || busy} onClick={() => void operate('stop')}><Square size={12} /> Stop</button> : null}
      {unknown ? <button type="button" className="small-button" disabled={reading.pending || busy} onClick={() => void reading.check()}><RefreshCw size={13} /> Check status</button> : null}
      {capturedScript && !scriptOpen ? <button type="button" className="small-button" onClick={() => setScriptOpen(true)}><Code2 size={13} /> Script</button> : null}
      <button type="button" className="small-button" onClick={() => { close(); navigation.openToolkit(definition.id) }}><Settings2 size={13} /> Configure</button>
    </footer>
  </>
}
