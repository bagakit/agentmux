import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { AgentCatalogEntry, AgentMuxRpcResult } from '@agentmux/core'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { SearchInput } from '@agentmux/client-ui/input'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ProviderObservations, useProviderObservations, type ProviderObservationSnapshot } from './ProviderObservations'

type Fact = {
  label: string
  icon: ComponentProps<typeof SemanticIcon>['name']
  tone?: 'positive' | 'muted' | undefined
}

const noneDeclared: Fact = { label: 'None declared', icon: 'action.collapse', tone: 'muted' }
const timeline: Record<AgentCatalogEntry['capabilities']['timeline'], Fact> = {
  unavailable: { label: 'Terminal only', icon: 'object.terminal' },
  'complete-events': { label: 'Recorded events', icon: 'object.activity' },
  streaming: { label: 'Live stream', icon: 'status.streaming', tone: 'positive' }
}
const permissions: Record<AgentCatalogEntry['capabilities']['permission'], Fact> = {
  none: { label: 'CLI only', icon: 'object.terminal' },
  observe: { label: 'Observe', icon: 'status.permission' },
  respond: { label: 'Respond', icon: 'status.permission-safe', tone: 'positive' }
}
const hookSetup: Record<Extract<AgentCatalogEntry['hookStrategy'], { kind: 'native' }>['installation'], Fact> = {
  'explicit-managed': { label: 'Managed config', icon: 'action.adjust' },
  'launch-carried': { label: 'At launch', icon: 'action.start' },
  unmanaged: { label: 'Provider managed', icon: 'object.component' }
}

const comparisons: ReadonlyArray<{ id: string; title: string; value(entry: AgentCatalogEntry): Fact }> = [
  { id: 'conversation', title: 'Conversation', value: entry => timeline[entry.capabilities.timeline] },
  { id: 'permissions', title: 'Permissions', value: entry => permissions[entry.capabilities.permission] },
  { id: 'recovery', title: 'Session recovery', value: entry => entry.capabilities.providerResume ? { label: 'Native resume', icon: 'object.session-recovery' } : noneDeclared },
  { id: 'hooks', title: 'Hook setup', value: entry => entry.hookStrategy.kind === 'native' ? hookSetup[entry.hookStrategy.installation] : noneDeclared },
  { id: 'acp', title: 'ACP', value: entry => entry.acpStrategy.kind === 'adapter' ? { label: 'Adapter', icon: 'object.link' } : noneDeclared },
  { id: 'launch', title: 'Launch options', value: entry => {
    const label = entry.launchOptions.map(option => option.label).join(', ')
    return label ? { label, icon: 'object.subcommand' } : noneDeclared
  } }
]
const noSelection = { ids: new Set<string>(), only: false }

type Catalog = AgentMuxRpcResult<'agent.provider.ls'>
type CatalogRead = {
  host: HostConfig
  state: 'loading' | 'ready' | 'error'
  catalog?: Catalog | undefined
  error?: string | undefined
}

function ComparisonFact({ label, icon, tone }: Fact) {
  return <span className="provider-comparison__fact" data-tone={tone}>
    <SemanticIcon name={icon} size={14} aria-hidden="true" />
    <span>{label}</span>
  </span>
}

function ExecutorCount({ providerId, observations }: { providerId: string; observations: ProviderObservationSnapshot }) {
  const { executors, executorState } = observations
  const count = executors ? executors.countsByProvider.get(providerId) ?? 0 : undefined
  const label = count === undefined
    ? (executorState === 'loading' ? 'Reading…' : 'Unconfirmed')
    : `${count} ${count === 1 ? 'entry' : 'entries'}${executorState === 'ready' ? '' : ' · Last read'}`
  return <ComparisonFact label={label} icon={count === undefined ? 'status.unknown' : 'object.terminal'} tone={executorState === 'ready' ? undefined : 'muted'} />
}

