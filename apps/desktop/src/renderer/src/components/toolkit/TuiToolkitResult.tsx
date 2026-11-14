import { mintObjectId } from '@agentmux/core/object-id'
import { Button } from '@agentmux/client-ui/components/Button'
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
import { continueToolkitRequest } from './continue-toolkit-request'

const CloseIcon = semanticIconComponent('action.close')
const StartIcon = semanticIconComponent('action.start')
const StopIcon = semanticIconComponent('action.stop')
const RefreshIcon = semanticIconComponent('action.refresh')
const SettingsIcon = semanticIconComponent('object.settings')
const stateLabel = { idle: 'Ready to start', disabled: 'Hidden · new runs disabled', pending: 'Starting terminal', running: 'Running', stopping: 'Stopping', unknown: 'Status unconfirmed', succeeded: 'Finished', failed: 'Failed', stopped: 'Stopped' } as const
const recoveryDescription = {
  'not-observed': 'AgentMux could not confirm a terminal. Check its status or continue the original request.',
  dispatched: 'AgentMux could not confirm a terminal. Ending the pending launch lets you start again once confirmed. If the original terminal is found, it will open here.',
  'retirement-unconfirmed': 'Ending this launch still needs confirmation. Check its status to see whether you can start again.',
  'retirement-unavailable': 'AgentMux could not safely end this launch. The original command may already have run. You can keep its result unconfirmed and allow a new launch.'
}

type Reading = ReturnType<typeof useToolkitScriptObservation>
type ToolkitOperation = 'start' | 'stop' | 'continue' | 'end' | 'release'

/** Settings remains a reachable control surface when the status bar entry is hidden. */
export function TuiToolkitSettings({ definition, active }: { definition: ToolkitToolIdentity; active: boolean }) {
  const reading = useToolkitScriptObservation(api.toolkit, definition.id, active)
  const execution = reading.snapshot?.admission ?? reading.snapshot?.releasedLaunch ?? reading.snapshot?.latestConfirmed
  const mode = execution ? execution.definition.mode ?? 'script' : reading.snapshot?.definition.mode ?? definition.mode
  return mode === 'tui' ? <TuiToolkitResult definition={definition} reading={reading} active={active} compact /> : null
}

