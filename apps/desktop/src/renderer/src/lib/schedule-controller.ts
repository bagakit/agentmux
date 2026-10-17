import { useCallback, useEffect, useRef, useState } from 'react'
import { isAgentSchedule, type ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { ScheduleParamsMap } from '@agentmux/core'
import { validateScheduleRpcResult } from '@agentmux/core/schedule-rpc'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from './api'
import { useLauncherState } from './launcher-state'
import type { ScheduleRequest } from './schedule-draft'

export type ScheduleQuery = ScheduleParamsMap['schedule.list']
export function matchesScheduleQuery(schedule: ContinuousProgressLoop, query: ScheduleQuery): boolean {
  if (!isAgentSchedule(schedule)) return false
  const target = query.target ?? query.scope
  return !target || Object.entries(target).every(([key, value]) => schedule[key as keyof ContinuousProgressLoop] === value)
}
function mergeSchedules(previous: readonly ContinuousProgressLoop[], incoming: readonly ContinuousProgressLoop[]) {
  const result = new Map(previous.map(record => [record.loopId, record]))
  for (const record of incoming) {
    const held = result.get(record.loopId)
    if (!held || (record.revision ?? 0) > (held.revision ?? 0) ||
      record.revision === held.revision && (record.lastTickAt ?? 0) >= (held.lastTickAt ?? 0)) result.set(record.loopId, record)
  }
  return [...result.values()]
}

/** Local reading projection over the original owner; no independent schedule Store. */
export function useScheduleRecords(queries: readonly ScheduleQuery[], enabled: boolean) {
  const key = JSON.stringify(queries), current = useRef(key); current.current = key
  const reading = useRef<{ key: string; concurrent: ContinuousProgressLoop[] } | null>(null)
  const [held, setHeld] = useState<{ key: string; records: ContinuousProgressLoop[]; observed: boolean; error?: string | undefined }>({ key, records: [], observed: false })
  const [refresh, setRefresh] = useState(0)
  const accept = useCallback((record: ContinuousProgressLoop) => {
    const scope = JSON.parse(key) as ScheduleQuery[]
    if (!scope.some(query => matchesScheduleQuery(record, query))) throw new Error('The Host returned another arrangement target. Original input is kept.')
    if (reading.current?.key === key) reading.current.concurrent = mergeSchedules(reading.current.concurrent, [record])
    if (current.current === key) setHeld(previous => ({ ...previous, key, records: mergeSchedules(previous.key === key ? previous.records : [], [record]) }))
  }, [key])
  useEffect(() => {
    if (!enabled || !queries.length) return
    let alive = true
    const read = { key, concurrent: [] as ContinuousProgressLoop[] }; reading.current = read
    setHeld(previous => previous.key === key ? { ...previous, error: undefined } : { key, records: [], observed: false })
    const dispose = api.schedule.onChanged(record => {
      if (alive && queries.some(query => matchesScheduleQuery(record, query))) accept(record)
    })
    void Promise.all(queries.map(query => api.schedule.list(query))).then(results => {
      if (!alive || current.current !== key) return
      const records = results.flatMap((result, index) => {
        if (!result.schedules.every(record => matchesScheduleQuery(record, queries[index]!))) throw new Error('The Host returned arrangements outside this original scope.')
        return result.schedules
      })
      // A fresh snapshot supersedes old equal-version cache; only observations
      // concurrent with this read can supersede the snapshot on an equal version.
      setHeld(previous => ({ key, records: mergeSchedules(mergeSchedules(previous.key === key ? previous.records : [], records), read.concurrent), observed: true }))
      if (reading.current === read) reading.current = null
    }).catch(error => {
      if (alive && current.current === key) setHeld(previous => ({ ...previous, key, error: presentError(error) }))
    })
    return () => { alive = false; dispose(); if (reading.current === read) reading.current = null }
  // The serialized query is the exact immutable observation scope.
  }, [key, enabled, refresh, accept])
  return { records: held.key === key ? held.records : [], observed: held.key === key && held.observed,
    error: held.key === key ? held.error : undefined, accept, refresh: () => setRefresh(value => value + 1) }
}

function sameRequest(a: ScheduleRequest | undefined, b: ScheduleRequest) {
  return a?.action === b.action && a.params.operationId === b.params.operationId
}
function requestMatches(request: ScheduleRequest, record: ContinuousProgressLoop): boolean {
  if (request.action === 'create') return record.creationOperationId === request.params.operationId &&
    record.prompt === request.params.prompt && matchesScheduleQuery(record, { target: request.params.target })
  return record.loopId === request.params.scheduleId && record.lastMutation?.operationId === request.params.operationId &&
    record.lastMutation.action === request.action && record.lastMutation.expectedRevision === request.params.expectedRevision &&
    record.revision === request.params.expectedRevision + 1 &&
    record.status === (request.action === 'resume' ? 'active' : request.action === 'pause' ? 'paused' : 'stopped')
}

/** One original UI operation per arrangement/form. Unknown work never blocks other rows. */
export function useScheduleOperation(draftKey: string, accept: (record: ContinuousProgressLoop) => void,
  onConfirmed?: (record: ContinuousProgressLoop, request: ScheduleRequest) => void) {
  const pending = useLauncherState(state => state.drafts[draftKey]?.schedule?.pending)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [busyKey, setBusyKey] = useState<string>(), [issue, setIssue] = useState<{ key: string; message: string }>()
  const alive = useRef(true), flight = useRef<{ key: string } | null>(null), current = useRef(draftKey); current.current = draftKey
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const remember = (request: ScheduleRequest) => useLauncherState.getState().setScheduleDraft(draftKey, { pending: request })
  const isCurrent = () => alive.current && current.current === draftKey
  const setError = (message: string | undefined) => { if (isCurrent()) setIssue(message ? { key: draftKey, message } : undefined) }
  const finish = (request: ScheduleRequest) => {
    if (sameRequest(useLauncherState.getState().drafts[draftKey]?.schedule?.pending, request))
      useLauncherState.getState().setScheduleDraft(draftKey, { pending: undefined })
  }
  async function perform(request: ScheduleRequest): Promise<ContinuousProgressLoop | null> {
    const original = useLauncherState.getState().drafts[draftKey]?.schedule?.pending
    if (flight.current?.key === draftKey || original && !sameRequest(original, request)) return null
    const token = { key: draftKey }; flight.current = token; setBusyKey(draftKey); setError(undefined); remember(request)
    try {
      const receipt = request.action === 'create' ? await api.schedule.create(request.params)
        : await api.schedule[request.action](request.params)
      validateScheduleRpcResult(`schedule.${request.action}`, receipt, request.params)
      if (isCurrent()) accept(receipt.schedule)
      onConfirmed?.(receipt.schedule, request)
      finish(request)
      return receipt.schedule
    } catch (failure) { setError(presentError(failure)); return null }
    finally { if (flight.current === token) { flight.current = null; if (isCurrent()) setBusyKey(undefined) } }
  }
  async function inspect() {
    const request = useLauncherState.getState().drafts[draftKey]?.schedule?.pending
    if (!request || flight.current?.key === draftKey) return
    const token = { key: draftKey }; flight.current = token; setBusyKey(draftKey)
    try {
      const receipt = await api.schedule.inspect({ operationId: request.params.operationId })
      const sameIdentity = receipt.schedule && (request.action === 'create'
        ? receipt.schedule.creationOperationId === request.params.operationId && matchesScheduleQuery(receipt.schedule, { target: request.params.target })
        : receipt.schedule.loopId === request.params.scheduleId)
      if (sameIdentity && isCurrent()) accept(receipt.schedule!)
      // Inspection reports current facts, not the durable confirmation of a past write.
      setError(sameIdentity && requestMatches(request, receipt.schedule!)
        ? 'The Host now shows the requested state. The original save receipt is still unconfirmed; retry retains the same operation.'
        : 'The original operation is still unconfirmed. Its request and saved arrangement are kept.')
    } catch (failure) { setError(presentError(failure)) }
    finally { if (flight.current === token) { flight.current = null; if (isCurrent()) setBusyKey(undefined) } }
  }
  return { pending, busy: busyKey === draftKey, error: (issue?.key === draftKey ? issue.message : undefined) ?? persistenceIssue ?? undefined, perform, inspect }
}
