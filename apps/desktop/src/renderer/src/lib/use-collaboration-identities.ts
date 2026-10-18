import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { SessionHistorySourceObservation, SessionHistorySourceReference } from '../../../shared/contracts'
import { api } from './api'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationRelation } from './agent-collaboration'

type IdentityRead = { reference: SessionHistorySourceReference; source: AgentSessionHistoryDescriptor | null; issue: string | null; loading: boolean }
const referenceKey = (reference: SessionHistorySourceReference) => 'hostId' in reference
  ? collaborationSubjectKey(reference) : JSON.stringify(['runtime-reference', reference.runtimeId, reference.agentSessionId])

/** Disposable metadata demand. Discovering an endpoint never requests its conversation or relations. */
export function useCollaborationIdentities(agents: ReadonlyMap<string, CollaborationAgent>, wanted: ReadonlySet<string>,
  known: ReadonlyMap<string, CollaborationAgent>, enabled: boolean, ownerRevision: unknown) {
  const retries = useRef(new Map<string, SessionHistorySourceReference>())
  const requests = [...new Set([...wanted, ...retries.current.keys()])].flatMap(id => {
    const agent = agents.get(id), reference = retries.current.get(id) ?? agent?.reference ?? agent?.subject
    return reference && (retries.current.has(id) || !known.has(id)) ? [{ id, reference }] : []
  })
  const scope = JSON.stringify(requests.map(({ id, reference }) => [id, referenceKey(reference)]).sort())
  const [reads, setReads] = useState<ReadonlyMap<string, IdentityRead>>(new Map())
  const completed = useRef(new Map<string, IdentityRead>()), pending = useRef(new Map<string, { reference: SessionHistorySourceReference; invalidated: boolean }>())
  const pump = useRef<() => void>(() => {}), owner = useRef(ownerRevision), wasEnabled = useRef(false)
  const ownerToken = useMemo(() => ({}), [enabled, ownerRevision]), currentOwner = useRef<object | null>(ownerToken)
  useLayoutEffect(() => { currentOwner.current = ownerToken; return () => { currentOwner.current = null } }, [ownerToken])
  const [revision, revise] = useState(0)
  const retry = useCallback((id: string) => {
    const read = completed.current.get(id)
    if (!read) return
    retries.current.set(id, read.reference); completed.current.delete(id); revise(value => value + 1)
  }, [])
  useEffect(() => {
    let active = enabled
    if (enabled && !wasEnabled.current) for (const [id, read] of completed.current) if (read.issue) completed.current.delete(id)
    wasEnabled.current = enabled
    if (owner.current !== ownerRevision) { owner.current = ownerRevision; completed.current.clear(); setReads(new Map()) }
    const current = () => enabled && currentOwner.current === ownerToken
    const publish = (id: string, read: IdentityRead) => { if (current()) setReads(previous => new Map(previous).set(id, read)) }
    pump.current = () => {
      if (!active) return
      for (const { id, reference } of requests) {
        if (pending.current.size >= 4) break
        if (completed.current.has(id) || pending.current.has(id)) continue
        const request = { reference, invalidated: false }
        const accepted = () => current() && !request.invalidated
        pending.current.set(id, request); publish(id, { reference, source: null, issue: null, loading: true })
        void api.sessions.historySource(reference).then((result: SessionHistorySourceObservation) => {
          if (referenceKey(result.reference) !== referenceKey(reference) || result.source &&
              (result.source.agentSessionId !== reference.agentSessionId || 'hostId' in reference && result.source.hostId !== reference.hostId)) {
            throw Error('The metadata response belongs to another original identity. Retry this reference.')
          }
          if (!accepted()) return
          const read = { reference, source: result.source, loading: false, issue: result.issue
            ? `${result.issue.message} ${result.issue.recovery}` : result.source ? null : 'This owner has no retained metadata for the referenced Session. The original relation remains available.' }
          retries.current.delete(id); completed.current.set(id, read); publish(id, read)
        }).catch(error => {
          if (!accepted()) return
          const read = { reference, source: null, loading: false, issue: error instanceof Error ? error.message : String(error) }
          retries.current.delete(id); completed.current.set(id, read); publish(id, read)
        }).finally(() => { pending.current.delete(id); pump.current() })
      }
    }
    pump.current()
    return () => { active = false; pump.current = () => {} }
  }, [scope, enabled, ownerRevision, ownerToken, revision])
  useEffect(() => {
    if (!enabled) return
    return api.sessions.onEvent(event => {
      if (event.type !== 'core' || event.event.type !== 'connection-state' || event.event.observationOrigin.boundary !== 'consumer-core') return
      const invalidated = new Set<string>()
      // A pending Runtime reference has no confirmed Host yet. Fence that bounded
      // lookup until its original request settles, then reuse the current demand.
      for (const [id, request] of pending.current) {
        if ('runtimeId' in request.reference || request.reference.hostId === event.hostId) {
          request.invalidated = true; invalidated.add(id)
        }
      }
      for (const [id, read] of completed.current) {
        const runtime = 'runtimeId' in read.reference
        if (runtime && (!read.source || read.source.hostId === event.hostId) || read.issue && event.event.state === 'restored' &&
            'hostId' in read.reference && read.reference.hostId === event.hostId) {
          completed.current.delete(id); invalidated.add(id)
        }
      }
      if (invalidated.size) { setReads(previous => new Map([...previous].filter(([id]) => !invalidated.has(id)))); revise(value => value + 1) }
    })
  }, [enabled])
  return useMemo(() => ({ reads, retry }), [reads, retry])
}

/** Resolve only authoritative exact references, retaining original evidence while joining shared endpoints. */
export function resolveCollaborationIdentities(recorded: { agents: ReadonlyMap<string, CollaborationAgent>; relations: readonly CollaborationRelation[] },
  reads: ReadonlyMap<string, IdentityRead>) {
  const agents = new Map(recorded.agents), sources = new Map<string, AgentSessionHistoryDescriptor>(), aliases = new Map<string, string>()
  for (const [id, read] of reads) {
    const agent = recorded.agents.get(id)
    if (!agent || !read.source) continue
    const source = read.source, subject = { hostId: source.hostId, agentSessionId: source.agentSessionId }, canonical = collaborationSubjectKey(subject)
    aliases.set(id, canonical); sources.set(canonical, source)
    if (id !== canonical) agents.delete(id)
    agents.set(canonical, { ...agent, id: canonical, subject, tier: source.state === 'retired' ? 'closed' : 'unknown',
      ...(source.history ? { providerId: source.history.providerId, executorId: source.history.executorId } : {}),
      provenance: `${source.state === 'retired' ? 'Retired' : 'Retained'} Session · ${source.history?.providerId ?? 'Provider unrecorded'} · ${source.hostId}` })
  }
  const relations = new Map<string, CollaborationRelation>()
  for (const relation of recorded.relations) {
    const source = aliases.get(relation.source) ?? relation.source, target = aliases.get(relation.target) ?? relation.target
    const id = JSON.stringify([relation.kind, source, target]), existing = relations.get(id)
    if (id !== relation.id) aliases.set(relation.id, id)
    if (!existing) relations.set(id, id === relation.id ? relation : { ...relation, id, source, target })
    else { const evidence = new Map([...existing.evidence, ...relation.evidence].map(item => [item.id, item])); relations.set(id, { ...existing, evidence: [...evidence.values()] }) }
  }
  return { agents, relations: [...relations.values()], sources, aliases }
}
