import { useState } from 'react'
import type { HostMetric, HostNetworkInterface, MetricsObservation } from '@agentmux/core/control'
import { performanceBytes as bytes, performanceReadingTime as readingTime } from './performance-format'

const rate = (value: number | null | undefined) => value == null ? '—' : `${bytes(value)}/s`
const interfaceKey = (value: Pick<HostNetworkInterface, 'name' | 'linkId'>) => JSON.stringify([value.name, value.linkId])
function HostSource({ label, metric, at }: { label: string; metric: HostMetric<unknown> | undefined; at: number | null | undefined }) {
  return <div><dt>{label}</dt><dd>{readingTime(metric?.observedAt, at)}{metric?.unavailable ? ` · ${metric.unavailable}` : ''}</dd></div>
}

/** A projection of the original local Host source. It does not collect or clean anything. */
export function PerformanceHostResources({ observation, observedAt }: { observation: MetricsObservation | null | undefined; observedAt: number | null | undefined }) {
  const source = observation?.diagnostics, storage = source?.data?.storage, host = source?.data?.host
  const [selected, setSelected] = useState('')
  const interfaces = host?.network.data?.interfaces ?? [], network = interfaces.find(item => interfaceKey(item) === selected)
  const pressure = host?.pressure.data?.level, cpu = host?.cpu.data
  return <section className="performance-host" aria-label="Local Host resources">
    <div className="performance-section-heading"><strong>This computer</strong><span>{observation?.scope.hostname ?? 'Host unconfirmed'}</span></div>
    <div className="performance-host-load">
      <div><small>System CPU</small><strong>{cpu?.percent == null ? '—' : `${cpu.percent.toFixed(1)}%`}</strong><small>All {cpu?.logicalCpuCount ?? '—'} logical cores · interval</small></div>
      <div><small>Physical memory</small><strong>{bytes(host?.memory.data?.totalBytes)}</strong><small>{bytes(host?.memory.data?.freeBytes)} OS free</small></div>
    </div>
    <div className="performance-host-row" data-host-memory>
      <div><strong>Memory pressure</strong><small>OS pressure · not free memory</small></div>
      <div><strong data-memory-pressure={pressure ?? 'unknown'}>{pressure ? pressure[0]!.toUpperCase() + pressure.slice(1) : 'Unavailable'}</strong><small>Swap used {bytes(host?.swap.data?.usedBytes)}</small></div>
    </div>
    <div className="performance-host-row" data-host-volume>
      <div><strong>Disk available</strong><small>Home volume · available to this user</small></div>
      <div><strong>{bytes(storage?.availableBytes)}</strong><small>{storage ? `of ${bytes(storage.totalBytes)}` : 'Capacity unavailable'}</small></div>
    </div>
    <details className="performance-disclosure performance-network" data-host-network>
      <summary>Network <span>{network ? `${network.name} · ↓ ${rate(network.receiveBytesPerSecond)} · ↑ ${rate(network.sendBytesPerSecond)}` : `${interfaces.length} interfaces · choose one`}</span></summary>
      <label>Interface<select aria-label="Network interface" value={selected} onChange={event => setSelected(event.currentTarget.value)}>
        <option value="">Select an interface</option>
        {selected && !network ? <option value={selected}>Selected interface unavailable</option> : null}
        {interfaces.map(item => <option key={interfaceKey(item)} value={interfaceKey(item)}>{item.name} · link {item.linkId}</option>)}
      </select></label>
      <div className="performance-network-rates"><div><small>↓ Download</small><strong>{rate(network?.receiveBytesPerSecond)}</strong></div><div><small>↑ Upload</small><strong>{rate(network?.sendBytesPerSecond)}</strong></div></div>
      <p className="performance-note">{network?.unavailable ?? (network ? `${network.intervalMs == null ? 'Waiting for an interval' : `${Math.round(network.intervalMs)} ms interval`} · ${readingTime(host?.network.observedAt, observedAt)}` : selected ? 'The selected interface is missing from this observation.' : host?.network.unavailable ?? 'Select an interface to inspect its traffic.')}</p>
      <p className="performance-note">Interface traffic is shared by this computer. Physical, VPN and loopback links may carry the same bytes; they are not added or assigned to AgentMux or a Run.</p>
    </details>
    <details className="performance-disclosure"><summary>Host sources <span>{source?.state ?? 'pending'}</span></summary>
      <dl className="performance-host-sources">
        <HostSource label="CPU" metric={host?.cpu} at={observedAt} />
        <HostSource label="Physical memory" metric={host?.memory} at={observedAt} />
        <HostSource label="Swap" metric={host?.swap} at={observedAt} />
        <HostSource label="Pressure" metric={host?.pressure} at={observedAt} />
        <HostSource label="Network" metric={host?.network} at={observedAt} />
        <div><dt>Volume</dt><dd>{storage ? readingTime(source?.lastSuccessAt, observedAt) : source?.data?.storageUnavailable ?? source?.reason ?? 'Waiting for volume observation'}{source?.state === 'stale' ? ' · Previous reading' : ''}</dd></div>
        <div><dt>CPU interval</dt><dd>{cpu?.intervalMs == null ? cpu?.unavailable ?? 'Waiting for two readings' : `${Math.round(cpu.intervalMs)} ms · 100% is this Host’s full capacity`}</dd></div>
      </dl>
      <p className="performance-note">Physical free memory excludes memory serving other OS uses; it is not a pressure verdict. Missing platform fields remain unavailable.</p>
    </details>
    {source?.state === 'stale' || source?.state === 'unavailable' ? <p className="performance-state" data-tone="warning">{source.state === 'stale' ? 'Previous Host reading' : 'Host observation unavailable'}{source.reason ? ` · ${source.reason}` : ''}</p> : null}
  </section>
}
