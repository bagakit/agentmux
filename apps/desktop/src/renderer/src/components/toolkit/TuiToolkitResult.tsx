import { mintObjectId } from '@agentmux/core/object-id'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { SessionControl, SessionSnapshot } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { TerminalView } from '../TerminalView'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitIcon } from './ToolkitIcon'
import { ToolkitActions } from './ToolkitActions'
import { ToolkitPopoverResizeHandle } from '../performance/ToolkitPopoverResizeHandle'
import type { ToolkitToolIdentity } from './use-toolkit-packages'
import { useToolkitScriptObservation } from './use-toolkit-script-observation'
import { continueToolkitRequest, CONTINUE_TOOLKIT_NOTICE } from './continue-toolkit-request'
import '../../styles/toolkit-tui.css'

const CloseIcon = semanticIconComponent('action.close')
const StartIcon = semanticIconComponent('action.start')
const StopIcon = semanticIconComponent('action.stop')
const RefreshIcon = semanticIconComponent('action.refresh')
const SettingsIcon = semanticIconComponent('object.settings')
const stateLabel = { idle: 'Ready to start', disabled: 'Hidden · new runs disabled', pending: 'Starting terminal', running: 'Running', stopping: 'Stopping', unknown: 'Status unconfirmed', succeeded: 'Finished', failed: 'Failed', stopped: 'Stopped' } as const

type Reading = ReturnType<typeof useToolkitScriptObservation>

/** Settings remains a reachable control surface when the status bar entry is hidden. */
export function TuiToolkitSettings({ definition, active }: { definition: ToolkitToolIdentity; active: boolean }) {
  const reading = useToolkitScriptObservation(api.toolkit, definition.id, active)
  const execution = reading.snapshot?.admission ?? reading.snapshot?.latestConfirmed
  const mode = execution ? execution.definition.mode ?? 'script' : reading.snapshot?.definition.mode ?? definition.mode
  return mode === 'tui' ? <TuiToolkitResult definition={definition} reading={reading} active={active} compact /> : null
}

