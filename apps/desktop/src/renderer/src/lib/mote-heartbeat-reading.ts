import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteWorkfaceScope } from './mote-workface'
import { moteConnectionTarget } from './mote-connection-default'
import { readMoteQuickTarget, type SavedMoteQuickMode } from './mote-quick-mode'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from './pmo-teams-topic-floating'
import { moteHeartbeatReadingMatchesSource, moteHeartbeatReadingPresentation } from './mote-heartbeat-presentation'
import { validateScheduleRpcResult } from '@agentmux/core/schedule-rpc'
import { api } from './api'
import { parseMoteDialogueResult } from '@agentmux/core/mote-dialogue'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'

type Reading = { saved: SavedMoteQuickMode | null; loading: boolean; unavailable: boolean; issue: string | null; deliveryCue: string | null }
const empty: Reading = { saved: null, loading: false, unavailable: true, issue: null, deliveryCue: null }
export type MoteHeartbeatInspection = { target: MotePreferencesTarget; original?: ContinuousProgressLoop }
export type MoteHeartbeatNoticeReading = Reading & { key: string; target: MotePreferencesTarget; label: string; refresh(): void; inspect(original?: ContinuousProgressLoop): void }
const readers = new Map<string, ReturnType<typeof createReader>>()
const noticeListeners = new Set<() => void>()
let noticeReadings: readonly MoteHeartbeatNoticeReading[] = []
const inspectionListeners = new Set<(intent: MoteHeartbeatInspection) => boolean>()
let inspectionTarget: MoteHeartbeatInspection | null = null
let inspectionGuard: (() => boolean) | null = null

/** Navigation intent only. It never resumes a schedule or submits an Agent input. */
export function requestMoteHeartbeatInspection(target: MotePreferencesTarget, original?: ContinuousProgressLoop) {
  const intent = { target, ...(original ? { original: structuredClone(original) } : {}) }
  inspectionTarget = intent; inspectionGuard = null
  for (const listener of inspectionListeners) if (listener(intent)) { inspectionTarget = null; return true }
  return false
}
export function subscribeMoteHeartbeatInspection(listener: (intent: MoteHeartbeatInspection) => boolean) {
  inspectionListeners.add(listener)
  if (inspectionTarget && inspectionGuard && !inspectionGuard()) { inspectionTarget = null; inspectionGuard = null }
  if (inspectionTarget && listener(inspectionTarget)) { inspectionTarget = null; inspectionGuard = null }
  return () => { inspectionListeners.delete(listener) }
}
function publishNotices() {
  noticeReadings = [...readers.values()].map(reader => reader.notice())
  for (const listener of noticeListeners) listener()
}
/** Aggregates mounted readers only; subscribing here never starts an observation. */
export function useMoteHeartbeatNoticeReadings() {
  return useSyncExternalStore(useCallback(listener => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener) } }, []),
    () => noticeReadings, () => noticeReadings)
}

