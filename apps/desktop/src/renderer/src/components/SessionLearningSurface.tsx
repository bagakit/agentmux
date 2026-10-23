import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentLearningOperation, AgentLearningSource, AgentLearningTarget } from '@agentmux/core/agent-learning'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { executorsForHost } from '../lib/executors'
import { retainAgentLearningReviewDraft, useAppStore } from '../store'
import { learningReviewKey, type AgentLearningReviewDraft } from '../lib/agent-learning-review-draft'
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
  const saved = useAppStore.getState().agentLearningReviewDrafts[learningReviewKey(source)]
  const view = useRef<AgentLearningReviewDraft>(saved ?? { source, operationId: null, executorId: null, target: null, draft: null, extraction: null })
  const [executorId, setExecutorId] = useState<string | null>(view.current.executorId)
  const [operation, setOperation] = useState<AgentLearningOperation | null>(null)
  const [operations, setOperations] = useState<AgentLearningOperation[]>([])
  const [draft, setDraft] = useState(view.current.draft?.content ?? '')
  const [targets, setTargets] = useState<Array<{ value: string; label: string; description: string; target: AgentLearningTarget }>>(() => {
    const target = view.current.target
    return target ? [{ value: JSON.stringify(target), label: `Original ${target.kind === 'mote' ? 'Mote' : 'Topic'}`, description: 'Saved selection · current resource details unconfirmed', target }] : []
  })
  const [targetKey, setTargetKey] = useState(view.current.target ? JSON.stringify(view.current.target) : '')
  const [issue, setIssue] = useState<{ message: string; action: 'read' | 'confirm' } | null>(null)
  const [busy, setBusy] = useState(false)
  const admitted = useRef(false), pendingId = useRef<string | null>(view.current.operationId), surface = useRef<HTMLElement>(null), navigating = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const dirty = operation?.candidate !== null && draft !== (operation?.candidate?.content ?? '')
  const conflict = !!operation?.candidate && !!view.current.draft && view.current.draft.expectedRevision !== operation.revision && dirty
  async function retain(patch: Partial<AgentLearningReviewDraft>, flush = false) {
    view.current = { ...view.current, ...patch }
    await retainAgentLearningReviewDraft(view.current, flush)
  }
  function keep(patch: Partial<AgentLearningReviewDraft>) { void retain(patch).catch(error => setIssue({ message: presentError(error), action: 'read' })) }
  function accept(value: AgentLearningOperation, expectedDraft = draftRef.current, preserveDraft = false, submittedRevision?: number) {
    if (value.source.hostId !== source.hostId || value.source.agentSessionId !== source.agentSessionId) throw new Error('This operation belongs to another original source. The current draft and work are kept.')
    setOperation(value); pendingId.current = value.operationId
    if (!preserveDraft && draftRef.current === expectedDraft) {
      setDraft(value.candidate?.content ?? '')
      keep({ operationId: value.operationId, draft: null })
    } else {
      const later = view.current.draft
      keep({ operationId: value.operationId, ...(later && submittedRevision !== undefined && value.revision === submittedRevision + 1 && value.candidate?.content === expectedDraft
        ? { draft: { ...later, expectedRevision: value.revision } } : {}) })
    }
  }
  async function run(action: () => Promise<void>, origin: 'read' | 'confirm' = 'read') {
    if (admitted.current) return
    admitted.current = true; setBusy(true); setIssue(current => origin === 'confirm' || current?.action !== 'confirm' ? null : current)
    try { await action() } catch (error) { setIssue({ message: presentError(error), action: origin }) }
    finally { admitted.current = false; setBusy(false) }
  }
  async function refresh() {
    const originalDraft = draftRef.current
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
        if (result.operation) {
          const retained = view.current.draft
          accept(result.operation, originalDraft, retained !== null && retained.content !== result.operation.candidate?.content)
          if (retained && retained.expectedRevision !== result.operation.revision) setIssue({ message: 'The original candidate changed. Your edits are kept here; save will check their original revision before changing it.', action: 'read' })
        }
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
      // Topic discovery is an independent observation. Keep confirmed Motes and the
      // last known Topic references available while its original owner is unavailable.
      setTargets(previous => [...values, ...previous.filter(item => item.target.kind === 'topic')])
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
      if (topics.unavailable.length) setIssue(current => current?.action === 'confirm' ? current : { message: topics.unavailable.map(item => item.message).join('\n'), action: 'read' })
    })
  }
  useEffect(() => { if (active) void refresh() }, [active, source.hostId, source.agentSessionId])
  useLayoutEffect(() => {
    if (!active || !surface.current) return
    const node = surface.current, held = Array.from(node.parentElement?.children ?? []).filter((value): value is HTMLElement => value instanceof HTMLElement && value !== node).map(value => ({ value, inert: value.inert }))
    held.forEach(({ value }) => { value.inert = true })
    node.querySelector<HTMLButtonElement>('[aria-label="Close experience review"]')?.focus({ preventScroll: true })
    navigating.current = false
    return () => { const focusedHere = node.contains(document.activeElement); held.forEach(({ value, inert }) => { value.inert = inert }); if (!navigating.current && focusedHere && returnTrigger?.isConnected) returnTrigger.focus({ preventScroll: true }) }
  }, [active])
  const selectedTarget = targets.find(item => item.value === targetKey)?.target
  const approvedTarget = operation?.approved ? targets.find(item => JSON.stringify(item.target) === JSON.stringify(operation.approved!.target)) : null
  function viewAgent(agentSessionId: string) { navigating.current = true; useAppStore.getState().revealFocusAgent({ hostId: source.hostId, agentSessionId }); onClose() }
  async function continueOriginal(step: 'extraction' | 'learning') {
    if (!operation) return
    const originalDraft = draftRef.current
    await run(async () => accept((await api.agentLearning.call('agent.learning.continue', { hostId: source.hostId, operationId: operation.operationId, step })).operation, originalDraft, view.current.draft !== null))
  }
  async function extract() {
    if (!executorId || operation) return
    const original = view.current.extraction ?? { operationId: pendingId.current ?? mintObjectId(), executorId }
    pendingId.current = original.operationId
    await run(async () => {
      await retain({ operationId: original.operationId, extraction: original }, true)
      accept((await api.agentLearning.call('agent.learning.prepare', { operationId: original.operationId, source, executorId: original.executorId })).operation)
    })
  }
  async function save(mergeCurrent = false) {
    if (!operation || !draft.trim()) return
    const submittedDraft = draft, expectedRevision = mergeCurrent ? operation.revision : view.current.draft?.expectedRevision ?? operation.revision
    if (mergeCurrent) keep({ draft: { expectedRevision, content: submittedDraft } })
    await run(async () => accept((await api.agentLearning.call('agent.learning.revise', { hostId: source.hostId, operationId: operation.operationId, expectedRevision, content: submittedDraft })).operation, submittedDraft, false, expectedRevision))
  }
  async function confirm() {
    if (!operation?.candidate || dirty || !executorId || !selectedTarget) return
    const submittedDraft = draft
    await run(async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operation.candidate!.content))
      const candidateDigest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
      accept((await api.agentLearning.confirm({ hostId: source.hostId, operationId: operation.operationId, ownerRuntimeId: operation.ownerRuntimeId, candidateDigest,
        expectedRevision: operation.revision, target: selectedTarget, executorId, confirmationId: mintObjectId() })).operation, submittedDraft)
    }, 'confirm')
  }
  const issueNotice = issue ? <div className="session-takeover__issue" role="status"><strong>Original result needs attention</strong><p>{issue.message}</p>
    <p>The original work and request are kept.</p><div className="session-learning__actions"><button type="button" className="small-button" disabled={busy} onClick={() => void refresh()}>Inspect original request</button>
      {issue.action === 'confirm' ? <button type="button" className="small-button" disabled={busy || dirty || !executorId || !selectedTarget} onClick={() => void confirm()}>Retry exact confirmation</button> : null}</div></div> : null
  return <section ref={surface} className="session-takeover session-learning" aria-label="Review Agent experience" hidden={!active} inert={!active} aria-busy={busy}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="session-takeover__content">
      <header className="session-takeover__heading"><div><h2>Pass on what worked.</h2><p>Extract experience, review it, then choose who learns.</p></div>
        <button type="button" className="icon-button" aria-label="Close experience review" onClick={onClose}>×</button></header>
      <p className="session-learning__source"><strong>{label}</strong><span>Original work · {source.hostId}</span></p>
      {issue?.action === 'read' ? issueNotice : null}
      {!operation ? <>
        {operations.length > 1 ? <SelectionField label="Original extraction" value="" onValueChange={id => { const row = operations.find(item => item.operationId === id); if (row) accept(row) }} options={[
          { value: '', label: 'Choose an existing extraction' }, ...operations.map(row => ({ value: row.operationId, label: row.operationId, description: row.candidate ? 'Candidate ready for review' : 'Extraction in progress' }))]} /> : null}
        <AgentExecutorPicker presentation="field" label="Extraction Agent" unsetLabel="Choose an Agent" executors={executors} selected={executorId} onSelect={id => { setExecutorId(id); keep({ executorId: id }) }} disabled={busy || pendingId.current !== null} />
        <p>The extraction Agent reads the original work and proposes reusable experience. This step does not send anything to a Mote or Topic.</p>
        <button type="button" className="small-button" disabled={busy || !executorId} onClick={() => void extract()}>{pendingId.current ? 'Continue original extraction' : 'Extract experience'}</button>
        {pendingId.current ? <p>The original request is retained. Check it or explicitly continue this same request; no new identity will be created.</p> : null}
      </> : <>
        {operation.approved ? <div className="session-learning__status" role="status"><strong>Reviewed candidate confirmed</strong><span>{operation.approved.target.kind === 'mote' ? 'Mote' : 'Topic'} · {approvedTarget?.label ?? 'Original destination'}</span>
          <p>{operation.learner?.state === 'created' && operation.learner.context === 'confirmed' ? 'The learning task was delivered. Review its result and saved content to confirm knowledge changes.' : 'Learning delivery is unconfirmed. Use Check original to inspect this same request.'}</p>
          {operation.learner ? <div className="session-learning__actions"><button type="button" className="small-button" onClick={() => viewAgent(operation.learner!.agentSessionId)}>View learning Agent</button>
            {['prepared', 'unknown', 'not-applied'].includes(operation.learner.state) ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal('learning')}>Continue original delivery</button> : null}</div> : null}
        </div> : <div className="session-learning__status" role="status"><strong>{operation.candidate ? 'Experience ready to review' : operation.proposer.state === 'created' ? 'Extraction task created' : 'Extraction delivery is unconfirmed'}</strong>
          <div className="session-learning__actions"><button type="button" className="small-button" onClick={() => viewAgent(operation.proposer.agentSessionId)}>View extraction Agent</button>
            {['prepared', 'unknown', 'not-applied'].includes(operation.proposer.state) ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal('extraction')}>Continue original extraction</button> : null}</div></div>}
        {!operation.candidate ? <p>The candidate is not ready. Read the original extraction again to check its proposal.</p> : <>
          {!operation.approved || dirty ? <label className="session-learning__draft">{operation.approved ? 'Later edit retained · outside the confirmed candidate' : `Candidate · revision ${operation.revision}`}<textarea aria-label="Experience candidate" value={draft} readOnly={!!operation.approved} onChange={event => { const content = event.target.value; setDraft(content); keep({ draft: { expectedRevision: view.current.draft?.expectedRevision ?? operation.revision, content } }) }} spellCheck={false} /></label> : null}
          {operation.approved ? <details className="session-learning__candidate"><summary>Read the exact confirmed candidate · revision {operation.approved.candidateRevision}</summary><pre className="session-learning__confirmed">{operation.candidate.content}</pre>
            <button type="button" className="small-button" onClick={() => viewAgent(operation.proposer.agentSessionId)}>View extraction Agent</button></details> : null}
          {!operation.approved ? <>{conflict ? <div className="session-learning__conflict"><p>The saved candidate changed. Compare it below and merge the changes you want into your retained draft above.</p>
            <details open><summary>Current saved candidate · revision {operation.revision}</summary><pre className="session-learning__confirmed">{operation.candidate.content}</pre></details>
            <button type="button" className="small-button" disabled={busy || !draft.trim()} onClick={() => void save(true)}>Save merged draft against revision {operation.revision}</button></div> : null}
            <div className="session-learning__actions"><button type="button" className="small-button" disabled={busy || conflict || !dirty || !draft.trim()} onClick={() => void save()}>Save draft</button>{dirty ? <span>Save your edits before confirmation.</span> : <span>Review the sources, conditions and uncertainty.</span>}</div>
            <div className="session-learning__field"><span aria-hidden="true">Learning destination</span>
              <SelectionField label="Learning destination" value={targetKey} onValueChange={key => { setTargetKey(key); keep({ target: targets.find(item => item.value === key)?.target ?? null }) }} disabled={busy} options={[{ value: '', label: 'Choose a Mote or Topic' }, ...targets]} />
              {selectedTarget ? <p className="session-learning__destination">{targets.find(item => item.value === targetKey)!.description}</p> : null}</div>
            <div className="session-learning__field"><span aria-hidden="true">Learning Agent</span>
              <AgentExecutorPicker presentation="field" label="Learning Agent" unsetLabel="Choose an Agent" executors={executors} selected={executorId} onSelect={id => { setExecutorId(id); keep({ executorId: id }) }} disabled={busy} /></div>
            <div className="session-learning__confirmation"><button type="button" className="small-button" aria-label={issue?.action === 'confirm' ? 'Result needs attention · Inspect original result' : 'Confirm & send for learning'} disabled={busy || issue?.action !== 'confirm' && (dirty || !executorId || !selectedTarget)} onClick={() => {
              if (issue?.action === 'confirm') surface.current?.querySelector<HTMLElement>('.session-learning__confirmation .session-takeover__issue')?.scrollIntoView({ block: 'nearest' })
              else void confirm()
            }}>{issue?.action === 'confirm' ? 'Result needs attention · Inspect original result' : 'Confirm & send for learning'}</button>
              {issue?.action === 'confirm' ? issueNotice : null}</div>
          </> : null}
        </>}
        {[...operation.issues, ...operation.unavailable].map((item, index) => <p className="session-learning__issue" key={index}>{item.step}: {item.message}</p>)}
        <details className="session-learning__details"><summary>Original operation details</summary>
          <dl><dt>Source</dt><dd>{source.hostId} · {source.agentSessionId}</dd>
            <dt>Operation</dt><dd>{operation.operationId}</dd>
            <dt>Extraction</dt><dd>{operation.proposer.agentSessionId} · {operation.proposer.state} · Context {operation.proposer.context}</dd>
            {operation.learner ? <><dt>Learning</dt><dd>{operation.learner.agentSessionId} · {operation.learner.state} · Context {operation.learner.context}</dd></> : null}
            {operation.approved || selectedTarget ? <><dt>Destination</dt><dd>{(operation.approved?.target ?? selectedTarget)!.topicId}<br />{(operation.approved?.target ?? selectedTarget)!.zoneId}</dd></> : null}
          </dl>
        </details>
      </>}
      <footer className="session-takeover__footer"><span>{busy ? 'Reading the original operation…' : 'Your original Agent and work stay here.'}</span><button type="button" className="small-button" disabled={busy} onClick={() => void refresh()}>Check original</button></footer>
    </div>
  </section>
}
