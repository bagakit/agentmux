import type { HostRuntimeSource, NetworkInterfaceAddress } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { currentHostNetwork, type HostNetworkRead } from './use-host-network-observation'
import './host-network-panel.css'

const ReadIcon = semanticIconComponent('action.refresh')
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const networkDuration = (ms: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: ms < 10 ? 1 : 0 }).format(ms)} ms`
function SourceTime({ source, current }: { source: HostRuntimeSource<unknown>; current?: HostRuntimeSource<unknown> | null | undefined }) {
  return <small className="host-network__source-time">{current?.state === 'available' && current.readAt === source.readAt ? 'Read' : 'Last confirmed'} <time dateTime={new Date(source.readAt).toISOString()}>{time(source.readAt)}</time></small>
}
function SourceIssue({ source }: { source?: HostRuntimeSource<unknown> | null | undefined }) {
  return source?.state === 'unavailable' ? <p className="host-network__issue" role="status">{source.message}</p> : null
}
function Interfaces({ title, source, current, addresses, identity, sampledAt }: { title: string; source: HostRuntimeSource<unknown>; current?: HostRuntimeSource<unknown> | undefined; addresses: NetworkInterfaceAddress[]; identity: string; sampledAt: number }) {
  return <details className="host-network__addresses">
    <summary><span>{title}</span><small>{addresses.length} addresses</small></summary>
    <p className="host-network__hint">{identity}. Addresses visible in this process’s network namespace.</p>
    <SourceTime source={source} current={current} /><small className="host-network__source-time">Sampled <time dateTime={new Date(sampledAt).toISOString()}>{time(sampledAt)}</time> by this source</small>
    <div className="host-network__address-list">{addresses.length ? addresses.map((address, index) => <div key={`${address.name}:${address.address}:${index}`}>
      <span><strong>{address.name}</strong><small>{address.family} · {address.internal ? 'Loopback' : 'Interface'}{address.scopeid ? ` · scope ${address.scopeid}` : ''}</small></span>
      <code>{address.cidr ?? address.address}</code>
    </div>) : <p className="host-network__hint">This source reported no interface addresses.</p>}</div>
  </details>
}
export function HostNetworkPanel({ host, committed, active, visible, state, onRead }: {
  host: HostConfig; committed?: HostConfig | undefined; active: boolean; visible: boolean; state?: HostNetworkRead | undefined; onRead: (host: HostConfig) => Promise<void>
}) {
  const saved = committed !== undefined && configValuesEqual(host, committed)
  const held = currentHostNetwork(state, host), latest = held?.error ? undefined : held?.latest, retained = held?.retained
  const target = retained?.target.state === 'available' ? retained.target.value : undefined
  const policy = retained?.ssh?.state === 'available' ? retained.ssh.value : undefined
  const observer = retained?.observer.state === 'available' ? retained.observer.value : undefined
  const busy = held?.busy === true
  const partial = latest && [latest.observer, latest.target, latest.ssh].some(source => source?.state === 'unavailable')
  return <section className="host-network" aria-label="Network observation" data-host-network={host.id}>
    <header className="host-network__header"><div><span className="host-network__eyebrow">LINK OBSERVATION</span><strong>Network</strong></div>
      <button type="button" className="small-button" disabled={!saved || !active || !visible || busy} onClick={() => { if (committed) void onRead(committed) }} aria-label="Read network details"><ReadIcon size={13} />{busy ? 'Reading…' : latest ? 'Refresh' : 'Read link'}</button>
    </header>
    {!saved ? <p className="host-network__hint">Save this connection to read its original network sources.</p> : !retained ? <p className="host-network__hint">Read this link’s owner response, SSH policy and interface addresses on demand.</p> : null}
    {held?.error ? <p className="host-network__issue" role="status">{held.error}</p> : null}
    {partial ? <p className="host-network__issue">Some network sources could not be read. Last confirmed values keep their original time.</p> : null}
    {retained ? <>
      <div className="host-network__request" data-network-request><span>Owner request</span><strong>{target ? networkDuration(target.requestDurationMs) : 'Unconfirmed'}</strong>
        <SourceTime source={retained.target} current={latest?.target} />
        <p>May include connection setup, queueing and service processing.</p></div>
      <SourceIssue source={latest?.target} />
      {policy && retained.ssh ? <section className="host-network__policy" aria-label="SSH configuration">
        <header><strong>SSH configuration</strong><SourceTime source={retained.ssh} current={latest?.ssh} /></header>
        <dl><div><dt>SSH keepalive</dt><dd>{policy.serverAliveInterval === 0 ? 'Disabled' : `${policy.serverAliveInterval}s idle interval`}</dd></div>
          <div><dt>Unanswered limit</dt><dd>{policy.serverAliveCountMax} requests</dd></div>
          <div><dt>TCP keepalive</dt><dd>{policy.tcpKeepAlive === 'no' ? 'Disabled' : policy.tcpKeepAlive === 'all' ? 'All sockets' : 'Transport'}</dd></div></dl>
        <p className="host-network__hint">Evaluated by OpenSSH at the shown read time. Existing channels may use earlier settings; keepalive replies are not observed.</p>
        <div className="host-network__path"><strong>Configuration path</strong>
          <ol><li><small>01 · ORIGIN</small><span>Connection service</span></li>
            {policy.jumps.map((jump, index) => <li key={index}><small>{String(index + 2).padStart(2, '0')} · CONFIGURED JUMP</small><code>{jump.user ? `${jump.user}@` : ''}{jump.host}{jump.port ? ` : ${jump.port}` : ''}</code></li>)}
            {policy.proxy === 'command' ? <li><small>OPAQUE PROXY</small><span>Custom proxy command</span></li> : null}
            <li><small>{String(policy.jumps.length + (policy.proxy === 'command' ? 3 : 2)).padStart(2, '0')} · DESTINATION</small><code>{policy.user}@{policy.hostname} : {policy.port}</code></li></ol>
          <p className="host-network__hint">Declared transit order, not the physical network route.</p></div>
      </section> : host.kind === 'local' ? <p className="host-network__hint">Local route · SSH keepalive and transit do not apply.</p> : null}
      <SourceIssue source={latest?.ssh} />
      {target && retained.target.state === 'available' ? <Interfaces title="Target interfaces" source={retained.target} current={latest?.target} addresses={target.sample.interfaces}
        sampledAt={target.sample.observedAt} identity={`Core ${target.sample.owner.runtimeId} · owner ${target.sample.owner.ownerInstanceId}`} /> : null}
      {observer && retained.observer.state === 'available' ? <Interfaces title="Observation service interfaces" source={retained.observer} current={latest?.observer} addresses={observer.interfaces}
        sampledAt={observer.observedAt} identity={`Observation process ${observer.processId}`} /> : null}
      <SourceIssue source={latest?.observer} />
      <p className="host-network__boundary">Interface addresses do not identify this connection’s socket or public exit. Physical hops, per-hop latency and NAT addresses are not observed.</p>
    </> : null}
  </section>
}

/** Compact graph text comes from the same held observation as the selected detail. */
export function hostNetworkSummary(state: HostNetworkRead | undefined): string | null {
  const target = state?.retained?.target, ssh = state?.retained?.ssh
  if (target?.state !== 'available') return null
  const retained = state?.latest?.target.state !== 'available' || state?.latest?.ssh?.state === 'unavailable' || state?.error !== undefined
  return `${retained ? 'Last confirmed · ' : ''}Owner request ${networkDuration(target.value.requestDurationMs)}${ssh?.state === 'available' && ssh.value.jumps.length ? ` · ${ssh.value.jumps.length} configured jumps` : ''}`
}
