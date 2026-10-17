import { configValuesEqual } from '../../../../shared/config-edit'
import { configuredNetworkPath, hostNetworkView, networkDuration } from './host-network-view'
import { NetworkInterfaces, NetworkReadButton, SourceIssue, SourceTime, type HostNetworkViewProps } from './HostNetworkSources'

export function HostNetworkPanel(props: HostNetworkViewProps) {
  const { host, committed, state } = props
  const saved = committed !== undefined && configValuesEqual(host, committed)
  const { held, latest, retained, target, policy, observer, partial } = hostNetworkView(host, state)
  return <section className="host-network" aria-label="Network observation" data-host-network={host.id}>
    <header className="host-network__header"><div><span className="host-network__eyebrow">LINK OBSERVATION</span><strong>Network</strong></div>
      <NetworkReadButton {...props} />
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
          <ol>{configuredNetworkPath(host, policy).map((step, index) => <li key={step.id} data-network-path-step={step.kind}><small>{String(index + 1).padStart(2, '0')} · {step.kind.toUpperCase()}</small><span>{step.label}</span><code>{step.address}</code><small>{step.detail}</small></li>)}</ol>
          <p className="host-network__hint">Declared transit order, not the physical network route.</p></div>
      </section> : host.kind === 'local' ? <p className="host-network__hint">Local route · SSH keepalive and transit do not apply.</p> : null}
      <SourceIssue source={latest?.ssh} />
      {target && retained.target.state === 'available' ? <NetworkInterfaces title="Target interfaces" source={retained.target} current={latest?.target} addresses={target.sample.interfaces}
        sampledAt={target.sample.observedAt} identity={`Core ${target.sample.owner.runtimeId} · owner ${target.sample.owner.ownerInstanceId}`} /> : null}
      {observer && retained.observer.state === 'available' ? <NetworkInterfaces title="Observation service interfaces" source={retained.observer} current={latest?.observer} addresses={observer.interfaces}
        sampledAt={observer.observedAt} identity={`Observation process ${observer.processId}`} /> : null}
      <SourceIssue source={latest?.observer} />
      <p className="host-network__boundary">Interface addresses do not identify this connection’s socket or public exit. Physical hops, per-hop latency and NAT addresses are not observed.</p>
    </> : null}
  </section>
}
