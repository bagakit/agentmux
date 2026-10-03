import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Search, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { recoveryOperationId, createRecoveryAgent, analyzeWithRecoveryMote, inspectRecoveryRequest, recoveryMoteTargets,
  type RecoveryMode, type RecoverySource, type RecoveryActionResult } from '../lib/session-recovery-actions'

/** Explicit choices share the existing spatial/queue correlation across dialog and Renderer mounts. */
export function SessionRecoveryActions({ source, restoring, restoreDisabled = false, restoreLabel = 'Restore original', workingLabel = 'Restoring…', onRestore, onTakeOver }: {
  source: RecoverySource; restoring: boolean; restoreDisabled?: boolean; restoreLabel?: string; workingLabel?: string; onRestore: () => void; onTakeOver?: () => void
}) {
  const [mode, setMode] = useState<RecoveryMode | null>(null), [destination, setDestination] = useState<'agent' | 'mote'>('agent')
  const config = useAppStore(state => mode ? state.config : null)
  const tabs = useAppStore(state => mode === 'analyze' ? state.tabs : null), sessions = useAppStore(state => mode === 'analyze' ? state.sessions : null)
  const topics = useAppStore(state => mode === 'analyze' ? state.scratchTopicSnapshots : null)
  const queues = useAppStore(state => mode ? state.agentSteerQueues : null), requests = useAppStore(state => mode ? state.spatialRequests : null)
  const [executorId, setExecutorId] = useState(''), [moteKey, setMoteKey] = useState('')
  const [historySource, setHistorySource] = useState<'captured' | 'native'>('captured')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RecoveryActionResult | null>(null), [operationId, setOperationId] = useState<string | null>(null)
  const directory = useScratchTopics(mode === 'analyze' ? SCRATCH_WORKSPACE_ID : null)
  const active = useRef(true), submitting = useRef(false), selection = useRef('')
  const cancel = useRef<HTMLButtonElement>(null), previousFocus = useRef<HTMLElement | null>(null), openedContent = useRef<Element | null>(null)
  const scope = JSON.stringify([source.hostId, source.agentSessionId, source.tabId, source.regionId, mode, destination, executorId, moteKey, historySource])
  selection.current = scope
  const motes = mode === 'analyze' ? recoveryMoteTargets() : [] // Subscriptions above keep only this relevant chooser current.
  void tabs; void sessions; void topics
  const keyOf = (target: typeof motes[number]) => JSON.stringify([target.topicId, target.tabId, target.regionId, target.agentSessionId])
  const target = motes.find(item => keyOf(item) === moteKey)
  const correlation = operationId ? requests?.[operationId] : undefined
  const original = correlation?.operation === 'agent.open' ? correlation.recovery : undefined
  const originalMote = correlation?.operation === 'agent.message' ? correlation.recoveryRecipient : undefined
  const queuedOwner = operationId ? Object.entries(queues ?? {}).find(([, entries]) => entries.some(entry => entry.operationId === operationId))?.[0] : undefined
  const existing = Boolean(correlation || queuedOwner)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let live = true
    setResult(null); setError(null); setOperationId(null)
    if (mode) void recoveryOperationId(source, mode).then(id => {
      if (!live) return
      setOperationId(id)
      const binding = useAppStore.getState().spatialRequests[id], retained = binding?.recovery
      if (retained) { setExecutorId(retained.executorId ?? ''); setHistorySource(retained.historySource); setDestination(binding.operation === 'agent.message' ? 'mote' : 'agent') }
      if (binding?.recoveryRecipient) setMoteKey(JSON.stringify([binding.recoveryRecipient.topicId, binding.recoveryRecipient.tabId, binding.recoveryRecipient.regionId, binding.recoveryRecipient.agentSessionId]))
      const pending = Object.entries(useAppStore.getState().agentSteerQueues).find(([, entries]) => entries.some(entry => entry.operationId === id))
      const retainedNote = pending?.[1].find(entry => entry.operationId === id)?.agentMuxNote
      const chosen = pending && recoveryMoteTargets().find(item => item.agentSessionId === pending[0] &&
        retainedNote?.includes(`Chosen analysis recipient: ${JSON.stringify({ topicId: item.topicId, tabId: item.tabId, regionId: item.regionId, hostId: item.hostId, agentSessionId: item.agentSessionId })}`))
      if (chosen) { setDestination('mote'); setMoteKey(keyOf(chosen)) }
      if (pending && !chosen && !binding?.recoveryRecipient) { setDestination('mote'); setError('The retained Mote recipient is not currently observed at its original Topic, Tab and Region. No replacement will be selected.') }
      if (retainedNote?.split('\n')[0]?.includes('"historySource":"native"')) setHistorySource('native')
    })
    return () => { live = false }
  }, [mode, source.hostId, source.agentSessionId, source.tabId, source.regionId])
  const close = () => { if (!busy) setMode(null) }
  async function submit() {
    if (!mode || submitting.current) return
    submitting.current = true; setBusy(true); setError(null)
    const captured = scope, current = () => active.current && selection.current === captured
    try {
      const next = existing ? await inspectRecoveryRequest(source, mode) : destination === 'mote'
        ? target ? await analyzeWithRecoveryMote(source, target, historySource, current) : null
        : await createRecoveryAgent(source, mode, executorId, historySource, current)
      if (current()) {
        if (next) setResult(next)
        else setError('Choose the exact Mote input. No request was sent.')
      }
    } catch (failure) { if (current()) setError(presentError(failure)) }
    finally { submitting.current = false; if (active.current) setBusy(false) }
  }
  const canSubmit = existing || (destination === 'agent' ? Boolean(executorId && config?.executors[executorId]) : Boolean(target))
  return <div className="session-recovery-actions">
    <button type="button" className="small-button" disabled={restoreDisabled || restoring} title={source.diagnostic} onClick={onRestore}>
      <RotateCcw size={12} /> {restoring ? workingLabel : restoreLabel}
    </button>
    {onTakeOver ? <button type="button" className="small-button" data-takeover-session-id={source.agentSessionId} data-takeover-region-id={source.regionId} onClick={onTakeOver}><ArrowRight size={12} /> Take over</button> : null}
    <button type="button" className="small-button" onClick={() => { setDestination('agent'); setExecutorId(''); setMoteKey(''); setMode('analyze') }}><Search size={12} /> Analyze…</button>
    <Dialog.Root open={mode !== null} onOpenChange={next => { if (!next) close() }}>
      <Dialog.Portal container={resolveOverlayContainer()}>
        <Dialog.Overlay className="dialog-scrim" />
        <Dialog.Content className="session-recovery-dialog dialog-surface" aria-busy={busy}
          onOpenAutoFocus={event => { event.preventDefault(); previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; openedContent.current = event.target instanceof Element ? event.target : null; cancel.current?.focus() }}
          onCloseAutoFocus={event => { event.preventDefault(); const originalFocus = previousFocus.current, focused = document.activeElement
            if (originalFocus?.isConnected && (focused === document.body || focused === originalFocus || !focused?.isConnected || openedContent.current?.contains(focused))) originalFocus.focus({ preventScroll: true }) }}
          onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
          <Dialog.Title>Analyze the original work</Dialog.Title>
          <Dialog.Description>Choose a new Agent or a Mote to read and assess the original work. Analysis does not execute the task. The original Session and drafts stay available.</Dialog.Description>
          <div className="session-recovery-dialog__source"><span>Original Session</span><strong>{source.agentSessionId}</strong><span>Host · {source.hostId}</span></div>
          <fieldset disabled={busy || existing}><legend>Send analysis to</legend>
            <label><input type="radio" name="recovery-destination" checked={destination === 'agent'} onChange={() => setDestination('agent')} /> New Agent</label>
            <label><input type="radio" name="recovery-destination" checked={destination === 'mote'} onChange={() => setDestination('mote')} /> Chosen Mote</label>
          </fieldset>
          {destination === 'agent' ? <label className="session-recovery-dialog__field">Executor
            <select aria-label="Recovery Executor" value={executorId} disabled={busy || existing} onChange={event => { setExecutorId(event.target.value); setResult(null) }}>
              <option value="">Choose an Executor…</option>{Object.entries(config?.executors ?? {}).map(([id, executor]) => <option key={id} value={id}>{executor.label} · {id}</option>)}
            </select></label> : <label className="session-recovery-dialog__field">Mote input
            <select aria-label="Analysis Mote" value={moteKey} disabled={busy || existing} onChange={event => { setMoteKey(event.target.value); setResult(null) }}>
              <option value="">Choose a Mote input…</option>{originalMote && !target ? <option value={moteKey}>Original recipient · {originalMote.agentSessionId} / {originalMote.regionId}</option> : null}{motes.map(item => <option key={keyOf(item)} value={keyOf(item)}>{item.label} · {item.tabId} / {item.regionId}</option>)}
            </select>{!motes.length ? <span>No confirmed Mote input is open. Open your chosen Mote, or choose a new Agent here.</span> : null}</label>}
          <label className="session-recovery-dialog__field">Read original history from
            <select aria-label="Original history source" value={historySource} disabled={busy || existing} onChange={event => setHistorySource(event.target.value as 'captured' | 'native')}>
              <option value="captured">Saved Core work record</option><option value="native">Confirmed Provider conversation</option>
            </select></label>
          {existing && !result && !error ? <p className="session-recovery-dialog__hint">An original request is retained. Check its current result before choosing another action.</p> : null}
          {destination === 'mote' && directory.error ? <p role="status" className="session-recovery-dialog__hint">Mote directory read is unconfirmed: {directory.error}. The saved recipient remains; refresh its original directory before choosing a replacement.</p> : null}
          {result?.kind === 'confirmed' && !error ? <p role="status">{result.message}</p> : result || error ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Request unconfirmed', mode: error ?? result!.message, restore: 'Check the original request.' } }} /> : null}
          <footer><button ref={cancel} type="button" className="small-button" disabled={busy} onClick={close}>{result?.kind === 'confirmed' ? 'Done' : 'Cancel'}</button>
            <button type="button" className="small-button session-recovery-dialog__confirm" disabled={busy || !canSubmit} onClick={() => void submit()}>
              {busy ? 'Checking…' : existing || result ? 'Check original request' : destination === 'mote' ? 'Send analysis' : 'Create analysis Agent'}
            </button></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>
}
