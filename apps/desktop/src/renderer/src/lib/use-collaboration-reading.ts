import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult, AgentMuxMessageEvent } from '@agentmux/core'
import { api } from './api'
import { collaborationSubjectKey, type CollaborationReading, type CollaborationSubject } from './agent-collaboration'

type Events = AgentMuxRpcResult<'message.events'>
type Spawns = AgentMuxRpcResult<'agent.spawn.ls'>
export type CollaborationSource = CollaborationReading & {
  loading: readonly string[]; issues: Record<string, string>; observationIssue: string | null
  history?: { before: number | null; through: number; incarnation: string }
  updates?: { after: number; through?: number; more: boolean }
  spawnCreated?: Spawns; spawnCreator?: Spawns
}
const empty = (subject: CollaborationSubject): CollaborationSource => ({ subject, incarnation: null, events: [], spawns: [], loading: [], issues: {}, observationIssue: 'Automatic updates are unconfirmed. Refresh the original source.' })
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
type Action = 'refresh' | 'updates' | 'resume' | 'earlier' | 'created'
export type CollaborationPulse = { id: number; startedAt: number; hostId: string; sender: string; recipient: string; kind: 'communication' | 'supervision' }

/** A visible reading window, never a second queue. Every fetch is scoped to requested participants. */
export function useCollaborationReading(subjects: readonly CollaborationSubject[], enabled: boolean) {
  const scope = JSON.stringify(subjects.map(collaborationSubjectKey).sort())
  const [sources, setSources] = useState<Record<string, CollaborationSource>>({})
  const [pulses, setPulses] = useState<CollaborationPulse[]>([])
  const generation = useRef(0), state = useRef(sources), wasEnabled = useRef(false), observedThrough = useRef(new Map<string, number>())
  const runner = useRef<(key: string, action: Action) => void>(() => {})
  useEffect(() => {
    const token = ++generation.current, restarting = !wasEnabled.current
    wasEnabled.current = enabled
    if (!enabled) return
    const originals = new Map(subjects.map(subject => [collaborationSubjectKey(subject), subject]))
    const previousSources = state.current
    const held: Record<string, CollaborationSource> = Object.fromEntries([...originals].map(([key, subject]) => [key, state.current[key] ? { ...state.current[key]!, loading: [] } : empty(subject)]))
    state.current = held; setSources(held); setPulses([])
    const pending = new Set<string>(), wanted = observedThrough.current, pulseThrough = new Map<string, number>()
    for (const key of wanted.keys()) if (!originals.has(key)) wanted.delete(key)
    let pulseSequence = 0, pulseTimer: ReturnType<typeof setTimeout> | undefined
    let livePulses: CollaborationPulse[] = []
    const current = () => token === generation.current
    function expirePulses() {
      clearTimeout(pulseTimer)
      if (!current()) return
      livePulses = livePulses.filter(pulse => pulse.startedAt + 1800 > Date.now())
      setPulses(livePulses)
      if (livePulses.length) pulseTimer = setTimeout(expirePulses, Math.max(1, livePulses[0]!.startedAt + 1800 - Date.now()))
    }
    function patch(key: string, update: (source: CollaborationSource) => CollaborationSource) {
      if (!current() || !state.current[key]) return
      const previous = state.current[key]!, next = update(previous)
      if (next === previous) return
      state.current = { ...state.current, [key]: next }; setSources(state.current)
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
        if (current() && succeeded && lane === 'events' && (state.current[key]?.updates?.after ?? 0) < (wanted.get(key) ?? 0)) queueMicrotask(() => run(key, 'updates'))
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
            wanted.delete(key); pulseThrough.delete(subject.hostId); livePulses = livePulses.filter(pulse => pulse.hostId !== subject.hostId); expirePulses()
          }
          if (!latest && previous.incarnation !== page.incarnation) throw new Error('The original journal identity changed. Refresh this source to read its current window.')
          const events = new Map<number, AgentMuxMessageEvent>((latest && previous.incarnation !== page.incarnation ? [] : previous.events).map(event => [event.sequence, event]))
          for (const event of page.events) events.set(event.sequence, event)
          return { ...previous, incarnation: page.incarnation, events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
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
            const records = new Map(previous.spawns.map(record => [record.agentSessionId, record]))
            for (const record of page.records) records.set(record.agentSessionId, record)
            return { ...previous, spawns: [...records.values()], [direction === 'created' ? 'spawnCreated' : 'spawnCreator']: page }
          }))
        }
      }
      return Promise.allSettled(jobs)
    }
    runner.current = run
    // Independent slots keep a slow Host from holding completed readers behind a batch barrier.
    const queue = [...originals.keys()].filter(key => restarting || !held[key]?.history || !held[key]?.spawnCreated || !held[key]?.spawnCreator || Boolean(previousSources[key]?.loading.length))
    async function initialize() {
      async function worker() {
        while (current() && queue.length) { const key = queue.shift()!; await run(key, held[key]?.history ? restarting || previousSources[key]?.loading.some(lane => lane !== 'events') ? 'resume' : 'updates' : 'refresh') }
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
      if (event.live && event.sequence > (pulseThrough.get(hostId) ?? 0) && (event.recordKind === 'message' || event.recordKind.startsWith('dispatch-'))) {
        pulseThrough.set(hostId, event.sequence)
        const id = ++pulseSequence
        livePulses = [...livePulses.slice(-15), { id, startedAt: Date.now(), hostId, sender: event.senderSessionId, recipient: event.recipientSessionId, kind: event.recordKind === 'message' ? 'communication' : 'supervision' }]
        expirePulses()
      }
    })
    return () => { ++generation.current; runner.current = () => {}; clearTimeout(pulseTimer); unsubscribe() }
  }, [scope, enabled])
  const act = useCallback((subject: CollaborationSubject, action: Action) => runner.current(collaborationSubjectKey(subject), action), [])
  return { sources: Object.values(sources).filter(source => subjects.some(subject => collaborationSubjectKey(subject) === collaborationSubjectKey(source.subject))), pulses: enabled ? pulses : [], act }
}
