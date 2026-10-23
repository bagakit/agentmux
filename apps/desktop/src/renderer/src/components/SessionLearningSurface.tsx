import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentLearningOperation, AgentLearningSource, AgentLearningTarget } from '@agentmux/core/agent-learning'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { executorsForHost } from '../lib/executors'
import { useAppStore } from '../store'
import { homeZoneId } from '../../../shared/space-addresses'
import { desktopBindingsFromSpatial } from '../lib/desktop-spatial-state'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { SelectionField } from './SelectionField'

/** This workface reads the Host's operation; it never decides approval from Agent prose. */
export function SessionLearningSurface({ source, label, active, onClose, returnTrigger }: {
  source: AgentLearningSource; label: string; active: boolean; onClose(): void; returnTrigger?: HTMLButtonElement | null
}) {
  const config = useAppStore(state => state.config)
  const detections = useAppStore(state => state.executorDetections)
  const inventory = useAppStore(state => state.hostExecutorInventories[source.hostId])
  const executors = useMemo(() => executorsForHost(config, source.hostId, detections, inventory), [config, detections, inventory, source.hostId])
  const [executorId, setExecutorId] = useState<string | null>(null)
  const [operation, setOperation] = useState<AgentLearningOperation | null>(null)
  const [operations, setOperations] = useState<AgentLearningOperation[]>([])
  const [draft, setDraft] = useState('')
  const [targets, setTargets] = useState<Array<{ value: string; label: string; description: string; target: AgentLearningTarget }>>([])
  const [targetKey, setTargetKey] = useState('')
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const admitted = useRef(false), pendingId = useRef<string | null>(null), surface = useRef<HTMLElement>(null)
  const draftRef = useRef(draft), operationRef = useRef(operation)
  draftRef.current = draft; operationRef.current = operation
  const dirty = operation?.candidate !== null && draft !== (operation?.candidate?.content ?? '')
  function accept(value: AgentLearningOperation, expectedDraft = draftRef.current) {
    if (value.source.hostId !== source.hostId || value.source.agentSessionId !== source.agentSessionId) throw new Error('This operation belongs to another original source. The current draft and work are kept.')
    setOperation(value); pendingId.current = value.operationId
    if (draftRef.current === expectedDraft) setDraft(value.candidate?.content ?? '')
  }
  async function run(action: () => Promise<void>) {
    if (admitted.current) return
    admitted.current = true; setBusy(true); setIssue(null)
    try { await action() } catch (error) { setIssue(presentError(error)) }
    finally { admitted.current = false; setBusy(false) }
  }
  async function refresh() {
    const originalDraft = draftRef.current
    const wasDirty = originalDraft !== (operationRef.current?.candidate?.content ?? '')
    await run(async () => {
      const rows: AgentLearningOperation[] = []
      let cursor: string | undefined
      do {
        const page = await api.agentLearning.call('agent.learning.ls', { hostId: source.hostId, agentSessionId: source.agentSessionId, ...(cursor ? { cursor } : {}) })
        rows.push(...page.operations); cursor = page.nextCursor ?? undefined
      } while (cursor)
      setOperations(rows)
      const id = pendingId.current ?? operation?.operationId ?? (rows.length === 1 ? rows[0]!.operationId : null)
      if (id) {
        const result = await api.agentLearning.call('agent.learning.inspect', { hostId: source.hostId, operationId: id })
        if (result.operation && !wasDirty) accept(result.operation, originalDraft)
        else if (result.operation && result.operation.revision !== operation?.revision) setIssue('The original candidate changed. Your edits are kept here; save will check the original revision before changing it.')
      }
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: mintObjectId(), operation: 'space.ls', target: {} })
      if (result.operation !== 'space.ls') throw new Error('The original destination catalogue is unavailable.')
      const values: typeof targets = []
      for (const space of result.catalog.spaces) {
        if (space.kind !== 'mote' || space.hostId !== source.hostId || !space.topicId) continue
        const home = result.catalog.zones.find(zone => zone.zoneId === homeZoneId(space.spaceId) && zone.kind === 'home' && zone.hostId === space.hostId && result.catalog.bindings.some(binding => binding.spaceId === space.spaceId && binding.zoneId === zone.zoneId))
        const workspace = config?.workspaces.find(item => item.id === home?.workspaceId && item.hostId === space.hostId)
        if (!home || !workspace) continue
        const target: AgentLearningTarget = { kind: space.kind, topicId: space.topicId, spaceId: space.spaceId, zoneId: home.zoneId,
          expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
        values.push({ value: JSON.stringify(target), label: space.name ?? space.topicId, description: `${space.kind === 'mote' ? 'Mote' : 'Topic'} · ${space.hostId} · ${space.directoryPath ?? space.spaceId}`, target })
      }
      const topics = await api.topics.call('topic.ls', {})
      const spatial = await api.spatial.read()
      const bindings = spatial ? desktopBindingsFromSpatial(spatial.graph, config) : {}
      for (const topic of topics.topics) {
        if (topic.hostId !== source.hostId || topic.readError) continue
        const home = result.catalog.zones.find(zone => zone.zoneId === topic.zoneId && zone.kind === 'home' && zone.hostId === topic.hostId)
        const workspace = config?.workspaces.find(item => item.id === home?.workspaceId && item.hostId === topic.hostId)
        const binding = bindings[topic.zoneId]
        if (!home || !workspace || !binding || binding.contentKind !== 'topic' || binding.topicId !== topic.topicId || binding.workspaceId !== workspace.id) continue
        const target: AgentLearningTarget = { kind: 'topic', topicId: topic.topicId, spaceId: binding.spaceId, zoneId: home.zoneId,
          expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
        const categories = topic.categorySpaceIds.map(id => result.catalog.spaces.find(space => space.spaceId === id)?.name).filter(Boolean)
        values.push({ value: JSON.stringify(target), label: topic.title, description: `Topic · ${topic.hostId}${categories.length ? ' · ' + categories.join(', ') : ''}`, target })
      }
      setTargets(values)
      if (topics.unavailable.length) setIssue(topics.unavailable.map(item => item.message).join('\n'))
    })
  }
  useEffect(() => { if (active) void refresh() }, [active, source.hostId, source.agentSessionId])
  useLayoutEffect(() => {
    if (!active || !surface.current) return
    const node = surface.current, held = Array.from(node.parentElement?.children ?? []).filter((value): value is HTMLElement => value instanceof HTMLElement && value !== node).map(value => ({ value, inert: value.inert }))
    held.forEach(({ value }) => { value.inert = true })
    node.querySelector<HTMLButtonElement>('[aria-label="Close experience review"]')?.focus({ preventScroll: true })
    return () => { held.forEach(({ value, inert }) => { value.inert = inert }); if (returnTrigger?.isConnected) returnTrigger.focus({ preventScroll: true }) }
  }, [active])
  const selectedTarget = targets.find(item => item.value === targetKey)?.target
  function viewAgent(agentSessionId: string) { useAppStore.getState().revealFocusAgent({ hostId: source.hostId, agentSessionId }); onClose() }
  async function continueOriginal(step: 'extraction' | 'learning') {
    if (!operation) return
    const originalDraft = draftRef.current
    await run(async () => accept((await api.agentLearning.call('agent.learning.continue', { hostId: source.hostId, operationId: operation.operationId, step })).operation, originalDraft))
  }
  async function extract() {
    if (!executorId || pendingId.current || operation) return
    pendingId.current = mintObjectId()
    await run(async () => accept((await api.agentLearning.call('agent.learning.prepare', { operationId: pendingId.current!, source, executorId })).operation))
  }
  async function save() {
    if (!operation || !draft.trim()) return
    const submittedDraft = draft
    await run(async () => accept((await api.agentLearning.call('agent.learning.revise', { hostId: source.hostId, operationId: operation.operationId, expectedRevision: operation.revision, content: submittedDraft })).operation, submittedDraft))
  }
  async function confirm() {
    if (!operation?.candidate || dirty || !executorId || !selectedTarget) return
    const submittedDraft = draft
    await run(async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operation.candidate!.content))
      const candidateDigest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
      accept((await api.agentLearning.confirm({ hostId: source.hostId, operationId: operation.operationId, ownerRuntimeId: operation.ownerRuntimeId, candidateDigest,
        expectedRevision: operation.revision, target: selectedTarget, executorId, confirmationId: mintObjectId() })).operation, submittedDraft)
    })
  }
  return <section ref={surface} className="session-takeover session-learning" aria-label="Review Agent experience" hidden={!active} inert={!active} aria-busy={busy}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="session-takeover__content">
      <header className="session-takeover__heading"><div><h2>Pass on what worked.</h2><p>Extract experience, review it, then choose who learns.</p></div>
        <button type="button" className="icon-button" aria-label="Close experience review" onClick={onClose}>×</button></header>
      <p className="session-learning__source"><strong>{label}</strong><span>{source.hostId} · {source.agentSessionId}</span></p>
      {!operation ? <>
        {operations.length > 1 ? <SelectionField label="Original extraction" value="" onValueChange={id => { const row = operations.find(item => item.operationId === id); if (row) accept(row) }} options={[
          { value: '', label: 'Choose an existing extraction' }, ...operations.map(row => ({ value: row.operationId, label: row.operationId, description: row.candidate ? 'Candidate ready for review' : 'Extraction in progress' }))]} /> : null}
        <AgentExecutorPicker presentation="field" label="Extraction Agent" unsetLabel="Choose an Agent" executors={executors} selected={executorId} onSelect={setExecutorId} disabled={busy || pendingId.current !== null} />
        <p>The extraction Agent reads the original work and proposes reusable experience. This step does not send anything to a Mote or Topic.</p>
        <button type="button" className="small-button" disabled={busy || !executorId || pendingId.current !== null} onClick={() => void extract()}>Extract experience</button>
      </> : <>
        <div className="session-learning__status" role="status">Extraction · {operation.proposer.state} · Context {operation.proposer.context}
          <span>Agent {operation.proposer.agentSessionId}</span>
          <div className="session-learning__actions"><button type="button" className="small-button" onClick={() => viewAgent(operation.proposer.agentSessionId)}>View extraction Agent</button>
            {['prepared', 'unknown', 'not-applied'].includes(operation.proposer.state) ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal('extraction')}>Continue original extraction</button> : null}</div></div>
        {!operation.candidate ? <p>The candidate is not ready. Read the original extraction again to check its proposal.</p> : <>
          <label className="session-learning__draft">Candidate · revision {operation.revision}<textarea aria-label="Experience candidate" value={draft} readOnly={!!operation.approved} onChange={event => setDraft(event.target.value)} spellCheck={false} /></label>
          {!operation.approved ? <><div className="session-learning__actions"><button type="button" className="small-button" disabled={busy || !dirty || !draft.trim()} onClick={() => void save()}>Save draft</button>{dirty ? <span>Save your edits before confirmation.</span> : <span>Review the sources, conditions and uncertainty.</span>}</div>
            <SelectionField label="Learning destination" value={targetKey} onValueChange={setTargetKey} disabled={busy} options={[{ value: '', label: 'Choose a Mote or Topic' }, ...targets]} />
            <AgentExecutorPicker presentation="field" label="Learning Agent" unsetLabel="Choose an Agent" executors={executors} selected={executorId} onSelect={setExecutorId} disabled={busy} />
            {selectedTarget ? <p className="session-learning__destination">{targets.find(item => item.value === targetKey)!.description}</p> : null}
            <button type="button" className="small-button" disabled={busy || dirty || !executorId || !selectedTarget} onClick={() => void confirm()}>Confirm &amp; send for learning</button>
          </> : <div className="session-learning__status" role="status"><strong>Reviewed candidate confirmed</strong><span>{operation.approved.target.kind} · {operation.approved.target.topicId} · {operation.approved.target.expectedResource.hostId}</span>
            <span>Learning Agent · {operation.learner?.state ?? 'Unconfirmed'} · Context {operation.learner?.context ?? 'unknown'}</span>
            {operation.learner ? <span>Agent {operation.learner.agentSessionId}</span> : null}
            {operation.learner ? <div className="session-learning__actions"><button type="button" className="small-button" onClick={() => viewAgent(operation.learner!.agentSessionId)}>View learning Agent</button>
              {['prepared', 'unknown', 'not-applied'].includes(operation.learner.state) ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal('learning')}>Continue original delivery</button> : null}</div> : null}
            <p>Task delivery does not prove saved knowledge. Inspect the learner’s original result and the destination’s saved content before claiming it learned.</p></div>}
        </>}
        {[...operation.issues, ...operation.unavailable].map((item, index) => <p className="session-learning__issue" key={index}>{item.step}: {item.message}</p>)}
        <p className="session-learning__source"><span>Original operation · {operation.operationId}</span></p>
      </>}
      {issue ? <div className="session-takeover__issue" role="status"><strong>Original result needs attention</strong><p>{issue}</p><p>The original work and request are kept. Check this same operation before taking another action.</p></div> : null}
      <footer className="session-takeover__footer"><span>{busy ? 'Reading the original operation…' : 'Your original Agent and work stay here.'}</span><button type="button" className="small-button" disabled={busy} onClick={() => void refresh()}>Check original</button></footer>
    </div>
  </section>
}