function createReader(key: string, target: MotePreferencesTarget, initialScope: MoteWorkfaceScope) {
  let scope = initialScope, state = empty, generation = 0, disposed = false, pending: Promise<void> | null = null, requested = false
  let needsSource = true, nextSourceRead = 0, retryDelay = 5000
  let reportPending = false
  let deliveryBaseline: { loopId: string; intentId: string | undefined; through: number } | null = null
  const listeners = new Set<() => void>()
  const publish = (next: Reading) => { state = next; for (const listener of listeners) listener(); publishNotices() }
  function updateDeliveryCue(saved: SavedMoteQuickMode, unavailable: boolean) {
    const maintenance = saved.maintenance, schedule = maintenance?.schedule
    if (unavailable || maintenance?.status !== 'active' || !schedule || saved.defaults.presence?.enabled === false) {
      deliveryBaseline = null
      return null
    }
    const reference = schedule.lastInputRef
    const occurrence = reference && reference.futureIntent.intentId === schedule.futureIntentId ? reference.futureIntent.occurrenceAt : -1
    if (deliveryBaseline?.loopId !== schedule.loopId || deliveryBaseline.intentId !== schedule.futureIntentId) {
      deliveryBaseline = { loopId: schedule.loopId, intentId: schedule.futureIntentId, through: occurrence }
      return null
    }
    if (moteHeartbeatReadingPresentation(saved, false).state !== 'active') return null
    const input = maintenance.input
    if (occurrence <= deliveryBaseline.through || input?.status !== 'confirmed' ||
        (input.delivery !== 'terminal-confirmed' && input.delivery !== 'native-admitted')) return state.deliveryCue
    deliveryBaseline.through = occurrence
    return JSON.stringify([schedule.loopId, schedule.futureIntentId, occurrence])
  }
  function readReports() {
    if (disposed || reportPending || document.hidden || !state.saved?.maintenance?.schedule?.lastInputRef) return
    reportPending = true
    const cut = generation, query = { target, kind: 'heartbeat' as const, limit: 20 }
    void api.moteDialogue.read(query).then(value => {
      const page = parseMoteDialogueResult('space.mote.dialogue.read', value, query)
      if (!disposed && cut === generation && state.saved) publish({ ...state, saved: { ...state.saved, reports: { page, issue: page.sourceIssue } } })
    }).catch(error => {
      if (!disposed && cut === generation && state.saved) publish({ ...state, saved: { ...state.saved, reports: { page: state.saved.reports?.page ?? null, issue: presentError(error) } } })
    }).finally(() => { reportPending = false })
  }
  function read() {
    if (disposed || document.hidden) return
    if (pending) { requested = true; return }
    const original = state.saved, schedule = original?.maintenance?.schedule, full = needsSource
    if (!full && !schedule) return
    const cut = generation
    let sourceChanged = false
    publish({ ...state, loading: true })
    pending = Promise.resolve().then(async () => {
      const selected = full ? await readMoteQuickTarget(target, false) : original!
      const selectedSchedule = selected.maintenance?.schedule
      if (!selectedSchedule) return selected
      const input = { scheduleId: selectedSchedule.loopId }
      const result = validateScheduleRpcResult('schedule.inspect', await api.schedule.inspect(input, target.expectedResource.hostId), input)
      const record = result.schedule
      if (!record || (['hostId', 'agentSessionId', 'providerId', 'workspacePath'] as const).some(field => record[field] !== selectedSchedule[field]))
        throw Error('The original heartbeat arrangement is not confirmed. Its last reading and input are kept.')
      const adoption = record.guidanceAdoptions?.find(value => value.newDefinition.intentId === record.futureIntentId)
      const selectedAdoption = selectedSchedule.guidanceAdoptions?.find(value => value.newDefinition.intentId === selectedSchedule.futureIntentId)
      sourceChanged = record.revision !== selectedSchedule.revision || record.futureIntentId !== selectedSchedule.futureIntentId ||
        adoption?.operationId !== selectedAdoption?.operationId || adoption?.state !== selectedAdoption?.state ||
        record.status === 'stopped' && selectedSchedule.status !== 'stopped' ||
        record.pause?.reason === 'source-changed' && selectedSchedule.pause?.reason !== 'source-changed' ||
        record.managedSource?.revision !== selectedSchedule.managedSource?.revision || record.managedSource?.sourceId !== selectedSchedule.managedSource?.sourceId
      const { input: _previous, ...maintenance } = selected.maintenance!
      return { ...selected, ...(state.saved?.reports ? { reports: state.saved.reports } : {}), maintenance: { ...maintenance, schedule: record, ...(result.input ? { input: result.input } : {}),
        status: maintenance.status === 'active' || maintenance.status === 'paused'
          ? record.status === 'active' ? 'active' as const : 'paused' as const : maintenance.status } }
    }).then(saved => {
      if (!disposed && cut === generation && !document.hidden) {
        const unavailable = Boolean(sourceChanged || saved.issue || !saved.maintenance || saved.maintenance.status === 'unconfirmed' || !moteHeartbeatReadingMatchesSource(saved))
        if (full) { needsSource = unavailable; nextSourceRead = Date.now() + retryDelay; retryDelay = unavailable ? Math.min(30000, retryDelay * 2) : 5000 }
        if (sourceChanged) { needsSource = true; requested = true }
        publish({ saved: unavailable && state.saved ? state.saved : saved, loading: false, deliveryCue: updateDeliveryCue(saved, unavailable),
          unavailable, issue: sourceChanged ? 'The original arrangement changed. Reading this Mote’s current heartbeat.' : saved.issue ?? saved.maintenance?.issue ?? null })
        readReports()
      }
    }).catch(error => {
      if (!disposed && cut === generation && !document.hidden) {
        if (full) { nextSourceRead = Date.now() + retryDelay; retryDelay = Math.min(30000, retryDelay * 2) }
        deliveryBaseline = null
        publish({ ...state, loading: false, unavailable: true, issue: presentError(error), deliveryCue: null })
      }
    }).finally(() => {
      pending = null
      if (!disposed && requested) { requested = false; read() }
    })
  }
  const refresh = () => { needsSource = true; generation++; read() }
  const foreground = () => { generation++; deliveryBaseline = null; if (!document.hidden) { needsSource = true; read() } }
  document.addEventListener('visibilitychange', foreground)
  const timer = window.setInterval(() => { if (!pending && (!needsSource || Date.now() >= nextSourceRead)) read() }, 5000)
  return {
    listeners, snapshot: () => state, refresh,
    notice: (): MoteHeartbeatNoticeReading => ({ key, target, label: scope.topic.title, ...state, refresh,
      inspect: original => {
        if (requestMoteHeartbeatInspection(target, original)) return
        const pending = inspectionTarget
        requestPmoTeamsTopicFloatingOpen({ targetTopicId: scope.topic.id })
        const entry = readPmoTeamsTopicFloatingState()?.conversationEntry
        if (inspectionTarget === pending) inspectionGuard = () => {
          const current = readPmoTeamsTopicFloatingState()
          return Boolean(current?.open && current.conversationEntry === entry && current.targetTopicId === scope.topic.id)
        }
      } }),
    update(next: MoteWorkfaceScope) {
      const renamed = scope.topic.title !== next.topic.title, changed = quickRevision(scope) !== quickRevision(next)
      scope = next
      if (changed) {
        deliveryBaseline = null
        publish({ ...state, unavailable: true, deliveryCue: null, issue: 'The original settings changed. Reading this revision before confirming automatic care.' })
        refresh()
      }
      else if (renamed) publishNotices()
    },
    start: read,
    dispose() { disposed = true; generation++; window.clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }
}

function quickRevision(scope: MoteWorkfaceScope) {
  const quick = scope.topic.quickMode
  return quick?.status === 'saved' ? quick.version : quick?.status === 'unconfirmed' ? quick.message : undefined
}

/** Temporary shared reads of the exact public Mote resource. No execution or durable status lives here. */
export function useMoteHeartbeatReading(scope: MoteWorkfaceScope | null, active: boolean) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = useMemo(() => scope ? moteConnectionTarget(scope, bindings) : null, [scope, bindings])
  const key = active && target ? JSON.stringify(target) : ''
  const currentScope = useRef(scope); currentScope.current = scope
  const subscribe = useCallback((listener: () => void) => {
    if (!key || !currentScope.current) return () => {}
    let reader = readers.get(key)
    const first = !reader
    if (!reader) { reader = createReader(key, JSON.parse(key), currentScope.current); readers.set(key, reader) }
    reader.listeners.add(listener)
    if (first) { publishNotices(); reader.start() }
    return () => {
      reader.listeners.delete(listener)
      if (!reader.listeners.size) { reader.dispose(); if (readers.get(key) === reader) readers.delete(key); publishNotices() }
    }
  }, [key])
  const snapshot = useCallback(() => readers.get(key)?.snapshot() ?? empty, [key])
  const reading = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => { if (scope) readers.get(key)?.update(scope) }, [key, scope])
  return { ...reading, target, refresh: useCallback(() => readers.get(key)?.refresh(), [key]) }
}
