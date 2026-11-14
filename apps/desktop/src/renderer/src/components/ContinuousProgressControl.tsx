import { mintObjectId } from '@agentmux/core/object-id'
import { Button } from '@agentmux/client-ui/components/Button'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { continuousProgressRequestDigest, isAgentSchedule, type ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ContinuousProgressPanel } from './ContinuousProgressPanel'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { CalendarScheduleControl } from './CalendarScheduleControl'
import { useAppStore } from '../store'
import { resolveAutomationPreferences } from '../../../shared/automation-preferences'
import type { ProgressUpdateRequest, ProgressRequest, OriginalContinuousProgressControl } from '../../../shared/continuous-progress'
import { useLauncherState, checkpointLauncherState, initializeLauncherState } from '../lib/launcher-state'
import { presentError } from '@agentmux/client-ui/error-presentation'

export type ContinuousProgressStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'
function recordedProgressRequest(request: ProgressRequest, loop: ContinuousProgressLoop | undefined): boolean {
  if (!loop || ['hostId', 'agentSessionId', 'providerId', 'workspacePath'].some(key =>
    loop[key as keyof typeof request.input.target] !== request.input.target[key as keyof typeof request.input.target])) return false
  return request.kind === 'create' ? loop.creationOperationId === request.input.operationId && loop.intervalMs === request.input.intervalMs &&
    loop.prompt === request.input.prompt && loop.inputEpoch === request.input.inputEpoch && JSON.stringify(loop.taskSource) === JSON.stringify(request.input.taskSource)
    : loop.loopId === request.input.loopId && loop.lastMutation?.operationId === request.input.operationId && loop.lastMutation.action === request.input.action &&
      loop.lastMutation.expectedRevision === (request.input.expectedLoop.revision ?? 0) && loop.lastMutation.requestDigest === continuousProgressRequestDigest(request.input) && loop.lastMutation.phase === 'settled'
}

