import { useEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionHostingTarget } from '../../../../shared/contracts'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { selectManualConnectionOwner, useAppStore } from '../../store'
import { api } from '../../lib/api'
import { connectionSettingsPort } from '../../lib/connection-settings-port'
import { botTaskSelectionKey, readBotTaskLocator, restoredManagementTask } from '../../lib/bot-task-selection'
import { ConnectorServiceControl } from './ConnectorServiceControl'
import { ExternalConnectionsSettings } from './ExternalConnectionsSettings'
import '../../styles/channel-settings.css'

const HostIcon = semanticIconComponent('object.host')

/** An explicit route on the existing configured Hosts, separate from Agent execution. */
export function ConnectionHostingSettings(props: { active: boolean; channel?: 'lark' | 'discord'; onClose?: (() => void) | undefined; navigationRequest?: SettingsNavigationRequest | undefined }) {
  const channel = props.channel ?? 'lark', hosts = useAppStore(state => state.config?.hosts)
  const intents = useAppStore(state => state.manualConnectionIntents)
  const origin = props.navigationRequest?.channelOrigin ?? props.navigationRequest?.moteLarkOrigin
  const [target, setTarget] = useState<ConnectionHostingTarget | null | undefined>(() => {
    if (origin) return origin.hostingTarget ?? null
    const state = useAppStore.getState(), retained = channel === 'lark' ? restoredManagementTask(state.botTaskSelections) ?? readBotTaskLocator(state.botTaskSelections[botTaskSelectionKey({ kind: 'enrollment' })]) : null
    return retained ? retained.hostingTarget : Object.hasOwn(state.manualConnectionSelections, channel) ? state.manualConnectionSelections[channel] : undefined
  })
  const navigation = useRef(props.navigationRequest)
  useEffect(() => {
    if (navigation.current === props.navigationRequest) return
    navigation.current = props.navigationRequest
    if (origin) { setRequest(null); setTarget(origin.hostingTarget ?? null); setIssue('') }
  }, [props.navigationRequest])
  const [reading, setReading] = useState(''), [issue, setIssue] = useState('')
  const [request, setRequest] = useState<string | null>(() => target === undefined ? 'local' : null)
  useEffect(() => {
    if (!props.active || request === null) return
    const abort = new AbortController()
    setReading(request); setIssue('')
    void api.connections.hostingTarget(request).then(original => {
      if (abort.signal.aborted) return
      selectManualConnectionOwner(channel, original); setTarget(original)
    }).catch(error => { if (!abort.signal.aborted) setIssue(presentError(error)) })
      .finally(() => { if (!abort.signal.aborted) { setReading(''); setRequest(null) } })
    return () => abort.abort()
  }, [request, props.active])
  const key = JSON.stringify([channel, target]), connections = useMemo(() => connectionSettingsPort(target ?? null), [key])
  if (!props.active) return null
  return <div className="settings-pane-stack channel-settings">
    <div className="channel-environment">
    <section className="channel-hosting" data-connection-hosting>
      <label className="channel-hosting__selection"><span><HostIcon size={15} />Bot hosting</span>
        <select aria-label="Connector hosting Host" value={target ? 'original' : target === null ? 'unconfirmed' : 'local'} onChange={event => {
          if (event.target.value === 'local') setRequest('local')
          else if (event.target.value.startsWith('host:')) setRequest(event.target.value.slice(5))
        }}>
          {target?.hostId !== 'local' ? <option value="local">Background Host on this device</option> : null}
          {target === null ? <option value="unconfirmed">Original Host not recorded</option> : null}
          {target ? <option value="original">{target.hostId === 'local' ? 'Background Host on this device' : hosts?.find(host => host.id === target.hostId)?.label ?? target.hostId}</option> : null}
          {hosts?.filter(host => host.id !== 'local').map(host => <option key={host.id} value={'host:' + host.id}>{host.label}</option>)}
        </select>
      </label>
      {Object.values(intents).filter(item => item.channel === channel && item.pending && JSON.stringify(item.target) !== JSON.stringify(target)).map(item => <button key={item.pending!.operationId + JSON.stringify(item.target)} className="small-button" onClick={() => {
        setRequest(null); selectManualConnectionOwner(channel, item.target); setTarget(item.target); setIssue('')
      }}>{item.target ? 'Resume original save' : 'Review original save'} · {item.target ? hosts?.find(host => host.id === item.target!.hostId)?.label ?? item.target.hostId : 'Host not recorded'}</button>)}
      {target ? <details className="connector-diagnostics"><summary>Hosting details</summary><p className="settings-group-note">This Host runs your bots in the background and stores their credentials and profiles. Your Agents can run elsewhere.</p><p><code>{target.hostId}</code> · <code>{target.runtimeId}</code></p></details> : null}
      {reading ? <p role="status" aria-busy="true">Reading the original Host identity…</p> : issue ? <p role="status" className="connector-issue">{issue}</p> : null}
      {target === undefined && !reading ? <button type="button" className="small-button" onClick={() => setRequest('local')}>Read background Host</button> : null}
    </section>
    {target !== undefined ? <ConnectorServiceControl active={props.active} hostingTarget={target} /> : null}
    </div>
    {target !== undefined ? <ExternalConnectionsSettings key={key} {...props} connections={connections} hostingTarget={target} onOpenOriginalHost={original => { setRequest(null); selectManualConnectionOwner(channel, original); setTarget(original); setIssue('') }} /> : null}
  </div>
}
