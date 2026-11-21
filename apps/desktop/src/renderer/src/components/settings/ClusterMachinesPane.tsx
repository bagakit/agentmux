import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { NodeResourceSample } from '@agentmux/core/node-publishing'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { hostConnectionSummary, hostTransportLabel } from '../../lib/host-transport'
import { HostIcon } from '../HostBadge'
import { appendNodeSample, nodeTrendPoints, type NodeSampleFrame } from './node-resource-view'
import { clusterHostKey, observeClusterResources, type ClusterResourceRead } from './cluster-resource-observation'
import './cluster-machines.css'

type Row = { key: string; phase: 'queued' | 'reading' | 'observed' | 'unavailable' | 'idle'; read?: ClusterResourceRead; lastSample?: NodeResourceSample | undefined; frames: NodeSampleFrame[]; issue?: string | undefined; completedAt?: number }
const bytes = (n: number) => { const unit = n >= 1024 ** 4 ? 'TiB' : 'GiB'; return `${(n / (unit === 'TiB' ? 1024 ** 4 : 1024 ** 3)).toFixed(1)} ${unit}` }
const partialSample = (sample: NodeResourceSample) => [sample.cpu, sample.memory, sample.filesystem, sample.system].some(metric => metric.state === 'unavailable')
const when = (at: number) => new Date(at).toLocaleTimeString()
const uptime = (n: number) => n >= 86400 ? `${Math.floor(n / 86400)}d ${Math.floor(n % 86400 / 3600)}h` : `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m`
function Measurement({ label, value, ratio, note }: { label: string; value: string; ratio?: number | undefined; note?: string | undefined }) {
  return <div className="cluster-machine-meter"><span>{label}</span><div className="cluster-machine-meter__track" aria-hidden="true">{ratio !== undefined ? <i style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }} /> : null}</div><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>
}

