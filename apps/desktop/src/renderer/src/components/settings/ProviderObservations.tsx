import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { HostAgentResourceObservation } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import './provider-observations.css'

type Reading = 'loading' | 'ready' | 'stale' | 'unavailable'
type AgentResource = HostAgentResourceObservation['kind']
type ExecutorCounts = {
  countsByProvider: ReadonlyMap<string, number>
  total: number
  defaults: number
  observedAt: number
}
type RecordCounts = { saved: number; retired: number; observedAt: number }
type RunningCount = { count: number; observedAt: number; nativeObservedAt: number }
type SourceRead<T> = {
  host: HostConfig
  busy: boolean
  confirmed?: T | undefined
  owner?: string | undefined
  error?: string | undefined
}
type SourceResult<T> = Pick<SourceRead<T>, 'owner' | 'error'> & { value?: T }
export type ProviderObservationSnapshot = {
  executorState: Reading
  executors?: ExecutorCounts | undefined
  executorRead?: SourceRead<ExecutorCounts> | undefined
  records?: SourceRead<RecordCounts> | undefined
  running?: SourceRead<RunningCount> | undefined
}

function readState(read?: SourceRead<unknown>): Reading {
  if (!read || read.busy) return 'loading'
  if (!read.confirmed) return 'unavailable'
  return read.error ? 'stale' : 'ready'
}

