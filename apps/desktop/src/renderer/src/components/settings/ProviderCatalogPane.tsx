import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentCatalogEntry } from '@agentmux/core'
import { AgentProviderIcon, agentProviderLabel } from '../AgentProviderIcon'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')

/** Provider context groups global templates; it never changes their saved adapter identity. */
export function ProviderCatalogPane({ entries, read, executorCounts, selectedId, onSelect, onRefresh }: {
  entries: readonly AgentCatalogEntry[]
  read: { state: 'idle' | 'loading' | 'ready' | 'error'; error?: string }
  executorCounts: Readonly<Record<string, number>>
  selectedId: string | null
  onSelect: (id: string | null) => void
  onRefresh: () => void
}) {
  const provider = entries.find(entry => entry.id === selectedId)
  const ids = [...new Set([...entries.map(entry => entry.id), ...Object.keys(executorCounts)])]
  const loading = read.state === 'loading'
  return <section className="settings-provider-catalog" aria-label="Provider catalog">
    <header className="settings-provider-catalog__header">
      <strong>Provider</strong>
      <span>Filter your saved executors.</span>
      <button type="button" className="icon-button" disabled={loading} aria-label={read.state === 'error' ? 'Retry providers' : 'Refresh providers'} title={read.state === 'error' ? 'Retry providers' : 'Refresh providers'} onClick={onRefresh}>
        {loading ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionRefreshIcon size={13} />}
      </button>
    </header>
    <SettingsResourceLibrary label="Providers" layout="horizontal" selectedId={selectedId === null ? 'providers:all' : `provider:${selectedId}`}
      onSelect={id => onSelect(id === 'providers:all' ? null : id.slice('provider:'.length))} focusRequest={null}
      items={[
        { id: 'providers:all', name: 'All providers', detail: 'All global executor templates', mark: <ThemeObjectAgentIcon size={16} />, status: <span>{Object.values(executorCounts).reduce((sum, count) => sum + count, 0)}</span> },
        ...ids.map(id => ({ id: `provider:${id}`, name: entries.find(entry => entry.id === id)?.label ?? agentProviderLabel(id), detail: id,
          mark: <AgentProviderIcon providerId={id} size={18} />, status: <span>{executorCounts[id] ?? 0}</span> }))
      ]} />
    {read.state === 'error' ? <div className="settings-provider-catalog__notice" role="alert"><strong>Provider lookup failed</strong><p>{read.error}</p><small>Your saved executors and drafts are unchanged.{entries.length ? ' The last received providers remain available.' : ' Retry to load provider choices.'}</small></div> : null}
    {!entries.length && read.state !== 'error' ? <p className="settings-provider-catalog__empty" role="status"><strong>{loading ? 'Loading provider choices' : read.state === 'ready' ? 'No providers registered' : 'Provider choices unavailable'}</strong> · {read.state === 'ready' ? 'The connected service returned an empty provider catalog.' : 'You can continue editing saved executors.'}</p> : null}
    {selectedId !== null && !provider && entries.length ? <p className="settings-provider-catalog__empty" role="status">This saved Provider is absent from the current catalog. Existing executors remain editable; refresh the catalog before creating another.</p> : null}
    {provider ? <details className="settings-provider-metadata" data-provider-entry={provider.id}>
      <summary>About {provider.label}<code>{provider.executable}</code></summary>
      <dl className="settings-executor-identity">
        <div><dt>Provider ID</dt><dd><code>{provider.id}</code></dd></div>
        <div><dt>Conversation</dt><dd>{provider.capabilities.timeline === 'unavailable' ? 'Terminal conversation' : provider.capabilities.timeline === 'streaming' ? 'Live conversation' : 'Conversation history'}</dd></div>
        <div><dt>Permissions</dt><dd>{provider.capabilities.permission === 'respond' ? 'Permission responses' : provider.capabilities.permission === 'observe' ? 'Permission observation' : 'CLI permissions'}</dd></div>
        <div><dt>Session recovery</dt><dd>{provider.capabilities.providerResume ? 'Native resume' : 'No native resume'}</dd></div>
      </dl>
      <p>Declared adapter capabilities. Command availability is checked separately in each Host.</p>
    </details> : null}
  </section>
}
