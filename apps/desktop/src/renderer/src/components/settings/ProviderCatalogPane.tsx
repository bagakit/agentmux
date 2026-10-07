import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState } from 'react'
import type { AgentCatalogEntry } from '@agentmux/core'
import { AgentProviderIcon } from '../AgentProviderIcon'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionCreateExecutorIcon = semanticIconComponent('action.create-executor')

/** Adapter declarations are distinct from saved launch configurations and availability. */
export function ProviderCatalogPane({ entries, read, saving, executorCounts, onRefresh, onCreate }: {
  entries: readonly AgentCatalogEntry[]
  read: { state: 'idle' | 'loading' | 'ready' | 'error'; error?: string }
  saving: boolean
  executorCounts: Readonly<Record<string, number>>
  onRefresh: () => void
  onCreate: (provider: AgentCatalogEntry) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const provider = entries.find(entry => entry.id === selectedId) ?? entries[0]
  const loading = read.state === 'loading'
  return <section className="settings-provider-catalog" aria-label="Provider catalog">
    <header className="settings-provider-catalog__header">
      <p>Providers adapt agent CLIs. Executors hold your launch configuration.</p>
      <span className="settings-resource-count">{entries.length || read.state === 'ready' ? `${entries.length} providers` : loading ? 'Loading providers...' : 'Provider catalog'}</span>
      <button type="button" className="small-button" disabled={loading} onClick={onRefresh}>
        {loading ? <ThemeStatusLoadingIcon className="spin" size={13} /> : <ThemeActionRefreshIcon size={13} />}
        {loading ? 'Loading providers...' : read.state === 'error' ? 'Retry providers' : 'Refresh providers'}
      </button>
    </header>
    {read.state === 'error' ? <div className="settings-provider-catalog__notice" role="alert"><strong>Provider lookup failed</strong><p>{read.error}</p><small>Your saved executors and drafts are unchanged.{entries.length ? ' The last received providers remain below.' : ' Retry to load provider choices.'}</small></div> : null}
    {entries.length === 0 && read.state !== 'error' ? <div className="settings-provider-catalog__empty" role="status">
      <strong>{loading ? 'Loading provider choices' : read.state === 'ready' ? 'No providers registered' : 'Provider choices unavailable'}</strong>
      <p>{read.state === 'ready' ? 'The connected service returned an empty provider catalog.' : 'New executors need a confirmed provider. You can continue editing your saved executors.'}</p>
    </div> : entries.length > 0 ? <>
      <SettingsResourceLibrary label="Providers" layout="horizontal" selectedId={provider?.id ?? null} onSelect={setSelectedId}
        query={query} onQuery={setQuery} focusRequest={null}
        items={entries.filter(entry => `${entry.label} ${entry.id} ${entry.executable}`.toLowerCase().includes(query.trim().toLowerCase())).map(entry => ({
          id: entry.id, name: entry.label, detail: entry.executable,
          mark: <AgentProviderIcon providerId={entry.id} size={22} />,
          status: <span title="Executor templates">{executorCounts[entry.id] ?? 0}</span>
        }))} />
      {provider ? <article className="settings-provider-detail" data-provider-entry={provider.id}>
        <header className="settings-resource-editor__header">
          <AgentProviderIcon providerId={provider.id} size={32} />
          <span className="settings-provider-detail__name"><strong>{provider.label}</strong><small>CLI adapter</small></span>
          <button type="button" className="small-button" disabled={saving} aria-label={`Create executor with ${provider.label}`} onClick={() => onCreate(provider)}><ThemeActionCreateExecutorIcon size={14} />Create executor</button>
        </header>
        <section className="settings-provider-detail__section">
          <h4>Adapter</h4>
          <dl className="settings-executor-identity">
            <div><dt>Provider ID</dt><dd><code>{provider.id}</code></dd></div>
            <div><dt>Default command</dt><dd><code>{provider.executable}</code></dd></div>
            <div><dt>Executor templates</dt><dd>{executorCounts[provider.id] ?? 0}</dd></div>
          </dl>
        </section>
        <section className="settings-provider-detail__section">
          <h4>Capabilities</h4>
          <dl className="settings-executor-identity">
            <div><dt>Conversation</dt><dd>{provider.capabilities.timeline === 'unavailable' ? 'Terminal conversation' : provider.capabilities.timeline === 'streaming' ? 'Live conversation' : 'Conversation history'}</dd></div>
            <div><dt>Permissions</dt><dd>{provider.capabilities.permission === 'respond' ? 'Permission responses' : provider.capabilities.permission === 'observe' ? 'Permission observation' : 'CLI permissions'}</dd></div>
            <div><dt>Session recovery</dt><dd>{provider.capabilities.providerResume ? 'Native resume' : 'No native resume'}</dd></div>
          </dl>
          <p className="settings-group-note">Declared adapter capabilities. Command availability is checked separately in each environment.</p>
        </section>
      </article> : null}
    </> : null}
  </section>
}