/** Toolkit owns the binding; the existing terminal owns every byte, input and attachment. */
export function TuiToolkitResult({ definition, reading, active, close, compact = false }: {
  definition: ToolkitToolIdentity; reading: Reading; active: boolean; close?(): void; compact?: boolean
}) {
  const { snapshot } = reading
  const execution = snapshot?.admission ?? snapshot?.latestConfirmed
  const run = execution?.run
  const name = snapshot?.definition.name ?? definition.name
  const icon = snapshot?.definition.icon ?? definition.icon
  const navigation = useContext(SettingsNavigation)
  const themeId = useAppStore(state => state.config?.appearance.terminalTheme ?? 'workspace')
  const fontSize = useAppStore(state => state.config?.appearance.terminalFontSize)
  const workspaceId = useAppStore(state => state.config?.workspaces.find(workspace => workspace.hostId === run?.hostId && workspace.path === execution?.target.workspacePath)?.id)
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [terminalError, setTerminalError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [busy, setBusy] = useState(false)
  const refreshGeneration = useRef(0)
  const checkLifetime = useRef(0)
  useEffect(() => () => { ++checkLifetime.current }, [])
  const currentRun = useRef(run)
  const terminalRefresh = useRef<(() => Promise<void>) | null>(null)
  const observeTerminalRefresh = useCallback((refresh: (() => Promise<void>) | null) => { terminalRefresh.current = refresh }, [])
  currentRun.current = run
  const refreshSession = useCallback(async (control: SessionControl) => {
    const generation = ++refreshGeneration.current
    const current = () => generation === refreshGeneration.current && currentRun.current?.hostId === control.hostId && currentRun.current.runId === control.run.runId
    try {
      const fresh = await api.sessions.refresh(control)
      if (current() && fresh.control.hostId === control.hostId && fresh.control.run.runId === control.run.runId) {
        setSession(fresh); setTerminalError('')
      }
      return fresh
    } catch (cause) {
      if (current()) setTerminalError(presentError(cause))
      throw cause
    }
  }, [])
  useEffect(() => {
    if (!active || compact || !run) return
    // The shared refresh records the current failure; superseded reads cannot replace it.
    void refreshSession({ kind: 'terminal', hostId: run.hostId, runId: run.runId, run: { runId: run.runId } }).catch(() => {})
    return () => { ++refreshGeneration.current }
  }, [active, compact, run?.hostId, run?.runId, snapshot?.state, refreshSession])
  const terminal = session && session.control.hostId === run?.hostId && session.control.run.runId === run.runId ? session : null
  const canStart = snapshot && !snapshot.admission && snapshot.state !== 'unknown' && snapshot.definition.enabled
  const changed = execution && snapshot && execution.definition.revision !== snapshot.definition.revision
  async function operate(operation: 'start' | 'stop' | 'continue') {
    if (!snapshot || busy) return
    setBusy(true); setOperationError('')
    try {
      if (operation === 'stop' && snapshot.admission?.run) await api.toolkit.stop(definition.id, snapshot.admission.executionId)
      else if (operation === 'continue' && snapshot.admission) await continueToolkitRequest(api.toolkit, definition.id, snapshot.admission)
      else if (operation === 'start' && canStart) await api.toolkit.run(definition.id, { invocationId: mintObjectId(), expectedRevision: snapshot.definition.revision, expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null })
      await reading.check()
    } catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function check() {
    const lifetime = checkLifetime.current
    await reading.check()
    if (lifetime !== checkLifetime.current) return
    // A check belongs to its captured Run, even if reading the tool changed its execution.
    if (run && !compact && currentRun.current?.hostId === run.hostId && currentRun.current.runId === run.runId) try {
      if (terminalRefresh.current) await terminalRefresh.current()
      else await refreshSession({ kind: 'terminal', hostId: run.hostId, runId: run.runId, run: { runId: run.runId } })
    }
    catch { /* The latest refresh already owns its visible error. */ }
  }
  const status = reading.error ? 'Observation unavailable' : snapshot ? stateLabel[snapshot.state] : 'Reading terminal status…'
  const mainAction = !snapshot?.admission ? <button type="button" disabled={!canStart || busy} title={snapshot?.latestConfirmed ? 'Run saved command' : 'Start'} aria-label={snapshot?.latestConfirmed ? 'Run saved command' : 'Start'} onClick={() => void operate('start')}><StartIcon size={13} /><span className="toolkit-tui__action-label">{snapshot?.latestConfirmed ? 'Run saved command' : 'Start'}</span></button> : snapshot.admission.run ? <button type="button" disabled={busy} title="Stop command" aria-label="Stop command" onClick={() => void operate('stop')}><StopIcon size={13} /><span className="toolkit-tui__action-label">Stop</span></button> : snapshot.state === 'unknown' ? <button type="button" disabled={busy} title="Continue original request" aria-label="Continue original request" onClick={() => void operate('continue')}><StartIcon size={13} /><span className="toolkit-tui__action-label">Continue original request</span></button> : null
  const checkAction = <button type="button" disabled={reading.pending || busy} title="Check status" aria-label="Check status" onClick={() => void check()}><RefreshIcon size={13} /><span className="toolkit-tui__action-label">Check status</span></button>
  const actions = <>{mainAction}{checkAction}{!compact && navigation ? <button type="button" title="Configure" aria-label="Configure" onClick={() => { close?.(); navigation.openToolkit(definition.id) }}><SettingsIcon size={13} /><span className="toolkit-tui__action-label">Configure</span></button> : null}</>
  return <section className={compact ? 'toolkit-tui toolkit-tui--compact' : 'toolkit-tui'} aria-label={compact ? 'TUI execution' : undefined}>
    {!compact ? <><ToolkitPopoverResizeHandle /><header className="toolkit-tui__header">
      <ToolkitIcon icon={icon} size={17} />
      <div className="toolkit-tui__identity"><h2 title={name}>{name}</h2>{terminal && snapshot?.state === 'running' ? <small className="toolkit-tui__hint">Click terminal to type</small> : null}</div>
      <span className="toolkit-tui__state" data-state={reading.error ? 'unknown' : snapshot?.state} role="status" title="Command status · Closing this panel does not stop the command">{status}</span>
      <div className="toolkit-tui__controls">{actions}<button type="button" title="Close panel" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><CloseIcon size={14} /></button></div>
    </header></> : <div className="toolkit-tui__status" role="status">{status}</div>}
    {reading.error || reading.sourceReason || snapshot?.reason || terminalError || operationError || changed ? <div className="toolkit-tui__notices" role="status">
      {reading.error ? <p>{reading.error} The original terminal is kept.</p> : null}
      {reading.sourceReason ? <p>{reading.sourceReason}</p> : null}
      {snapshot?.reason ? <p>{snapshot.reason}</p> : null}
      {terminalError ? <p>Terminal observation: {terminalError} Check status to reconnect.</p> : null}
      {operationError ? <p>{operationError}</p> : null}
      {changed ? <p>Configuration changed. This terminal keeps its captured command and directory.</p> : null}
    </div> : null}
    {!compact ? <div className="toolkit-tui__terminal" data-toolkit-terminal>
      {terminal ? <TerminalView session={terminal} themeId={themeId} {...(fontSize ? { fontSize } : {})} interactiveResize={false} visible={active} autoFocus={false} {...(workspaceId ? { linkOrigin: { workspaceId } } : {})} onRefreshSession={refreshSession} onObservationRefresh={observeTerminalRefresh} /> : <p className="toolkit-tui__empty">{run ? 'Connecting to the original terminal…' : snapshot?.admission ? 'Waiting for the original launch receipt…' : 'Start the saved command to open its terminal.'}</p>}
    </div> : null}
    {snapshot?.state === 'unknown' && snapshot.admission?.run === null ? <p className="toolkit-tui__notice">{CONTINUE_TOOLKIT_NOTICE}</p> : null}
    {compact ? <ToolkitActions primary={mainAction ?? checkAction}>{mainAction ? checkAction : null}</ToolkitActions> : null}
  </section>
}
