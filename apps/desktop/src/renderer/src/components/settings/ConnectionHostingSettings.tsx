import { useEffect, useMemo, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentMuxDesktopApi, ConnectionHostingTarget } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { selectManualConnectionOwner, useAppStore } from '../../store'
import { api } from '../../lib/api'
import { ConnectorServiceControl } from './ConnectorServiceControl'
import { ExternalConnectionsSettings } from './ExternalConnectionsSettings'

export type ConnectionSettingsPort = Pick<AgentMuxDesktopApi['connections'], 'call' | 'storeCredential' | 'inspectCredential'>
export function connectionSettingsPort(target: ConnectionHostingTarget | null): ConnectionSettingsPort {
  if (!target) return api.connections
  const original = { ...target }
  return {
    call: (method, params) => api.connections.call(method, params, original),
    storeCredential: input => api.connections.storeCredential(input, original),
    inspectCredential: operationId => api.connections.inspectCredential(operationId, original)
  }
}
/** An explicit route on the existing configured Hosts, separate from Agent execution. */
export function ConnectionHostingSettings(props: { active: boolean; channel?: 'lark' | 'discord'; onClose?: (() => void) | undefined; navigationRequest?: SettingsNavigationRequest | undefined }) {
  const channel = props.channel ?? 'lark', hosts = useAppStore(state => state.config?.hosts)
  const intents = useAppStore(state => state.manualConnectionIntents)
  const [target, setTarget] = useState<ConnectionHostingTarget | null>(() => props.navigationRequest ? null : useAppStore.getState().manualConnectionSelections[channel] ?? null)
  const [reading, setReading] = useState(''), [issue, setIssue] = useState('')
  const [request, setRequest] = useState<string | null>(null)
  useEffect(() => {
    if (request === null) return
    const host = hosts?.find(host => host.id === request), abort = new AbortController()
    if (!host) { setIssue('This configured Host is unavailable. The original draft and save are kept.'); setRequest(null); return }
    setReading(host.id); setIssue('')
    void api.hosts.inspect(host, { signal: abort.signal }).then(observation => {
      if (abort.signal.aborted) return
      if (observation.routeHostId !== host.id || !configValuesEqual(observation.configuration, host) || observation.owner.state !== 'available') throw new Error('The original Host identity is not confirmed. Read this Host again.')
      const target = { hostId: host.id, runtimeId: observation.owner.value.runtimeId }
      selectManualConnectionOwner(channel, target); setTarget(target)
    }).catch(error => { if (!abort.signal.aborted) setIssue(presentError(error)) })
      .finally(() => { if (!abort.signal.aborted) { setReading(''); setRequest(null) } })
    return () => abort.abort()
  }, [request, hosts])
  const key = JSON.stringify([channel, target]), connections = useMemo(() => connectionSettingsPort(target), [key])
  if (!props.active) return null
  return <div className="settings-pane-stack">
    <section className="connector-setup" data-connection-hosting>
      <div className="connector-setup__fields"><label className="settings-field connector-platform"><span>Bot hosting</span>
        <select aria-label="Connector hosting Host" value={target ? 'original' : 'desktop'} onChange={event => {
          if (event.target.value === 'desktop') { setRequest(null); selectManualConnectionOwner(channel, null); setTarget(null); setIssue('') }
          else if (event.target.value.startsWith('host:')) setRequest(event.target.value.slice(5))
        }}>
          <option value="desktop">This App</option>
          {target ? <option value="original">{hosts?.find(host => host.id === target.hostId)?.label ?? target.hostId}</option> : null}
          {hosts?.map(host => <option key={host.id} value={'host:' + host.id}>{host.label}</option>)}
        </select>
      </label></div>
      <p className="settings-group-note">Bots, credentials and profiles stay here. Your Agents can run on another Host.</p>
      {Object.values(intents).filter(item => item.channel === channel && item.pending && JSON.stringify(item.target) !== JSON.stringify(target)).map(item => <button key={item.pending!.operationId + JSON.stringify(item.target)} className="small-button" onClick={() => {
        setRequest(null); selectManualConnectionOwner(channel, item.target); setTarget(item.target); setIssue('')
      }}>Resume original save · {item.target ? hosts?.find(host => host.id === item.target!.hostId)?.label ?? item.target.hostId : 'This App'}</button>)}
      {target ? <details className="connector-diagnostics"><summary>Hosting identity</summary><p><code>{target.hostId}</code> · <code>{target.runtimeId}</code></p></details> : null}
      {reading ? <p role="status">Reading the original Host identity…</p> : issue ? <p role="status" className="connector-issue">{issue}</p> : null}
    </section>
    {!target ? <ConnectorServiceControl active={props.active} /> : null}
    <ExternalConnectionsSettings key={key} {...props} connections={connections} hostingTarget={target} />
  </div>
}
