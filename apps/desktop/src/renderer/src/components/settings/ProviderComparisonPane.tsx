import { useEffect, useState } from 'react'
import type { AgentCatalogEntry, AgentMuxRpcResult } from '@agentmux/core'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'

const RefreshIcon = semanticIconComponent('action.refresh')
const RemoveIcon = semanticIconComponent('action.cancel')
const timeline = { unavailable: 'Terminal only', 'complete-events': 'Recorded events', streaming: 'Live stream' }
const permissions = { none: 'CLI only', observe: 'Observe', respond: 'Respond' }
const hookSetup = { 'explicit-managed': 'Managed configuration', 'launch-carried': 'At launch', unmanaged: 'Provider managed' }

const comparisons: ReadonlyArray<{ title: string; value(entry: AgentCatalogEntry): string }> = [
  { title: 'Conversation', value: entry => timeline[entry.capabilities.timeline] },
  { title: 'Permissions', value: entry => permissions[entry.capabilities.permission] },
  { title: 'Session recovery', value: entry => entry.capabilities.providerResume ? 'Native resume' : 'None declared' },
  { title: 'Hook setup', value: entry => entry.hookStrategy.kind === 'native' ? hookSetup[entry.hookStrategy.installation] : 'None declared' },
  { title: 'ACP', value: entry => entry.acpStrategy.kind === 'adapter' ? 'Adapter' : 'None declared' },
  { title: 'Launch options', value: entry => entry.launchOptions.map(option => option.label).join(', ') || 'None declared' },
]

type Catalog = AgentMuxRpcResult<'agent.provider.ls'>
type CatalogRead = {
  host: HostConfig
  state: 'loading' | 'ready' | 'error'
  catalog?: Catalog | undefined
  error?: string | undefined
}

export function ProviderComparisonPane({ hosts, active, requestedHostId, onExecutors }: {
  hosts: readonly HostConfig[]
  active: boolean
  requestedHostId?: string | undefined
  onExecutors(hostId: string, providerId: string): void
}) {
  const [hostId, setHostId] = useState(() => requestedHostId ?? hosts.find(host => host.kind === 'local')?.id ?? hosts[0]?.id ?? '')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [read, setRead] = useState<CatalogRead>()
  const host = hosts.find(item => item.id === hostId)
  const current = read?.host === host ? read : undefined

  useEffect(() => {
    if (requestedHostId) setHostId(requestedHostId)
  }, [requestedHostId])
  useEffect(() => {
    if (!active || !host) return
    let current = true
    setRead(previous => ({ host, state: 'loading', catalog: previous?.host === host ? previous.catalog : undefined }))
    void api.providers.forHost(host.id).then(catalog => {
      if (!current) return
      if (catalog.routeHostId !== host.id) throw new Error('The reply belongs to another Host.')
      setRead({ host, state: 'ready', catalog })
    }).catch(cause => {
      if (current) setRead(previous => ({ host, state: 'error', catalog: previous?.host === host ? previous.catalog : undefined, error: presentError(cause) }))
    })
    return () => { current = false }
  }, [active, host, refresh])

  const entries = current?.catalog?.catalog ?? []
  const selectedEntries = entries.filter(entry => selected.has(entry.id))
  const columns = selectedEntries.length ? selectedEntries : entries
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return <section data-settings-field="providers" className="settings-pane-stack provider-comparison" aria-label="Provider capabilities" hidden={!active}>
    <div className="settings-pane-toolbar">
      <label className="settings-compact-field"><span>Host</span>
        <select aria-label="Provider Host" value={hostId} onChange={event => {
          setSelected(new Set())
          setHostId(event.target.value)
        }}>
          {!host ? <option value={hostId}>{hostId ? 'Unavailable Host' : 'Choose a Host'}</option> : null}
          {hosts.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </label>
      <button type="button" className="icon-button" aria-label="Refresh Provider capabilities" disabled={!host || current?.state === 'loading'} onClick={() => setRefresh(value => value + 1)}><RefreshIcon size={14} /></button>
    </div>
    {!host ? <p role="status">Choose a saved Host to compare its Providers.</p> : null}
    {current?.state === 'error' ? <p className="settings-inline-error" role="status">{current.error}{entries.length ? ' Showing the last catalog from this Host.' : ''}</p> : null}
    {current?.state === 'loading' && !entries.length ? <p role="status">Reading this Host’s Provider catalog…</p> : null}
    {current?.state === 'ready' && !entries.length ? <p role="status">This Host reports no registered Providers.</p> : null}
    {entries.length ? <>
      <p className="settings-group-note">Compare capabilities declared by this Host. For executable and Hook checks, open Executors.</p>
      <SettingsResourceLibrary label="Compare providers" layout="horizontal" items={entries.map(entry => ({
        id: entry.id, name: entry.label, detail: entry.executable, mark: <AgentProviderIcon providerId={entry.id} size={17} />
      }))} selectedId={null} onSelect={toggle} focusRequest={null} selection={{ ids: selected, onToggle: toggle }} />
      <div className="provider-comparison__viewport" role="region" aria-label="Provider comparison table" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Capability</th>{columns.map(entry => <th scope="col" key={entry.id}>
            <div className="provider-comparison__column-title"><span>{entry.label}</span>
              {selected.has(entry.id) ? <button className="icon-button" type="button" aria-label={`Remove ${entry.label} from comparison`} onClick={() => toggle(entry.id)}><RemoveIcon size={12} /></button> : null}
            </div>
            <code>{entry.executable}</code>
          </th>)}</tr></thead>
          <tbody>{comparisons.map(row => <tr key={row.title}><th scope="row">{row.title}</th>{columns.map(entry => <td key={entry.id}>{row.value(entry)}</td>)}</tr>)}
            <tr><th scope="row">Executors</th>{columns.map(entry => <td key={entry.id}>
              <button className="small-button" type="button" aria-label={`View ${entry.label} executors`} onClick={() => onExecutors(hostId, entry.id)}>View executors</button>
            </td>)}</tr>
          </tbody>
        </table>
      </div>
    </> : null}
  </section>
}