/** Saved Host routes are compared here; their names/IPs are not physical-device IDs. */
export function ClusterMachinesPane({ hosts, active, onAddDevice, onConnections }: {
  hosts: HostConfig[]; active: boolean
  onAddDevice?: () => void; onConnections?: (hostId: string) => void
}) {
  const [rows, setRows] = useState<Record<string, Row>>({}), latest = useRef(rows); latest.current = rows
  const request = useRef<(hostId?: string) => void>(() => {})
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'observed' | 'attention'>('all')
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const section = useRef<HTMLElement>(null)
  const [reading, setReading] = useState(false)
  const fingerprint = JSON.stringify(hosts.map(clusterHostKey))
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) }, [])
  useEffect(() => {
    if (!active || !visible) return
    const controller = new AbortController(), original = hosts.map(host => ({ ...host })), queue: HostConfig[] = []
    const pending = new Set<string>()
    let running = 0
    const pump = () => {
      if (controller.signal.aborted) return
      while (running < 3 && queue.length) {
        const host = queue.shift()!, key = clusterHostKey(host), before = latest.current[host.id]
        const held = before?.key === key ? before : undefined
        running++
        setRows(current => ({ ...current, [host.id]: { ...(held ?? { key, frames: [] }), phase: 'reading', issue: undefined } }))
        void observeClusterResources(host, api.nodePublishing, controller.signal, read => {
          if (controller.signal.aborted) return
          setRows(current => {
            const previous = current[host.id]?.key === key ? current[host.id] : undefined
            const same = previous?.read?.access === read.access && previous.read.reply.node.runtimeId === read.reply.node.runtimeId && previous.read.reply.node.ownerInstanceId === read.reply.node.ownerInstanceId
            const lastSample = read.reply.status === 'available' ? read.reply.sample : read.reply.status === 'unavailable' && same ? previous?.lastSample : undefined
            const frames = read.reply.status === 'available' ? appendNodeSample(same ? previous!.frames : [], read.reply.sample) : read.reply.status === 'unavailable' && same ? previous!.frames : []
            return { ...current, [host.id]: { key, phase: 'reading', read, lastSample, frames, completedAt: Date.now() } }
          })
        }, held?.read?.reply.node.runtimeId).then(() => {
          if (!controller.signal.aborted) setRows(current => ({ ...current, [host.id]: { ...current[host.id]!, phase: 'observed' } }))
        }, cause => {
          if (!controller.signal.aborted) setRows(current => ({ ...current, [host.id]: { ...(current[host.id]?.key === key ? current[host.id]! : { key, frames: [] }), phase: 'unavailable', issue: cause instanceof Error ? cause.message : String(cause) } }))
        }).finally(() => {
          running--; pending.delete(host.id)
          if (!controller.signal.aborted) { pump(); setReading(pending.size > 0) }
        })
      }
    }
    const schedule = (hostId?: string) => {
      if (controller.signal.aborted) return
      for (const host of original) if ((!hostId || host.id === hostId) && !pending.has(host.id)) {
        pending.add(host.id); queue.push(host)
        setRows(current => ({ ...current, [host.id]: { ...(current[host.id]?.key === clusterHostKey(host) ? current[host.id]! : { key: clusterHostKey(host), frames: [] }), phase: 'queued' } }))
      }
      setReading(pending.size > 0); pump()
    }
    request.current = schedule
    let observer: IntersectionObserver | undefined
    if (section.current && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); schedule() }
      })
      observer.observe(section.current)
    }
    else schedule()
    return () => {
      observer?.disconnect()
      controller.abort(); request.current = () => {}; setReading(false)
      setRows(current => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, pending.has(id) ? { ...row, phase: 'idle' as const } : row])))
    }
  }, [active, visible, fingerprint])
  const originals = hosts.map(host => ({ host, row: rows[host.id]?.key === clusterHostKey(host) ? rows[host.id] : undefined }))
  const observed = originals.filter(({ row }) => row?.phase === 'observed' && row.read?.reply.status === 'available').length
  const attention = ({ row }: { row?: Row | undefined }) => row?.phase === 'unavailable' || row?.read?.reply.status === 'withheld' || row?.read?.reply.status === 'unavailable' || row?.read?.reply.status === 'available' && partialSample(row.read.reply.sample)
  const inFilter = (item: typeof originals[number]) => filter === 'all' || (filter === 'attention' ? attention(item) : item.row?.read?.reply.status === 'available')
  const needle = query.trim().toLocaleLowerCase()
  const shown = originals.filter(item => {
    const { host, row } = item
    const fields = [host.label, host.id, hostConnectionSummary(host), row?.read?.reply.node.runtimeId ?? '']
    if (host.kind === 'ssh') fields.push(host.runtimeId ?? '', ...(host.transport === 'tailcat' ? [] : [host.hostname, host.port?.toString() ?? '']))
    return fields.some(field => field.toLocaleLowerCase().includes(needle)) && inFilter(item)
  })
  return <section ref={section} className="cluster-machines" id="cluster-machine-resources" tabIndex={-1} aria-label="Cluster machine resources" data-settings-field="mesh-machines">
    <header className="cluster-machines-heading">
      <div><h3>Machines</h3><div className="cluster-machines-coverage" role="status">{observed} / {hosts.length} sampled <span>· Saved connections</span></div></div>
      <div className="cluster-machines-actions">
        <TextInput type="search" aria-label="Filter saved devices" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a machine" />
        <Button type="button" disabled={reading} onClick={() => request.current()}>{reading ? 'Reading resources…' : 'Refresh resources'}</Button>
        {onAddDevice ? <Button type="button" className="cluster-add-device" onClick={onAddDevice}>Add SSH connection</Button> : null}
      </div>
    </header>
    <div className="cluster-machines-toolbar" role="group" aria-label="Machine status filter">{(['all', 'observed', 'attention'] as const).map(value => <button type="button" className="small-button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All hosts' : value === 'observed' ? 'With samples' : 'Needs attention'}</button>)}</div>
    {shown.length ? <div className="cluster-machines-column-headings" aria-hidden="true"><span>Device / saved connection</span><span>CPU</span><span>Memory</span><span>Storage</span><span>Sample</span><span /></div> : null}
    <div className="cluster-machines-grid">{shown.map(({ host, row }) => <MachineCard key={host.id} host={host} row={row} onRefresh={() => request.current(host.id)} onConnections={onConnections} />)}</div>
    {!shown.length ? <p className="cluster-machines-empty">{hosts.length ? `No saved devices match this filter. ${hosts.length} saved connections remain available.` : 'No saved connections yet.'}{needle ? <> <Button type="button" onClick={() => setQuery('')}>Clear filter</Button></> : null}</p> : null}
  </section>
}
function MachineCard({ host, row, onRefresh, onConnections }: { host: HostConfig; row?: Row | undefined; onRefresh: () => void; onConnections?: ((hostId: string) => void) | undefined }) {
  const reply = row?.read?.reply, sample = reply?.status === 'available' ? reply.sample : reply?.status === 'unavailable' ? row?.lastSample : undefined
  const point = nodeTrendPoints(row?.frames ?? []).at(-1)
  const stale = row?.phase === 'unavailable' || row?.phase === 'reading' || row?.phase === 'idle' || row?.phase === 'queued' || reply?.status === 'unavailable'
  const partial = sample && partialSample(sample)
  const state = row?.phase === 'queued' ? 'Queued' : row?.phase === 'idle' && sample ? 'Last sampled' : row?.phase === 'unavailable' ? 'Read unavailable' : row?.phase === 'reading' ? 'Reading' : reply?.status === 'withheld' ? 'Not shared' : reply?.status === 'unavailable' ? 'Sample unavailable' : sample ? partial ? 'Partial sample' : 'Sampled' : 'Not observed'
  const memory = sample?.memory.state === 'available' && sample.memory.value.totalBytes > 0 ? sample.memory.value : undefined
  const volume = sample?.filesystem.state === 'available' ? sample.filesystem.value : undefined
  const cpu = point?.hostCpu
  const details = sample ? [sample.cpu, sample.memory, sample.filesystem, sample.system, sample.process].filter(value => value.state === 'unavailable') : []
  return <article className="cluster-machine" data-cluster-host={host.id}>
    <div className="cluster-machine-row">
      <div className="cluster-machine-identity"><HostIcon kind={host.kind} size={17} /><div><h4>{host.label}</h4><span>{host.kind === 'local' ? 'Local' : host.transport === 'tailcat' ? 'Tailcat · private address' : `${hostTransportLabel(host)} · ${host.hostname || 'Hostname required'}`}</span></div></div>
      <Measurement label="Host CPU" value={cpu == null ? '—' : `${cpu.toFixed(1)}%`} ratio={cpu ?? undefined} note={sample?.cpu.state === 'unavailable' ? 'CPU source unavailable' : sample && cpu == null ? 'Waiting for a compatible CPU interval' : undefined} />
      <Measurement label="Memory" value={memory ? `${Math.round(100 * (1 - memory.freeBytes / memory.totalBytes))}%` : '—'} ratio={memory ? 100 * (1 - memory.freeBytes / memory.totalBytes) : undefined} note={memory ? `${bytes(memory.totalBytes - memory.freeBytes)} / ${bytes(memory.totalBytes)}` : sample?.memory.state === 'unavailable' ? 'Memory source unavailable' : undefined} />
      <Measurement label="Storage volume" value={volume && volume.totalBytes > 0 ? `${Math.round(100 * (1 - volume.availableBytes / volume.totalBytes))}%` : '—'} ratio={volume && volume.totalBytes > 0 ? 100 * (1 - volume.availableBytes / volume.totalBytes) : undefined} note={volume ? `${bytes(volume.availableBytes)} available / ${bytes(volume.totalBytes)}` : sample?.filesystem.state === 'unavailable' ? 'Volume source unavailable' : undefined} />
      <div className="cluster-machine-sample"><strong className="cluster-machine-state" data-state={row?.phase ?? 'unknown'}>{state}</strong>
        {sample ? <small>{stale ? 'Last confirmed ' : ''}{when(sample.observedAt)}{sample.system.state === 'available' ? ` · Up ${uptime(sample.system.value.uptimeSeconds)}` : ''}</small> : null}
      </div>
      {onConnections ? <Button type="button" className="cluster-machine-manage" aria-label={`Manage ${host.label}`} onClick={() => onConnections(host.id)}>Manage</Button> : <span />}
    </div>
    <details className="cluster-machine-details"><summary title="Sample details" aria-label={`Sample details for ${host.label}`}><SemanticIcon name="navigation.disclosure" size={13} aria-hidden="true" /></summary>
      {reply?.status === 'withheld' ? <p>This node does not publish system resources.</p> : null}
      {row?.issue || reply?.status === 'unavailable' ? <p>{row?.issue ?? (reply?.status === 'unavailable' ? reply.message : '')}</p> : null}
      <dl><dt>Saved Host</dt><dd>{host.id}</dd><dt>Runtime</dt><dd>{reply?.node.runtimeId ?? 'Not confirmed'}</dd><dt>Owner instance</dt><dd>{reply?.node.ownerInstanceId ?? 'Not confirmed'}</dd><dt>Source</dt><dd>{row?.read?.access === 'private' ? 'Private owner view' : row?.read?.access === 'published' ? 'Published resources' : 'Not observed'}</dd>
        <dt>Core process</dt><dd>{sample?.processId ?? 'Not observed'}</dd><dt>Core memory</dt><dd>{sample?.process.state === 'available' ? `${(sample.process.value.rssBytes / 1024 ** 2).toFixed(1)} MiB RSS` : 'Not observed'}</dd>
        <dt>System</dt><dd>{sample?.system.state === 'available' ? `${sample.system.value.platform} · ${sample.system.value.architecture}` : 'Not observed'}</dd>
        <dt>Checked</dt><dd>{row?.completedAt ? when(row.completedAt) : 'Not observed'}</dd></dl>
      {row?.read?.privateIssue ? <p>Private read: {row.read.privateIssue}</p> : null}
      {details.map((value, index) => <p key={index}>{value.state === 'unavailable' ? value.message : ''}</p>)}
      <div className="cluster-machine-footer"><Button type="button" disabled={row?.phase === 'reading' || row?.phase === 'queued'} onClick={onRefresh} aria-label={`Refresh ${host.label}`}>Refresh this machine</Button></div>
    </details>
  </article>
}