function recordSource(observation: HostAgentResourceObservation, hostId: string, kind: 'records'): SourceResult<RecordCounts>
function recordSource(observation: HostAgentResourceObservation, hostId: string, kind: 'running'): SourceResult<RunningCount>
function recordSource(observation: HostAgentResourceObservation, hostId: string, kind: AgentResource): SourceResult<RecordCounts | RunningCount> {
  if (observation.routeHostId !== hostId || observation.kind !== kind) {
    return { error: 'This Session measurement belongs to another Host or source.' }
  }
  const owner = observation.owner.state === 'available'
    ? JSON.stringify([observation.owner.value.runtimeId, observation.owner.value.ownerInstanceId])
    : undefined
  return observation.measurement.state === 'available'
    ? { owner, value: observation.measurement.value }
    : { owner, error: observation.measurement.message }
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

/** Three independent reads for this visible, saved Host. Each refresh retires only its previous observation. */
export function useProviderObservations(host: HostConfig | undefined, active: boolean, refresh: number): ProviderObservationSnapshot {
  const [executorRead, setExecutors] = useState<SourceRead<ExecutorCounts>>()
  const [records, setRecords] = useState<SourceRead<RecordCounts>>()
  const [running, setRunning] = useState<SourceRead<RunningCount>>()
  const [visible, setVisible] = useState(pageVisible)

  useEffect(() => {
    if (!active) return
    const changed = () => setVisible(pageVisible())
    changed()
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [active])

  useEffect(() => {
    if (!host || !active || !visible || !pageVisible()) return
    const controller = new AbortController()
    const { signal } = controller
    const runtimeId = host.kind === 'ssh' ? host.runtimeId : undefined

    async function read<T>(target: HostConfig, set: Dispatch<SetStateAction<SourceRead<T> | undefined>>, get: () => Promise<SourceResult<T>>) {
      set(previous => ({ ...(previous?.host === target ? previous : undefined), host: target, busy: true }))
      let result: SourceResult<T>
      try { result = await get() }
      catch (cause) { result = { error: presentError(cause) } }
      if (signal.aborted) return
      set(previous => {
        if (signal.aborted) return previous
        const retained = previous?.host === target ? previous : undefined
        const ownerChanged = result.owner !== undefined && retained?.owner !== undefined && result.owner !== retained.owner
        return { host: target, busy: false, error: result.error, owner: result.owner ?? retained?.owner,
          confirmed: result.value ?? (ownerChanged ? undefined : retained?.confirmed) }
      })
    }

    void read<ExecutorCounts>(host, setExecutors, async () => {
      const inventory = await api.executors.discover(host.id, { refresh: false })
      if (inventory.routeHostId !== host.id || runtimeId !== undefined && inventory.runtimeId !== runtimeId) {
        return { error: 'The Executor inventory belongs to another Host or Runtime.' }
      }
      const countsByProvider = new Map<string, number>()
      let defaults = 0
      for (const executor of inventory.executors) {
        countsByProvider.set(executor.providerId, (countsByProvider.get(executor.providerId) ?? 0) + 1)
        if (executor.source === 'provider-default') defaults += 1
      }
      return { owner: inventory.runtimeId, value: { countsByProvider, defaults, total: inventory.executors.length, observedAt: Date.now() } }
    })
    void read(host, setRecords, async () => recordSource(await api.hosts.agentResources(host, 'records', runtimeId, { signal }), host.id, 'records'))
    void read(host, setRunning, async () => recordSource(await api.hosts.agentResources(host, 'running', runtimeId, { signal }), host.id, 'running'))
    return () => controller.abort()
  }, [host, active, visible, refresh])

  const inventory = executorRead?.host === host ? executorRead : undefined
  return { executorState: readState(inventory), executors: inventory?.confirmed, executorRead: inventory,
    records: records?.host === host ? records : undefined, running: running?.host === host ? running : undefined }
}

function SampleTime({ at }: { at: number }) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return <>Unknown time</>
  return <time dateTime={date.toISOString()}>{date.toLocaleTimeString()}</time>
}

function SourceStatus({ read }: { read?: SourceRead<{ observedAt: number }> | undefined }) {
  const at = read?.confirmed?.observedAt
  if (at !== undefined && (read?.busy || read?.error)) {
    return <>Last confirmed <SampleTime at={at} />{read.busy ? ' · Reading…' : null}</>
  }
  if (!read || read.busy) return <>Reading…</>
  if (at === undefined) return <>Unavailable</>
  return <>Read <SampleTime at={at} /></>
}

export function ProviderObservations({ observations }: { observations: ProviderObservationSnapshot }) {
  const { executors, executorRead, records, running } = observations
  const recordCounts = records?.confirmed
  const runCount = running?.confirmed
  const rows = [
    { key: 'saved', label: 'Saved', count: recordCounts?.saved, read: records },
    { key: 'running', label: 'Running saved', count: runCount?.count, read: running },
    { key: 'retired', label: 'Retired', count: recordCounts?.retired, read: records }
  ]
  const maximum = Math.max(1, ...rows.map(row => row.count ?? 0))
  const defaultPercent = executors?.total ? executors.defaults / executors.total * 100 : 0

  return <div className="provider-observations">
    <section className="provider-observation" aria-label="Executor entries" data-reading={observations.executorState}>
      <header><h3>Executor entries</h3><small><SourceStatus read={executorRead} /></small></header>
      <strong className="provider-observation__total">{executors?.total.toLocaleString() ?? '—'}</strong>
      {executors ? <>
        <div className="provider-observation__bar provider-observation__bar--executors" aria-hidden="true">
          <span style={{ width: `${defaultPercent}%` }} />
          <span style={{ width: `${executors.total ? 100 - defaultPercent : 0}%` }} />
        </div>
        <dl className="provider-observation__inventory">
          <div><dt>Provider defaults</dt><dd>{executors.defaults.toLocaleString()}</dd></div>
          <div><dt>Configured or registered</dt><dd>{(executors.total - executors.defaults).toLocaleString()}</dd></div>
        </dl>
      </> : null}
      {executorRead?.error ? <p className="provider-observation__issue" role="status">Executor inventory: {executorRead.error}</p> : null}
    </section>
    <section className="provider-observation" aria-label="Session states">
      <header><h3>Session states</h3></header>
      <dl className="provider-observation__sessions">
        {rows.map(row => <div key={row.key} className="provider-observation__session" data-reading={readState(row.read)}>
          <dt>{row.label}</dt>
          <dd className="provider-observation__count">{row.count?.toLocaleString() ?? '—'}</dd>
          {row.count === undefined ? null : <dd className="provider-observation__bar" aria-hidden="true">
            <span style={{ width: `${row.count / maximum * 100}%` }} />
          </dd>}
          <dd className="provider-observation__time"><SourceStatus read={row.read} /></dd>
        </div>)}
      </dl>
      {records?.error ? <p className="provider-observation__issue" role="status">Saved and retired records: {records.error}</p> : null}
      {running?.error ? <p className="provider-observation__issue" role="status">Running saved bindings: {running.error}</p> : null}
      <p className="provider-observation__note">Running saved counts saved Sessions with a running Native Run.
        {runCount ? <> Native sample <SampleTime at={runCount.nativeObservedAt} />.</> : null}
      </p>
    </section>
  </div>
}