/** Read the original Host only for this visible Session consumer; retained forms stay mounted. */
type ContinuousProgressControlProps = {
  targetName?: string | undefined
  onStatusChange?: (status: ContinuousProgressStatus) => void
  /** Only the detail DOM waits for first use; observation and action state stay mounted. */
  presented?: boolean
  /** Visibility controls presentation work without discarding retained forms. */
  visible?: boolean
} & ({ session: Extract<SessionSnapshot, { kind: 'agent' }>; original?: never } | { original: OriginalContinuousProgressControl; session?: never })
export function ContinuousProgressControl({ session, original, targetName, onStatusChange, presented = true, visible = presented }: ContinuousProgressControlProps) {
  const displayPath = usePathDisplay()
  const target = useMemo(() => original?.target ?? { hostId: session!.control.hostId, agentSessionId: session!.control.agentSessionId,
    providerId: session!.providerId, workspacePath: session!.workspacePath },
  [original?.identity, original?.target.hostId, original?.target.agentSessionId, original?.target.providerId, original?.target.workspacePath,
    session?.control.hostId, session?.control.agentSessionId, session?.providerId, session?.workspacePath])
  const progressApi = original?.port ?? api.continuousProgress
  const targetKey = JSON.stringify([target.hostId, target.agentSessionId, target.providerId, target.workspacePath, ...(original ? [original.identity] : [])])
  const draftKey = 'progress-update:' + targetKey
  const pendingRequest = useLauncherState(state => state.drafts[draftKey]?.progressRequest)
  const previousRequests = useLauncherState(state => state.drafts[draftKey]?.unconfirmedProgressRequests)
  const pendingUpdate = useLauncherState(state => state.drafts[draftKey]?.progressUpdate)
  const previousUpdates = useLauncherState(state => state.drafts[draftKey]?.unconfirmedProgressUpdates)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [saveNotice, setSaveNotice] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const editBasis = useRef<ContinuousProgressLoop | undefined>(undefined)
  const editVersion = useRef(0)
  const [initialDefaults] = useState(() => resolveAutomationPreferences(useAppStore.getState().config?.automation))
  const form = useRef({ target, defaults: initialDefaults })
  if (form.current.target !== target) form.current = { target, defaults: resolveAutomationPreferences(useAppStore.getState().config?.automation) }
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
  const [observedTarget, setObservedTarget] = useState<typeof target>()
  const [error, setError] = useState<string>()
  const [observationError, setObservationError] = useState<string>()
  const [actionNotice, setActionNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [calendarStatus, setCalendarStatus] = useState<ContinuousProgressStatus>('unconfirmed')
  const [interval, setInterval] = useState(() => String(initialDefaults.progressIntervalMs / 60_000))
  const [prompt, setPrompt] = useState(initialDefaults.progressPrompt)
  const [bindSource, setBindSource] = useState(false)
  const [sourceRoot, setSourceRoot] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [readerPath, setReaderPath] = useState('')
  const hadLoop = useRef(false), edited = useRef(false), progressFormElement = useRef<HTMLFormElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const requestAction = useRef<HTMLButtonElement>(null)
  const requestFocus = useRef<string | undefined>(undefined)
  const pendingOperationId = pendingRequest?.input.operationId
  useLayoutEffect(() => {
    if (!pendingOperationId || requestFocus.current !== pendingOperationId) return
    requestFocus.current = undefined
    const action = requestAction.current
    if (visible && action && action.ownerDocument.activeElement === action.ownerDocument.body) action.focus()
  }, [pendingOperationId, visible])
  const current = useRef(target); current.current = target
  const updates = useRef(0)
  const reads = useRef(new Map<string, Promise<ContinuousProgressLoop[]>>())
  useEffect(() => {
    updates.current++
    const held = useLauncherState.getState().drafts[draftKey], retained = held?.progressUpdate, draft = held?.progressDraft
    hadLoop.current = false; edited.current = !!(retained || draft); editBasis.current = draft?.expectedLoop ?? retained?.expectedLoop; editVersion.current++
    setLoops([]); setError(undefined); setObservationError(undefined); setActionNotice(undefined); setBusy(false); setSaveNotice(undefined); setConflict(false)
    setPrompt(draft?.prompt ?? retained?.prompt ?? form.current.defaults.progressPrompt); setInterval(draft?.interval ?? String((retained?.intervalMs ?? form.current.defaults.progressIntervalMs) / 60_000)); setBindSource(false); setSourceRoot(''); setSourceId(''); setReaderPath('')
  }, [target])
  useEffect(() => {
    if (!visible) return
    let alive = true, reading = false, reread = false
    const refresh = async () => {
      if (!alive || document.hidden) return
      if (reading) { reread = true; return }
      reading = true
      let readCut = updates.current
      try {
        const pending = reads.current.get(targetKey)
        if (pending) await pending.catch(() => {})
        if (!alive || document.hidden) return
        const before = updates.current, request = progressApi.list(target); readCut = before
        reads.current.set(targetKey, request)
        try {
          const result = await request
          if (alive && !document.hidden && current.current === target && updates.current === before) {
            setLoops(result.filter(loop => !isAgentSchedule(loop))); setObservedTarget(target); setObservationError(undefined)
          }
        } finally { if (reads.current.get(targetKey) === request) reads.current.delete(targetKey) }
      } catch (failure) { if (alive && !document.hidden && updates.current === readCut) setObservationError(failure instanceof Error ? failure.message : String(failure)) }
      finally { reading = false; if (reread) { reread = false; void refresh() } }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    const visibility = () => { void refresh() }
    document.addEventListener('visibilitychange', visibility)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [target, targetKey, visible, progressApi])
  async function run(action: () => Promise<ContinuousProgressLoop>, onFailure?: (error: unknown) => void) {
    if (busy) return
    const captured = target, before = ++updates.current
    setBusy(true); setError(undefined)
    try {
      const result = await action()
      if (current.current === captured && updates.current === before) {
        updates.current++
        setLoops(previous => [...previous.filter(loop => loop.loopId !== result.loopId), result]); setObservedTarget(target)
      }
      if (current.current === captured) setError(undefined)
      return result
    } catch (failure) { onFailure?.(failure); if (current.current === captured) { updates.current++; setError(presentError(failure)) } }
    finally { if (current.current === captured) setBusy(false) }
  }
  const loop = observedTarget === target ? loops.find(loop => loop.status !== 'stopped') : undefined
  const displayed = loop ?? (observedTarget === target ? loops.at(-1) : undefined)
  useEffect(() => {
    if (!loop) return
    // A late observation may provide the target but must not replace an edited draft or IME preview.
    if (!editBasis.current) editBasis.current = loop
    if (edited.current || progressFormElement.current?.contains(document.activeElement)) return
    editBasis.current = loop
    setInterval(String(loop.intervalMs / 60_000)); setPrompt(loop.prompt)
  }, [loop])
  useEffect(() => {
    if (loop) { hadLoop.current = true; return }
    if (observedTarget !== target || !hadLoop.current) return
    hadLoop.current = false
    if (edited.current || progressFormElement.current?.contains(document.activeElement)) return
    const defaults = resolveAutomationPreferences(useAppStore.getState().config?.automation)
    form.current.defaults = defaults
    setInterval(String(defaults.progressIntervalMs / 60_000)); setPrompt(defaults.progressPrompt)
    setBindSource(false); setSourceRoot(''); setSourceId(''); setReaderPath('')
    editBasis.current = undefined
  }, [target, loop?.loopId, observedTarget])
  const status: ContinuousProgressStatus = pendingRequest || previousRequests?.some(request => request.dispatch !== 'prepared') || error || observationError || displayed?.lastOutcome === 'unknown' || observedTarget !== target
    ? 'unconfirmed' : loop?.status === 'active' ? 'active' : loop?.status === 'paused' ? 'paused' : 'inactive'
  const combinedStatus = original ? status : [status, calendarStatus].includes('unconfirmed') ? 'unconfirmed' : [status, calendarStatus].includes('active') ? 'active' : [status, calendarStatus].includes('paused') ? 'paused' : 'inactive'
  useEffect(() => { onStatusChange?.(combinedStatus) }, [onStatusChange, combinedStatus])
  async function performRequest(request: ProgressRequest) {
    const captured = target
    try { await initializeLauncherState() }
    catch (failure) { setSaveNotice(presentError(failure)); return }
    if (current.current !== captured) return
    const held = useLauncherState.getState().drafts[draftKey]?.progressRequest
    const submit = submitButton.current
    // Transfer focus only when this submit is still focused as its own request replaces it.
    if (submit && submit.ownerDocument.activeElement === submit) requestFocus.current = request.input.operationId
    if (held || !useLauncherState.getState().setProgressRequest(draftKey, { ...request, dispatch: 'prepared' })) {
      requestFocus.current = undefined
      setSaveNotice('The original progress request is unconfirmed. Check that operation before another action.'); return
    }
    try {
      await checkpointLauncherState()
      if (!useLauncherState.getState().setProgressRequestDispatch(draftKey, request.input.operationId, 'started')) throw new Error('The original dispatch record could not be retained.')
      await checkpointLauncherState()
    } catch (failure) {
      useLauncherState.getState().setProgressRequestDispatch(draftKey, request.input.operationId, 'prepared')
      setSaveNotice('The original request could not be retained. No action was dispatched. ' + presentError(failure)); return
    }
    const result = await run(() => request.kind === 'create' ? progressApi.create(request.input) : progressApi.action(request.input.target,
      request.input.loopId, request.input.action, request.input.expectedLoop, request.input.operationId))
    if (result && recordedProgressRequest(request, result)) {
      useLauncherState.getState().clearProgressRequest(draftKey, request.input.operationId)
      try { await checkpointLauncherState() }
      catch (failure) { if (current.current === captured) setSaveNotice(presentError(failure)) }
    }
    else if (result && current.current === captured) setSaveNotice('The original action is recorded but its result remains unconfirmed. Check its original operation; no action was repeated.')
    return result && recordedProgressRequest(request, result) ? result : undefined
  }
  async function returnToEditing() {
    const request = useLauncherState.getState().drafts[draftKey]?.progressRequest
    if (busy || !request) return
    const captured = target
    useLauncherState.getState().retainProgressRequest(draftKey, request.input.operationId)
    try { await checkpointLauncherState(); if (current.current === captured) setSaveNotice(request.dispatch === 'prepared' ? 'The original request was not dispatched and is kept below. Edit, then explicitly save a new request.' : 'The original request remains unconfirmed and is kept below. Edit, then explicitly save a new independent request.') }
    catch (failure) { if (current.current === captured) setSaveNotice(presentError(failure)) }
  }
  async function checkOriginalRequest(returnToLoop = false) {
    const request = useLauncherState.getState().drafts[draftKey]?.progressRequest
    if (!request || busy) return
    const captured = target
    setBusy(true)
    try {
      const records = await progressApi.list(request.input.target, request.input.operationId)
      const latest = await progressApi.list(request.input.target)
      if (current.current !== captured || useLauncherState.getState().drafts[draftKey]?.progressRequest?.input.operationId !== request.input.operationId) return
      const found = records.find(value => request.kind === 'create' ? value.creationOperationId === request.input.operationId : value.loopId === request.input.loopId)
      const currentLoop = latest.find(value => request.kind === 'create' ? value.creationOperationId === request.input.operationId : value.loopId === request.input.loopId)
      const sameTarget = currentLoop && ['hostId', 'agentSessionId', 'providerId', 'workspacePath'].every(key =>
        currentLoop[key as keyof typeof target] === request.input.target[key as keyof typeof target])
      const confirmed = recordedProgressRequest(request, found)
      updates.current++; setLoops(latest.filter(value => !isAgentSchedule(value))); setObservedTarget(target)
      if (confirmed) {
        useLauncherState.getState().clearProgressRequest(draftKey, request.input.operationId)
        setSaveNotice('The original operation was found in Host storage. This is a recovered observation; no action was repeated.'); setError(undefined)
      } else if (returnToLoop && sameTarget) {
        useLauncherState.getState().retainProgressRequest(draftKey, request.input.operationId)
        setSaveNotice('The original loop is shown. The previous action remains unconfirmed below; it was not repeated.'); setError(undefined)
      } else setSaveNotice('The original operation remains unconfirmed. Missing records do not prove it was not applied. No action was repeated.')
      await checkpointLauncherState()
    } catch (failure) { if (current.current === captured) setSaveNotice(presentError(failure)) }
    finally { if (current.current === captured) setBusy(false) }
  }
  async function action(kind: 'pause' | 'resume' | 'stop' | 'check') {
    if (!loop || busy) return
    const captured = target
    setActionNotice(kind === 'resume' ? 'Resuming and checking this Agent…' : kind === 'check' ? 'Checking this Agent…' : kind === 'pause' ? 'Pausing automatic progress…' : 'Stopping automatic progress…')
    const result = await performRequest({ kind: 'action', input: { target, loopId: loop.loopId, action: kind, expectedLoop: loop, operationId: mintObjectId() } })
    if (current.current !== captured) return
    setActionNotice(!result ? undefined : kind === 'pause' ? 'Automatic progress paused.' : kind === 'stop' ? 'Automatic progress stopped.'
      : result.lastOutcome === 'unknown' ? 'The check result is unconfirmed. Review the latest decision.'
      : result.status !== 'active' ? 'Automatic progress is paused or stopped. Review the latest decision.'
      : result.lastOutcome === 'sent' ? 'Host accepted the request; a new Agent turn is not yet confirmed.'
      : result.lastOutcome === 'skipped' ? 'Check complete. No continuation prompt was sent.'
      : 'No check outcome was confirmed. Review the current loop status.')
  }
  function editConfiguration(patch: { interval?: string; prompt?: string }) {
    edited.current = true; editVersion.current++
    if (patch.interval !== undefined) setInterval(patch.interval)
    if (patch.prompt !== undefined) setPrompt(patch.prompt)
    useLauncherState.getState().setProgressDraft(draftKey, { interval, prompt, ...patch, expectedLoop: editBasis.current })
  }
  const configurationSave = useRef(false)
  async function saveConfiguration() {
    if (busy || configurationSave.current) return
    configurationSave.current = true
    try {
    if (useLauncherState.getState().drafts[draftKey]?.progressRequest) { if (pendingRequest?.dispatch === 'prepared') await returnToEditing(); else await checkOriginalRequest(); return }
    setSaveNotice(undefined)
    try { await initializeLauncherState() }
    catch (error) { setSaveNotice(presentError(error)); return }
    if (current.current !== target) return
    const restoredPending = useLauncherState.getState().drafts[draftKey]?.progressUpdate
    if (restoredPending && restoredPending.operationId !== pendingUpdate?.operationId) {
      setSaveNotice('An original save request was restored. Inspect that request before retrying; your current draft is kept.')
      return
    }
    const captured = target, version = editVersion.current
    const request: ProgressUpdateRequest | undefined = restoredPending ?? (loop ? {
      target, loopId: loop.loopId, expectedLoop: editBasis.current ?? loop,
      intervalMs: Number(interval) * 60_000, prompt, operationId: mintObjectId()
    } : undefined)
    if (!request) {
      let inputEpoch:string|undefined
      try{inputEpoch=await (original ? original.readInputEpoch() : api.sessions.readInputEpoch(target.hostId))??undefined}catch{/* Preserve the original request without guessing a storage cut. The final owner decides input. */}
      if(current.current!==captured)return
      const created = await performRequest({ kind: 'create', input: { target, intervalMs: Number(interval) * 60_000, prompt, operationId: mintObjectId(),
        ...(bindSource ? { taskSource: { root: sourceRoot, ownerId: sourceId, readerPath } } : {}), ...(inputEpoch ? { inputEpoch } : {}) } })
      if (created && current.current === captured) {
        editBasis.current = created
        if (editVersion.current === version) { edited.current = false; useLauncherState.getState().setProgressDraft(draftKey, undefined) }
      }
      return
    }
    useLauncherState.getState().setProgressUpdate(draftKey, request)
    try { await checkpointLauncherState() }
    catch {
      if (!restoredPending) useLauncherState.getState().retainProgressUpdate(draftKey, true)
      setSaveNotice('The save request could not be retained on this device. No update was dispatched. Your original request is kept below; edit and explicitly save when storage is available.')
      return
    }
    const saved = await run(() => progressApi.update(request), failure => {
      const code = (failure as { code?: string })?.code
      // Only an explicit first-attempt rejection proves this request was not applied.
      if (!restoredPending && ['CONTROL_REQUEST_CONFLICT', 'INVALID_CONTROL_REQUEST', 'CONTROL_PERMISSION_DENIED'].includes(code ?? '')) {
        useLauncherState.getState().setProgressUpdate(draftKey, undefined)
        if (current.current === captured) setConflict(code === 'CONTROL_REQUEST_CONFLICT')
      }
      if (current.current === captured) setSaveNotice(presentError(failure))
    })
    if (!saved) return
    useLauncherState.getState().setProgressUpdate(draftKey, undefined)
    const heldDraft = useLauncherState.getState().drafts[draftKey]?.progressDraft
    useLauncherState.getState().setProgressDraft(draftKey, heldDraft && (heldDraft.prompt !== request.prompt || Number(heldDraft.interval) * 60_000 !== request.intervalMs) ? { expectedLoop: saved } : undefined)
    if (current.current !== captured) return
    editBasis.current = saved; setConflict(false)
    if (editVersion.current === version && request.prompt === prompt && request.intervalMs === Number(interval) * 60_000) edited.current = false
    setSaveNotice('Changes saved. ' + (saved.status === 'paused' ? 'Continuous progress remains paused.' : 'The current check keeps its original settings.'))
    } finally { configurationSave.current = false }
  }
  async function reviewLatest() {
    const captured = target
    try {
      const latest = await progressApi.list(target)
      if (current.current !== captured) return
      updates.current++; setLoops(latest.filter(value => !isAgentSchedule(value))); setObservedTarget(target)
      editBasis.current = latest.find(value => value.loopId === loop?.loopId)
      if (pendingUpdate) useLauncherState.getState().retainProgressUpdate(draftKey)
      const draft = useLauncherState.getState().drafts[draftKey]?.progressDraft
      useLauncherState.getState().setProgressDraft(draftKey, { interval: draft?.interval ?? interval, prompt: draft?.prompt ?? prompt, expectedLoop: editBasis.current })
      setConflict(false); setSaveNotice('Latest saved settings are available in the automation details. Your draft is kept; save again to apply it.' + (pendingUpdate ? ' The previous save remains unconfirmed below.' : ''))
    } catch (failure) { if (current.current === captured) setSaveNotice(presentError(failure)) }
  }
  const progress = displayed || status === 'unconfirmed' ? <>
    {status === 'unconfirmed' ? <p className="continuous-progress-control__notice" role="status">Automatic progress is unconfirmed. {observedTarget !== target && !observationError ? 'Waiting for loop status. ' : ''}Manual input follows terminal readiness.{observationError ? ` ${observationError}` : ''}</p> : null}
    <details className="continuous-progress-control__details" data-progress-details="interval" onToggle={event => event.stopPropagation()}>
      <summary><span className="automation-progress__title">Continuous progress</span> <span className="automation-state" data-state={status}>{status === 'unconfirmed' ? 'Unconfirmed' : displayed?.status === 'stopped' ? 'Stopped' : status === 'inactive' ? 'Not enabled' : status === 'active' ? 'Active' : 'Paused'}</span>{displayed ? <><small className="automation-progress__summary">{displayed.prompt.split('\n')[0]}</small><small className="automation-progress__cadence">Every {displayed.intervalMs / 60000} min</small></> : null}</summary>
      <div className="continuous-progress-control__detail-body">
    {displayed ? <ContinuousProgressPanel loop={{ loopId: displayed.loopId, providerLabel: agentProviderLabel(target.providerId),
      executionState: original?.executionState ?? session!.status.state, loopState: displayed.status,
      ...(displayed.status === 'active' && status !== 'unconfirmed' ? { nextCheckAt: displayed.nextCheckAt } : {}),
      ...(displayed.lastTickAt !== undefined ? { lastTickAt: displayed.lastTickAt } : {}),
      ...(displayed.lastDecision ? { lastDecision: displayed.lastDecision } : displayed.lastOutcome === 'sent' ? { lastDecision: 'Host accepted the request; a new Agent turn is not yet confirmed.' } : {}) }}
      unconfirmed={status === 'unconfirmed'}
      notice={error ?? actionNotice}
      disabled={busy || !!pendingRequest} onPause={() => action('pause')} onResume={() => action('resume')} onStop={() => action('stop')} onCheck={() => action('check')} />
      : null}
    {displayed ? <details className="continuous-progress-control__details" data-progress-details="configuration" onToggle={event => event.stopPropagation()}>
      <summary>Saved configuration</summary>
      <div className="continuous-progress-control__detail-body">
        <dl><dt>Check every</dt><dd>{displayed.intervalMs / 60_000} minutes</dd></dl>
        <div><h4>Continuation prompt</h4><p className="continuous-progress-control__prompt">{displayed.prompt}</p></div>
        {displayed.taskSource?.kind === 'goal' ? <dl><dt>Goal</dt><dd>{displayed.taskSource.goalId}</dd><dt>Confirmed scope</dt><dd>r{displayed.taskSource.alignmentRevision}</dd></dl> : displayed.taskSource ? <dl>
          <dt>Feature ID</dt><dd>{displayed.taskSource.ownerId}</dd>
          <dt>Tracker root</dt><dd>{displayed.taskSource.root}</dd>
          <dt>Public Tracker script</dt><dd>{displayed.taskSource.readerPath}</dd>
        </dl> : <p className="continuous-progress-control__help">No task source bound. Periodic continuation only.</p>}
      </div>
    </details> : null}
      </div>
    </details>
  </> : null
  const progressForm = <form ref={progressFormElement} aria-label="Continuous progress setup" onChange={() => { edited.current = true; editVersion.current++ }} onCompositionStart={() => { edited.current = true; editVersion.current++ }} onSubmit={event => { event.preventDefault(); if (!conflict) void saveConfiguration() }}>
      <section className="continuous-progress-control__group" aria-label="Continuation settings">
        <label className="continuous-progress-control__interval">Check every (minutes)<TextInput type="number" min="1" value={interval} onChange={event => editConfiguration({ interval: event.target.value })} /></label>
        <label>Continuation prompt<ComposerTextarea value={prompt} onValueChange={value => editConfiguration({ prompt: value })} /></label>
      </section>
      <details className="continuous-progress-control__group continuous-progress-control__optional" aria-label="Optional task source" onToggle={event => event.stopPropagation()} hidden={!!loop || !!pendingUpdate}>
        <summary>Task source <span>Optional</span></summary>
        <label><input type="checkbox" checked={bindSource} onChange={event => setBindSource(event.target.checked)} />Bind a read-only Feature Tracker source</label>
        {bindSource ? <div className="continuous-progress-control__source-fields">
          <label>Tracker root<TextInput aria-label="Tracker root" value={sourceRoot} onChange={event => setSourceRoot(event.target.value)} /></label>
          <label>Feature ID<TextInput aria-label="Feature ID" value={sourceId} onChange={event => setSourceId(event.target.value)} /></label>
          <label>Public Tracker script<TextInput aria-label="Public Tracker script" value={readerPath} onChange={event => setReaderPath(event.target.value)} /></label>
        </div> : <p className="continuous-progress-control__help">Periodic continuation only. This loop is not bound to a business task source.</p>}
      </details>
        {loop ? <p className="continuous-progress-control__help">Applies to future checks. {loop.status === 'paused' ? 'Stays paused.' : 'Stays active.'}</p> : null}
        {[...new Set([saveNotice, persistenceIssue, error, observationError].filter(Boolean))].map(notice => <p key={notice} className="continuous-progress-control__notice" role="status">{notice}</p>)}
        {pendingUpdate && !busy ? <p className="continuous-progress-control__help">Previous save is unconfirmed. Retry saves its original values; your newer draft is kept.</p> : null}
        {pendingUpdate ? <Button type="button" disabled={busy} onClick={() => void reviewLatest()}>Review latest settings</Button> : null}
        {previousUpdates?.length ? <details className="continuous-progress-control__details" onToggle={event => event.stopPropagation()}><summary>Previous unconfirmed saves</summary>
          {previousUpdates.map(request => <div key={request.operationId} className="continuous-progress-control__detail-body"><code>{request.operationId}</code><p>{request.notDispatched ? 'Not dispatched. ' : ''}{request.intervalMs / 60_000} minutes</p><p className="continuous-progress-control__prompt">{request.prompt}</p></div>)}
        </details> : null}
        {conflict ? <Button type="button" onClick={() => void reviewLatest()}>Review latest settings</Button>
          : pendingRequest ? null : <button ref={submitButton} type="submit" className="automation-button automation-button--primary automation-submit" disabled={busy || (!pendingUpdate && (!prompt.trim() || (!loop && bindSource && (!sourceRoot.trim() || !sourceId.trim() || !readerPath.trim()))))}>{busy ? 'Saving…' : pendingUpdate ? 'Retry save' : loop ? 'Save changes' : 'Enable continuous progress'}</button>}
      </form>
  return <div className="continuous-progress-control" data-progress-state={status}>
    {presented && pendingRequest ? <section className="continuous-progress-control__notice" aria-label="Original progress request" role="status">
      <p>{pendingRequest.dispatch === 'prepared' ? 'The original request was not dispatched. Your input is kept.' : `The original ${pendingRequest.kind === 'create' ? 'creation' : pendingRequest.input.action} operation is unconfirmed. Your input is kept.`}</p>
      <button ref={requestAction} type="button" className="automation-button automation-button--primary" disabled={busy}
        onClick={() => void (pendingRequest.dispatch === 'prepared' ? returnToEditing() : checkOriginalRequest())}>{pendingRequest.dispatch === 'prepared' ? 'Keep request and edit' : 'Check original request'}</button>
      {pendingRequest.dispatch !== 'prepared' ? <>
        <Button type="button" disabled={busy} onClick={() => void returnToEditing()}>Keep unknown request and edit</Button>
        <Button type="button" disabled={busy} onClick={() => void checkOriginalRequest(true)}>Return to original loop</Button>
      </> : null}
      <details><summary>Original request</summary><pre className="continuous-progress-control__prompt">{JSON.stringify(pendingRequest.input, null, 2)}</pre></details>
      {saveNotice ? <p>{saveNotice}</p> : null}
    </section> : null}
    {presented && previousRequests?.length ? <details><summary>Retained progress requests</summary>{previousRequests.map(request =>
      <div key={request.input.operationId}><p>{request.dispatch === 'prepared' ? 'Not dispatched.' : 'Original result remains unconfirmed.'}</p><code>{request.input.operationId}</code><pre className="continuous-progress-control__prompt">{JSON.stringify(request.input, null, 2)}</pre></div>)}</details> : null}
    {original ? <>{presented ? progress : null}{presented ? progressForm : null}<p className="continuous-progress-control__help">Calendar schedules are not connected through this original Session route.</p></> : <CalendarScheduleControl target={target} onStatusChange={setCalendarStatus} presented={visible} detailsPresented={presented} unified
      progressConfigured={!!loop}
      progress={presented ? progress : null} progressForm={presented ? progressForm : null} />}
    {presented ? <>
    <details className="continuous-progress-control__details automation-target" data-progress-details="target" onToggle={event => event.stopPropagation()}>
      <summary>Agent details</summary>
      <dl className="continuous-progress-control__detail-body">
        <dt>Sending to</dt><dd>{targetName || original?.label || session?.label}</dd>
        <dt>Provider</dt><dd>{agentProviderLabel(target.providerId)} ({target.providerId})</dd>
        <dt>Host</dt><dd>{target.hostId}</dd>
        <dt>Session</dt><dd>{target.agentSessionId}</dd>
        <dt>Workspace</dt><dd title={displayPath(target.workspacePath, target.hostId)}>{displayPath(target.workspacePath, target.hostId)}</dd>
      </dl>
    </details>
    </> : null}
  </div>
}