/** Toolkit owns the binding; the existing terminal owns every byte, input and attachment. */
export function TuiToolkitResult({ definition, reading, active, close, compact = false }: {
  definition: ToolkitToolIdentity; reading: Reading; active: boolean; close?(): void; compact?: boolean
}) {
  const { snapshot } = reading
  const execution = snapshot?.admission ?? snapshot?.releasedLaunch ?? snapshot?.latestConfirmed
  const run = execution?.run
  const name = snapshot?.definition.name ?? definition.name
  const icon = snapshot?.definition.icon ?? definition.icon
  const navigation = useContext(SettingsNavigation)
  const themeId = useAppStore(state => state.toolkitPresentation[definition.id]?.theme ?? state.config?.appearance.terminalTheme ?? 'workspace')
  const fontSize = useAppStore(state => state.config?.appearance.terminalFontSize)
  const workspaceId = useAppStore(state => state.config?.workspaces.find(workspace => workspace.hostId === run?.hostId && workspace.path === execution?.target.workspacePath)?.id)
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [terminalError, setTerminalError] = useState('')
  const [operationError, setOperationError] = useState<{ operation: ToolkitOperation; detail: string } | null>(null)
  const [busy, setBusy] = useState<ToolkitOperation | null>(null)
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
  const unconfirmedLaunch = snapshot?.state === 'unknown' && snapshot.admission?.run === null ? snapshot.admission : null
  const retirementUnconfirmed = snapshot?.pendingLaunch === 'retirement-unconfirmed'
  const retirementUnavailable = snapshot?.pendingLaunch === 'retirement-unavailable'
  const canContinue = snapshot?.pendingLaunch === undefined || snapshot.pendingLaunch === 'not-observed'
  const canEnd = snapshot?.pendingLaunch === undefined || snapshot.pendingLaunch === 'dispatched'
  const showEmptyStart = !compact && !run && canStart
  const changed = execution && snapshot && execution.definition.revision !== snapshot.definition.revision
  async function operate(operation: ToolkitOperation) {
    if (!snapshot || busy) return
    setBusy(operation); setOperationError(null)
    try {
      if (operation === 'stop' && snapshot.admission?.run) await api.toolkit.stop(definition.id, snapshot.admission.executionId)
      else if (operation === 'end' && unconfirmedLaunch && canEnd) await api.toolkit.stop(definition.id, unconfirmedLaunch.executionId, { cancelPendingLaunch: true })
      else if (operation === 'release' && unconfirmedLaunch && retirementUnavailable) await api.toolkit.stop(definition.id, unconfirmedLaunch.executionId, { releasePendingLaunch: true })
      else if (operation === 'continue' && unconfirmedLaunch && canContinue) await continueToolkitRequest(api.toolkit, definition.id, unconfirmedLaunch)
      else if (operation === 'start' && canStart) await api.toolkit.run(definition.id, { invocationId: mintObjectId(), expectedRevision: snapshot.definition.revision,
        expectedLatestExecutionId: snapshot.releasedLaunch?.executionId ?? snapshot.latestConfirmed?.executionId ?? null })
      await reading.check()
    } catch (cause) { setOperationError({ operation, detail: presentError(cause) }) }
    finally { setBusy(null) }
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
  const endUnconfirmed = retirementUnconfirmed || !!unconfirmedLaunch && canEnd && operationError?.operation === 'end'
  const status = reading.error ? 'Observation unavailable' : endUnconfirmed ? 'End unconfirmed' : unconfirmedLaunch ? 'Launch unconfirmed' : snapshot ? stateLabel[snapshot.state] : 'Reading terminal status…'
  const startLabel = snapshot?.releasedLaunch || snapshot?.latestConfirmed ? 'Run saved command' : 'Start'
  const mainAction = !snapshot?.admission ? <button type="button" disabled={!canStart || busy !== null} title={startLabel} aria-label={startLabel} onClick={() => void operate('start')}><StartIcon size={13} /><span className="toolkit-tui__action-label">{startLabel}</span></button> : snapshot.admission.run ? <button type="button" disabled={busy !== null} title="Stop command" aria-label="Stop command" onClick={() => void operate('stop')}><StopIcon size={13} /><span className="toolkit-tui__action-label">Stop</span></button> : null
  const checkAction = <button type="button" disabled={reading.pending || busy !== null} title="Check status" aria-label="Check status" onClick={() => void check()}><RefreshIcon size={13} /><span className="toolkit-tui__action-label">Check status</span></button>
  const launchDetails = [...new Set([snapshot?.reason, operationError?.detail].filter(Boolean))]
  const launchDescription = endUnconfirmed && canEnd
    ? 'Could not confirm that the original launch ended. Check its status or try ending it again.'
    : recoveryDescription[snapshot?.pendingLaunch ?? 'dispatched']
  const recovery = unconfirmedLaunch ? <div className="toolkit-tui__recovery">
    <p>{launchDescription}</p>
    <div className="toolkit-tui__recovery-actions">
      <Button disabled={reading.pending || busy !== null} onClick={() => void check()}>{reading.pending ? 'Checking launch status…' : 'Check launch status'}</Button>
      {canEnd ? <Button disabled={busy !== null} onClick={() => void operate('end')}>{busy === 'end' ? 'Ending pending launch…' : 'End pending launch'}</Button> : null}
      {retirementUnavailable ? <Button disabled={busy !== null} onClick={() => void operate('release')}>{busy === 'release' ? 'Saving launch decision…' : 'Allow a new launch'}</Button> : null}
      {canContinue ? <Button disabled={busy !== null} onClick={() => void operate('continue')}>{busy === 'continue' ? 'Continuing…' : 'Continue original request'}</Button> : null}
    </div>
    {launchDetails.length ? <details className="toolkit-tui__recovery-details"><summary>Launch details</summary>{launchDetails.map(detail => <p key={detail}>{detail}</p>)}</details> : null}
  </div> : null
  const releasedNotice = snapshot?.releasedLaunch ? <p>The previous launch result is still unconfirmed. The command may already have run.</p> : null
  const currentReason = unconfirmedLaunch || snapshot?.releasedLaunch ? null : snapshot?.reason
  const currentOperationError = unconfirmedLaunch ? null : operationError?.detail
  return <section className={compact ? 'toolkit-tui toolkit-tui--compact' : 'toolkit-tui'} aria-label={compact ? 'TUI execution' : undefined}>
    {!compact ? <><ToolkitPopoverResizeHandle toolId={definition.id} /><header className="toolkit-tui__header">
      <ToolkitIcon icon={icon} size={17} />
      <div className="toolkit-tui__identity"><h2 title={name}>{name}</h2>{terminal && snapshot?.state === 'running' ? <small className="toolkit-tui__hint">Click terminal to type</small> : null}</div>
      <span className="toolkit-tui__state" data-state={reading.error ? 'unknown' : snapshot?.state} role="status" title="Command status · Closing this panel does not stop the command">{status}</span>
      <div className="toolkit-tui__controls">{showEmptyStart ? null : mainAction}{unconfirmedLaunch ? null : checkAction}{navigation ? <button type="button" title="Configure" aria-label="Configure" onClick={() => { close?.(); navigation.openToolkit(definition.id) }}><SettingsIcon size={13} /></button> : null}<button type="button" title="Close panel" data-toolkit-close aria-label={`Close ${name}`} onClick={close}><CloseIcon size={14} /></button></div>
    </header></> : <div className="toolkit-tui__status" role="status">{status}</div>}
    {reading.error || reading.sourceReason || currentReason || terminalError || currentOperationError || changed ? <div className="toolkit-tui__notices" role="status">
      {reading.error ? <p>{reading.error}{run ? ' The original terminal is kept.' : ''}</p> : null}
      {reading.sourceReason ? <p>{reading.sourceReason}</p> : null}
      {currentReason ? <p>{currentReason}</p> : null}
      {terminalError ? <p>Terminal observation: {terminalError} Check status to reconnect.</p> : null}
      {currentOperationError ? <p>{currentOperationError}</p> : null}
      {changed ? <p>Configuration changed. This terminal keeps its captured command and directory.</p> : null}
    </div> : null}
    {!compact ? <div className="toolkit-tui__terminal" data-toolkit-terminal>
      {terminal ? <TerminalView session={terminal} themeId={themeId} {...(fontSize ? { fontSize } : {})} interactiveResize={false} visible={active} autoFocus={false} {...(workspaceId ? { linkOrigin: { workspaceId } } : {})} onRefreshSession={refreshSession} onObservationRefresh={observeTerminalRefresh} /> : recovery ?? (
        showEmptyStart || releasedNotice ? <div className="toolkit-tui__recovery">{releasedNotice}{showEmptyStart ? <Button variant="primary" disabled={busy !== null} onClick={() => void operate('start')}><StartIcon size={13} />{startLabel}</Button> : null}</div>
          : <p className="toolkit-tui__empty">{run ? 'Connecting to the original terminal…' : snapshot?.admission ? 'Starting terminal…' : snapshot ? 'Start the saved command to open its terminal.' : null}</p>
      )}
    </div> : null}
    {compact ? recovery ?? <>{releasedNotice ? <div className="toolkit-tui__recovery">{releasedNotice}</div> : null}<ToolkitActions primary={mainAction ?? checkAction}>{mainAction ? checkAction : null}</ToolkitActions></> : null}
  </section>
}
