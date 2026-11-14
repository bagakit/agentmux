import { useMemo, type ReactNode } from 'react'
import type { NodeResources } from '@agentmux/core/node-publishing'
import { HostResourceTrends } from './HostResourceTrends'
import { nodeTrendPoints, type NodeSampleFrame } from './node-resource-view'
function gib(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1024 ** 3) + ' GiB' }
function mib(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1024 ** 2) + ' MiB' }
function when(at: number) { return new Date(at).toLocaleTimeString() }
export function HostNodeResources({ reply, frames, error, busy, active, privateOwner = false, agents, workload }: {
  reply?: NodeResources | undefined; frames: NodeSampleFrame[]; error?: string | undefined; busy: boolean; active: boolean; privateOwner?: boolean; agents?: ReactNode; workload?: ReactNode
}) {
  const points = useMemo(() => nodeTrendPoints(frames), [frames]), sample = [...frames].reverse().find(frame => frame.sample)?.sample, now = points.at(-1)
  const withheld = reply?.status === 'withheld', retained = Boolean(error || reply?.status === 'unavailable')
  const hostCpu = retained ? [...points].reverse().find(point => point.hostCpu !== null)?.hostCpu : now?.hostCpu
  const coreCpu = retained ? [...points].reverse().find(point => point.coreCpu !== null)?.coreCpu : now?.coreCpu
  const memorySample = [...frames].reverse().find(frame => frame.sample?.memory.state === 'available')?.sample
  const processSample = [...frames].reverse().find(frame => frame.sample?.process.state === 'available')?.sample
  const process = processSample?.process.state === 'available' ? processSample.process.value : undefined
  const ioSample = [...frames].reverse().find(frame => frame.sample?.filesystemIo?.state === 'available')?.sample
  const io = ioSample?.filesystemIo?.state === 'available' ? ioSample.filesystemIo.value : undefined
  const ioCurrent = sample?.filesystemIo?.state === 'available' && !retained
  const ioPoint = retained ? [...points].reverse().find(point => point.ioRead !== null || point.ioWrite !== null) : now
  const ioLabel = io?.scope === 'process-io' ? 'Core process I/O' : 'Core filesystem I/O'
  return <section className="host-node-resources" aria-label="Node resource measurements">
    <header><strong>Core service</strong><span>{privateOwner ? 'Private owner view' : 'Published by this node'}</span></header>
    {withheld ? <p className="network-node-feedback" role="status">System resources are not shared by this node. Existing work remains available.</p> : <>
      <p className="host-runtime__sample" role="status">{retained ? `Observation unavailable.${sample ? ` Last confirmed ${when(sample.observedAt)}.` : ''}` : sample ? `Sample ${when(sample.observedAt)} · recent samples while this panel is open` : busy ? 'Reading service measurements…' : 'No confirmed samples yet.'}</p>
      {error || reply?.status === 'unavailable' ? <p className="host-runtime__issue">{error ?? (reply?.status === 'unavailable' ? reply.message : '')}</p> : null}
      <div className="host-node-resources__values" aria-label="Core process measurements">
        <div><span>Core process CPU</span><strong>{coreCpu == null ? '—' : coreCpu.toFixed(1) + '%'}</strong><small>{coreCpu == null ? sample ? 'Waiting for the next compatible sample' : 'Not observed' : 'One logical core = 100%'}</small></div>
        <div><span>Core process memory</span><strong>{process ? mib(process.rssBytes) : '—'}</strong><small>Resident memory · RSS{processSample && sample?.process.state !== 'available' ? ` · last ${when(processSample.observedAt)}` : ''}</small></div>
      </div>
      {sample?.process.state === 'unavailable' ? <p className="host-runtime__issue">{sample.process.message}</p> : null}
    </>}
    {!withheld && sample ? <HostResourceTrends points={points} active={active} /> : null}
    {agents}
    {workload}
    {!withheld && sample ? <>
        <div className="host-node-resources__io" aria-label="Core I/O operations">
          <header><strong>{ioLabel}</strong><span>{io && !ioCurrent ? 'Last confirmed · ' : ''}Operations · not bytes</span></header>
          <div className="host-node-resources__values">
            <div><span>Read operations</span><strong>{ioPoint?.ioRead == null ? '—' : ioPoint.ioRead.toFixed(1) + ' /s'}</strong><small>{io ? `${io.readOperations.toLocaleString()} cumulative` : 'Not observed'}</small></div>
            <div><span>Write operations</span><strong>{ioPoint?.ioWrite == null ? '—' : ioPoint.ioWrite.toFixed(1) + ' /s'}</strong><small>{io ? `${io.writeOperations.toLocaleString()} cumulative` : 'Not observed'}</small></div>
          </div>
          {!io ? <p className="host-runtime__sample">I/O counters not observed.</p> : null}
          {sample.filesystemIo?.state === 'unavailable' ? <p className="host-runtime__issue">{sample.filesystemIo.message}</p> : null}
        </div>
        <details className="host-runtime__details"><summary>Service samples &amp; process details</summary>
          <p className="host-runtime__sample">{io ? `${ioCurrent ? 'Sample' : 'Last confirmed'} ${when(ioSample!.observedAt)}. ${io.scope === 'process-io' ? 'Windows process I/O operation counters; not disk-only activity.' : 'Serving Core filesystem operation counters.'} Excludes Agent child processes and Native stream throughput.` : 'This Core has not provided I/O counters. No rate is inferred from retained output.'}</p>
          <p className="host-runtime__sample">{process ? `Core uptime ${Math.floor(process.uptimeSeconds / 60)} min · heap ${mib(process.heapUsedBytes)} / ${mib(process.heapTotalBytes)} · external ${mib(process.externalBytes)}.` : 'Process details not observed.'} This is the serving Core process, not its Agents or the Native daemon.</p>
          <div className="host-node-resources__table" tabIndex={0} aria-label="Service sample table, scroll horizontally for I/O totals"><table><thead><tr><th>Time</th><th>Core CPU %</th><th>Core RSS MiB</th><th>Read ops/s</th><th>Write ops/s</th><th>Read total ops</th><th>Write total ops</th></tr></thead><tbody>{[...points].reverse().map((point, index) => <tr key={`${point.at}:${index}`}><td>{when(point.at)}</td><td>{point.coreCpu?.toFixed(1) ?? '—'}</td><td>{point.coreGiB == null ? '—' : (point.coreGiB * 1024).toFixed(1)}</td><td>{point.ioRead?.toFixed(1) ?? '—'}</td><td>{point.ioWrite?.toFixed(1) ?? '—'}</td><td>{point.ioReadTotal ?? '—'}</td><td>{point.ioWriteTotal ?? '—'}</td></tr>)}</tbody></table></div>
        </details>
        <details className="host-runtime__details host-node-resources__device"><summary>Device resources <span>{privateOwner ? 'Private owner view' : 'Published by this node'}</span></summary>
          <p className="host-runtime__sample">Whole-device measurements; they are not attributable to one service or Agent.{privateOwner ? ' This private read does not change what the node shares.' : ''}</p>
          <div className="host-node-resources__values">
            <div><span>Host CPU</span><strong>{hostCpu == null ? '—' : hostCpu.toFixed(1) + '%'}</strong><small>Whole-host capacity</small></div>
            <div><span>Host memory in use</span><strong>{memorySample?.memory.state === 'available' ? gib(memorySample.memory.value.totalBytes - memorySample.memory.value.freeBytes) : '—'}</strong><small>{memorySample?.memory.state === 'available' ? `of ${gib(memorySample.memory.value.totalBytes)} · includes cache${sample.memory.state !== 'available' ? ` · last ${when(memorySample.observedAt)}` : ''}` : 'Not observed'}</small></div>
          </div>
          <p className="host-runtime__sample">Host uptime {sample.system.state === 'available' ? Math.floor(sample.system.value.uptimeSeconds / 3600) + ' h' : 'not observed'} · Filesystem {sample.filesystem.state === 'available' ? `${gib(sample.filesystem.value.availableBytes)} available / ${gib(sample.filesystem.value.totalBytes)}` : 'not observed'}. Filesystem source: {sample.filesystem.state === 'available' && sample.filesystem.value.root ? 'published root' : 'Node storage volume'}.</p>
          {[sample.system, sample.cpu, sample.memory, sample.filesystem].flatMap((source, index) => source.state === 'unavailable' ? [<p key={index} className="host-runtime__issue">{source.message}</p>] : [])}
        </details>
      </> : null}
  </section>
}