export function ProviderComparisonPane({ hosts, active, requestedHostId, onExecutors, maintenance }: {
  hosts: readonly HostConfig[]
  active: boolean
  requestedHostId?: string | undefined
  onExecutors(hostId: string, providerId: string): void
  maintenance?: ((host: HostConfig) => ReactNode) | undefined
}) {
  const [hostId, setHostId] = useState(() => requestedHostId ?? hosts.find(host => host.kind === 'local')?.id ?? hosts[0]?.id ?? '')
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(noSelection)
  const selectedFilter = useRef<HTMLButtonElement>(null)
  const [read, setRead] = useState<CatalogRead>()
  const host = hosts.find(item => item.id === hostId)
  const current = read?.host === host ? read : undefined
  const observations = useProviderObservations(host, active, refresh)

  useEffect(() => {
    if (requestedHostId) {
      setHostId(requestedHostId)
      setSelection(noSelection)
    }
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
  const refreshing = Boolean(host && (!current || current.state === 'loading'))
  const selectedCount = entries.filter(entry => selection.ids.has(entry.id)).length
  const selectedOnly = selection.only && selectedCount > 0
  const needle = query.trim().toLowerCase()
  const visibleEntries = entries.filter(entry => (!selectedOnly || selection.ids.has(entry.id)) &&
    [entry.label, entry.id, entry.executable].some(value => value.toLowerCase().includes(needle)))
  const maintenanceControl = active && host ? maintenance?.(host) : null

  function toggleSelection(id: string, checkbox: HTMLInputElement) {
    if (selectedOnly && selectedCount > 1 && checkbox === checkbox.ownerDocument.activeElement) {
      const row = checkbox.closest('tr')
      const neighbor = row?.nextElementSibling ?? row?.previousElementSibling
      const nextFocus = neighbor?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? selectedFilter.current
      nextFocus?.focus()
    }
    setSelection(previous => {
      const ids = new Set(previous.ids)
      if (ids.has(id)) ids.delete(id)
      else ids.add(id)
      return { ids, only: previous.only && ids.size > 0 }
    })
  }

  return <section data-settings-field="providers" className="settings-pane-stack provider-comparison" aria-label="Provider capabilities" hidden={!active}>
    <div className="provider-comparison__toolbar">
      <label className="settings-compact-field"><span>Host</span>
        <select aria-label="Provider Host" value={hostId} onChange={event => {
          setSelection(noSelection)
          setHostId(event.target.value)
        }}>
          {!host ? <option value={hostId}>{hostId ? 'Unavailable Host' : 'Choose a Host'}</option> : null}
          {hosts.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </label>
      <button type="button" className="small-button provider-comparison__refresh" aria-label="Refresh Provider capabilities"
        disabled={!host} onClick={() => setRefresh(value => value + 1)}>
        <SemanticIcon name="action.refresh" size={14} aria-hidden="true" /> Refresh
      </button>
      <SearchInput aria-label="Filter providers" placeholder="Find a provider…" clearLabel="Clear provider filter"
        className="provider-comparison__search" value={query} onValueChange={setQuery} />
    </div>
    {host ? <ProviderObservations observations={observations} /> : null}
    <div className="provider-comparison__matrix">
      <div className="provider-comparison__matrix-head">
        <div>
          <div className="provider-comparison__title">
            <h3>Capabilities</h3>
            {entries.length ? <span className="provider-comparison__count" aria-live="polite">
              {visibleEntries.length === entries.length ? entries.length : `${visibleEntries.length} of ${entries.length}`} {entries.length === 1 ? 'provider' : 'providers'}
            </span> : null}
          </div>
          <p>Base capabilities declared by this Host. Open an Executor to inspect its CLI and Hook.</p>
        </div>
        {selectedCount || maintenanceControl ? <div className="provider-comparison__matrix-actions">
          {selectedCount ? <button ref={selectedFilter} className={`small-button${selectedOnly ? ' small-button--active' : ''}`} type="button"
            aria-pressed={selectedOnly} onClick={() => setSelection(previous => ({ ...previous, only: !selectedOnly }))}>
            <SemanticIcon name={selectedOnly ? 'status.selected' : 'action.filter'} size={13} aria-hidden="true" />
            Selected only ({selectedCount})
          </button> : null}
          {maintenanceControl}
        </div> : null}
      </div>
      {!host ? <p role="status">Choose a saved Host to compare its Providers.</p> : null}
      {current?.state === 'error' ? <p className="settings-inline-error" role="status">Catalog read failed. {current.error}{current.catalog ? ' Showing the last catalog from this Host.' : ''}</p> : null}
      {refreshing ? <p className="provider-comparison__read" role="status">{current?.catalog ? 'Refreshing catalog. Showing the last declarations.' : 'Reading this Host’s Provider catalog…'}</p> : null}
      {current?.state === 'ready' && !entries.length ? <p role="status">This Host reports no registered Providers.</p> : null}
      {entries.length && !visibleEntries.length ? <p className="provider-comparison__empty" role="status">No providers match your filter.</p> : null}
      {visibleEntries.length ? <div className="provider-comparison__viewport">
        <table aria-label="Provider comparison table" role="table">
          <colgroup><col className="provider-comparison__col-provider" /><col className="provider-comparison__col-executors" />
            {comparisons.map(column => <col className={`provider-comparison__col-${column.id}`} key={column.id} />)}
          </colgroup>
          <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Provider</th><th scope="col" role="columnheader">Executors</th>
            {comparisons.map(column => <th scope="col" role="columnheader" key={column.id}>{column.title}</th>)}
          </tr></thead>
          <tbody role="rowgroup">{visibleEntries.map(entry => <tr role="row" key={entry.id} data-provider-id={entry.id} data-selected={selection.ids.has(entry.id)}>
            <th scope="row" role="rowheader"><div className="provider-comparison__identity">
              <label className="provider-comparison__check"><input type="checkbox" aria-label={`Select ${entry.label} for comparison`}
                checked={selection.ids.has(entry.id)} onChange={event => toggleSelection(entry.id, event.currentTarget)} /></label>
              <AgentProviderIcon providerId={entry.id} size={20} />
              <span><strong>{entry.label}</strong><code>{entry.executable}</code></span>
            </div></th>
            <td role="cell">
              <span className="provider-comparison__cell-title" aria-hidden="true">Executors</span>
              <ExecutorCount providerId={entry.id} observations={observations} />
              <button className="provider-comparison__open" type="button" aria-label={`Manage ${entry.label} executors`}
                onClick={() => onExecutors(hostId, entry.id)}>
                Manage <SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />
              </button>
            </td>
            {comparisons.map(column => <td role="cell" key={column.id}>
              <span className="provider-comparison__cell-title" aria-hidden="true">{column.title}</span>
              <ComparisonFact {...column.value(entry)} />
            </td>)}
          </tr>)}</tbody>
        </table>
      </div> : null}
    </div>
  </section>
}
