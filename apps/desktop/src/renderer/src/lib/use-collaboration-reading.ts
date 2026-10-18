import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxRpcResult, AgentMuxMessageEvent } from '@agentmux/core'
import { api } from './api'
import { collaborationSubjectKey, type CollaborationReading, type CollaborationSubject } from './agent-collaboration'
import { COLLABORATION_ACTIVITY_MS } from './collaboration-map-presentation'

type Events = AgentMuxRpcResult<'message.events'>
type Spawns = AgentMuxRpcResult<'agent.spawn.ls'>
export type CollaborationSource = CollaborationReading & {
  loading: readonly string[]; issues: Record<string, string>; observationIssue: string | null
  history?: { before: number | null; through: number; incarnation: string }
  updates?: { after: number; through?: number; more: boolean }
  spawnCreated?: Spawns; spawnCreator?: Spawns
}
const empty = (subject: CollaborationSubject): CollaborationSource => ({ subject, incarnation: null, events: [], spawns: [], loading: [], issues: {}, observationIssue: 'Automatic updates are unconfirmed. Refresh the original source.' })
/** Original pages are sorted; merging copies references without decoding or sorting old rows. */
function mergeEvents(previous: readonly AgentMuxMessageEvent[], incoming: readonly AgentMuxMessageEvent[]) {
  if (!incoming.length) return previous
  const result: AgentMuxMessageEvent[] = [], page = [...incoming].sort((a, b) => a.sequence - b.sequence)
  if (!previous.length || previous[previous.length - 1]!.sequence < page[0]!.sequence) return [...previous, ...page]
  if (page[page.length - 1]!.sequence < previous[0]!.sequence) return [...page, ...previous]
  let old = 0, next = 0
  while (old < previous.length && next < page.length) result.push(previous[old]!.sequence < page[next]!.sequence ? previous[old++]! : page[next++]!)
  return [...result, ...previous.slice(old), ...page.slice(next)]
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
type Action = 'refresh' | 'updates' | 'resume' | 'earlier' | 'created'
export type CollaborationPulse = { id: number; startedAt: number; hostId: string; sender: string; recipient: string; kind: 'communication' | 'supervision' }

/** Observe existing typed notifications independently of history/body demand. No reads or traffic are created here. */
function useCollaborationActivity(scope: { current: ReadonlySet<string> }, enabled: boolean) {
  const latestScope = useRef(scope); latestScope.current = scope
  const [pulses, setPulses] = useState<CollaborationPulse[]>([])
  const activity = useRef({ through: new Map<string, number>(), sequence: 0, pulses: [] as CollaborationPulse[] })
  const expire = useRef<() => void>(() => {})
  const resetHost = useCallback((hostId: string) => {
    activity.current.through.delete(hostId)
    activity.current.pulses = activity.current.pulses.filter(pulse => pulse.hostId !== hostId)
    expire.current()
  }, [])
  useEffect(() => {
    if (!enabled) { activity.current.pulses = []; setPulses([]); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    function flush() {
      clearTimeout(timer)
      const current = activity.current
      current.pulses = current.pulses.filter(pulse => pulse.startedAt + COLLABORATION_ACTIVITY_MS > Date.now())
      setPulses(current.pulses)
      if (current.pulses.length) timer = setTimeout(flush, Math.max(1, current.pulses[0]!.startedAt + COLLABORATION_ACTIVITY_MS - Date.now()))
    }
    expire.current = flush; flush()
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => {
      if (event.type === 'agent-message-observation' && event.state !== 'available') { resetHost(hostId); return }
      if (event.type !== 'agent-message-changed' || !event.live || event.recordKind !== 'message' && !event.recordKind.startsWith('dispatch-')) return
      const known = latestScope.current.current
      if (!known.has(collaborationSubjectKey({ hostId, agentSessionId: event.senderSessionId })) && !known.has(collaborationSubjectKey({ hostId, agentSessionId: event.recipientSessionId }))) return
      const current = activity.current
      if (event.sequence <= (current.through.get(hostId) ?? 0)) return
      current.through.set(hostId, event.sequence)
      current.pulses = [...current.pulses.slice(-15), { id: ++current.sequence, startedAt: Date.now(), hostId,
        sender: event.senderSessionId, recipient: event.recipientSessionId, kind: event.recordKind === 'message' ? 'communication' : 'supervision' }]
      flush()
    })
    return () => { expire.current = () => {}; clearTimeout(timer); unsubscribe() }
  }, [enabled, resetHost])
  return { pulses, resetHost }
}

/** A visible reading window, never a second queue. Every fetch is scoped to requested participants. */
export function useCollaborationReading(subjects: readonly CollaborationSubject[], enabled: boolean, activityScope: { current: ReadonlySet<string> }) {
  const activity = useCollaborationActivity(activityScope, enabled)
  const scope = JSON.stringify(subjects.map(collaborationSubjectKey).sort())
  const [sources, setSources] = useState<Record<string, CollaborationSource>>({})
  const [facts, setFacts] = useState<readonly CollaborationReading[]>([])
  const metadata = useRef(new Map<string, CollaborationReading>())
  const eventIndexes = useRef(new Map<string, { incarnation: string; events: Map<number, AgentMuxMessageEvent> }>())
  const spawnIndexes = useRef(new Map<string, Map<string, CollaborationReading['spawns'][number]>>())
  const previousActive = useRef(new Set<string>())
  const generation = useRef(0), state = useRef(sources), wasEnabled = useRef(false), observedThrough = useRef(new Map<string, number>())
  const runner = useRef<(key: string, action: Action) => void>(() => {})
  useEffect(() => {
    const token = ++generation.current, restarting = !wasEnabled.current
    wasEnabled.current = enabled
    if (!enabled) return
    const originals = new Map(subjects.map(subject => [collaborationSubjectKey(subject), subject]))
    const previousSources = state.current, entering = new Set([...originals.keys()].filter(key => !previousActive.current.has(key)))
    previousActive.current = new Set(originals.keys())
    // Demand controls IO. Already-read windows belong to this map lifetime, including offscreen subjects.
    const held = { ...previousSources }
    for (const [key, source] of Object.entries(held)) if (source.loading.length) held[key] = { ...source, loading: [] }
    for (const [key, subject] of originals) if (!held[key]) held[key] = empty(subject)
    state.current = held; setSources(held)
    const pending = new Set<string>(), wanted = observedThrough.current
    for (const key of wanted.keys()) if (!originals.has(key)) wanted.delete(key)
    const current = () => token === generation.current
    function patch(key: string, update: (source: CollaborationSource) => CollaborationSource) {
      if (!current() || !state.current[key]) return
      const previous = state.current[key]!, next = update(previous)
      if (next === previous) return
      state.current = { ...state.current, [key]: next }; setSources(state.current)
      const fact = metadata.current.get(key)
      if (!fact || fact.incarnation !== next.incarnation || fact.events !== next.events || fact.spawns !== next.spawns) {
        metadata.current.set(key, { subject: next.subject, incarnation: next.incarnation, events: next.events, spawns: next.spawns, changes: next.changes })
        setFacts([...metadata.current.values()])
      }
    }
    async function read<T>(key: string, lane: string, fetch: () => Promise<T>, apply: (source: CollaborationSource, page: T) => CollaborationSource) {
      const operation = JSON.stringify([key, lane])
      if (pending.has(operation)) return
      pending.add(operation)
      patch(key, source => ({ ...source, loading: [...source.loading, lane], issues: Object.fromEntries(Object.entries(source.issues).filter(([name]) => name !== lane)) }))
      let succeeded = false
      try { const page = await fetch(); patch(key, source => apply(source, page)); succeeded = true }
      catch (error) { patch(key, source => ({ ...source, issues: { ...source.issues, [lane]: reason(error) } })) }
      finally {
        pending.delete(operation); patch(key, source => ({ ...source, loading: source.loading.filter(name => name !== lane) }))
        if (current() && succeeded && lane === 'events' && (state.current[key]?.updates?.more || (state.current[key]?.updates?.after ?? 0) < (wanted.get(key) ?? 0))) queueMicrotask(() => run(key, 'updates'))
      }
    }
    function run(key: string, action: Action) {
      const subject = originals.get(key), source = state.current[key]
      if (!current() || !subject || !source) return
      const jobs: Promise<void>[] = []
      if (action === 'refresh' || action === 'updates' || action === 'resume' || action === 'earlier') {
        if (action === 'earlier' && !source.history?.before) return
        const options = action === 'earlier' ? { beforeSequence: source.history!.before!, throughSequence: source.history!.through, incarnation: source.history!.incarnation, limit: 50 }
          : (action === 'updates' || action === 'resume') && source.updates && source.incarnation ? { afterSequence: source.updates.after, incarnation: source.incarnation,
            ...(source.updates.through === undefined ? {} : { throughSequence: source.updates.through }), limit: 50 }
            : { latest: true as const, limit: 50 }
        jobs.push(read<Events>(key, 'events', () => api.sessions.messageEvents(subject, options), (previous, page) => {
          if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId) throw new Error('The original message Host or participant did not match.')
          const latest = 'latest' in options
          if (latest && previous.incarnation !== null && previous.incarnation !== page.incarnation) {
            wanted.delete(key); activity.resetHost(subject.hostId)
          }
          if (!latest && previous.incarnation !== page.incarnation) throw new Error('The original journal identity changed. Refresh this source to read its current window.')
          let index = eventIndexes.current.get(key)
          const reset = previous.incarnation !== page.incarnation
          if (!index || index.incarnation !== page.incarnation) { index = { incarnation: page.incarnation, events: new Map() }; eventIndexes.current.set(key, index) }
          const incoming: AgentMuxMessageEvent[] = []
          for (const event of page.events) if (!index.events.has(event.sequence)) { index.events.set(event.sequence, event); incoming.push(event) }
          const events = mergeEvents(reset ? [] : previous.events, incoming)
          return { ...previous, incarnation: page.incarnation, events,
            changes: incoming.length || reset ? { previous: reset ? undefined : previous.changes, events: incoming, spawns: [] } : previous.changes,
            ...(latest ? { history: { before: page.nextBeforeSequence, through: page.throughSequence, incarnation: page.incarnation }, updates: { after: page.throughSequence, more: false } }
              : action === 'earlier' ? { history: { before: page.nextBeforeSequence, through: page.throughSequence, incarnation: page.incarnation } }
                : { updates: { after: page.nextAfterSequence ?? page.throughSequence, more: page.nextAfterSequence !== null, ...(page.nextAfterSequence === null ? {} : { through: page.throughSequence }) } }) }
        }))
      }
      if (action === 'refresh' || action === 'resume' || action === 'created') {
        const cursor = action === 'created' ? source.spawnCreated?.nextCursor : undefined
        if (action === 'created' && !cursor) return
        for (const direction of action === 'created' ? ['created'] as const : ['created', 'creator'] as const) {
          jobs.push(read<Spawns>(key, direction, () => api.sessions.spawns(subject, { direction, limit: 25, ...(cursor ? { cursor } : {}) }), (previous, page) => {
            if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId || page.direction !== direction) throw new Error('The original creation source did not match.')
            let records = spawnIndexes.current.get(key)
            if (!records) { records = new Map(); spawnIndexes.current.set(key, records) }
            const changed: CollaborationReading['spawns'][number][] = []
            for (const record of page.records) if (JSON.stringify(records.get(record.agentSessionId)) !== JSON.stringify(record)) { records.set(record.agentSessionId, record); changed.push(record) }
            return { ...previous, spawns: changed.length ? [...records.values()] : previous.spawns,
              changes: changed.length ? { previous: previous.changes, events: [], spawns: changed } : previous.changes,
              [direction === 'created' ? 'spawnCreated' : 'spawnCreator']: page }
          }))
        }
      }
      return Promise.allSettled(jobs)
    }
    runner.current = run
    // Independent slots keep a slow Host from holding completed readers behind a batch barrier.
    const queue = [...originals.keys()].filter(key => restarting || entering.has(key) || !held[key]?.history || !held[key]?.spawnCreated || !held[key]?.spawnCreator || Boolean(previousSources[key]?.loading.length))
    async function initialize() {
      async function worker() {
        while (current() && queue.length) { const key = queue.shift()!; await run(key, held[key]?.history ? restarting || entering.has(key) || !held[key]?.spawnCreated || !held[key]?.spawnCreator || previousSources[key]?.loading.some(lane => lane !== 'events') ? 'resume' : 'updates' : 'refresh') }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    }
    void initialize()
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => {
      if (!current()) return
      if (event.type === 'agent-message-observation') {
        for (const [key, subject] of originals) if (subject.hostId === hostId) patch(key, source => { const issue = event.state === 'available' ? null : event.message ?? 'Automatic updates are unavailable. Refresh the original source.'; return source.observationIssue === issue ? source : { ...source, observationIssue: issue } })
      }
      if (event.type !== 'agent-message-changed') return
      const matching = [...originals].filter(([, subject]) => subject.hostId === hostId && (subject.agentSessionId === event.senderSessionId || subject.agentSessionId === event.recipientSessionId))
      if (!matching.length) return
      for (const [key] of matching) { wanted.set(key, Math.max(wanted.get(key) ?? 0, event.sequence)); run(key, 'updates') }

    })
    return () => { ++generation.current; runner.current = () => {}; unsubscribe() }
  }, [scope, enabled])
  const act = useCallback((subject: CollaborationSubject, action: Action) => runner.current(collaborationSubjectKey(subject), action), [])
  const active = useMemo(() => new Set(subjects.map(collaborationSubjectKey)), [scope])
  const visibleSources = useMemo(() => Object.entries(sources).filter(([key]) => active.has(key)).map(([, source]) => source), [sources, active])
  return { sources: visibleSources, facts, pulses: enabled ? activity.pulses : [], act }
}
