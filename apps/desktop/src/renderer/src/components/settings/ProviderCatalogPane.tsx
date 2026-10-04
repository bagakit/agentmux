import { ArrowLeft, ArrowUpRight, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AgentCatalogEntry } from '@agentmux/core'
import { AgentProviderIcon } from '../AgentProviderIcon'

export function ProviderCatalogPane({ entries, read, saving, onRefresh, onBack, onCreate }: {
  entries: readonly AgentCatalogEntry[]
  read: { state: 'idle' | 'loading' | 'ready' | 'error'; error?: string }
  saving: boolean
  onRefresh: () => void
  onBack: () => void
  onCreate: (provider: AgentCatalogEntry) => void
}) {
  const loading = read.state === 'loading'
  return <section className="settings-provider-catalog" aria-label="Provider catalog">
    <header className="settings-provider-catalog__header">
      <button type="button" className="small-button" onClick={onBack}><ArrowLeft size={14} /> Executors</button>
      <button type="button" className="small-button" disabled={loading} onClick={onRefresh}>
        {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        {loading ? 'Loading providers…' : read.state === 'error' ? 'Retry providers' : 'Refresh providers'}
      </button>
    </header>
    <div className="settings-provider-catalog__intro">
      <h3>Providers</h3>
      <p>Providers adapt agent CLIs. Executors hold your launch configuration.</p>
      <small>Declared adapter capabilities. Command availability is checked separately in each environment.</small>
    </div>
    {read.state === 'error' ? <div className="settings-provider-catalog__notice" role="alert"><strong>Provider lookup failed</strong><p>{read.error}</p><small>Your saved executors and drafts are unchanged.{entries.length ? ' The last received providers remain below.' : ' Retry to load provider choices.'}</small></div> : null}
    {entries.length === 0 && read.state !== 'error' ? <div className="settings-provider-catalog__empty" role="status">
      <strong>{loading ? 'Loading provider choices' : read.state === 'ready' ? 'No providers registered' : 'Provider choices unavailable'}</strong>
      <p>{read.state === 'ready' ? 'The connected service returned an empty provider catalog.' : 'New executors need a confirmed provider. You can continue editing your saved executors.'}</p>
    </div> : entries.length > 0 ? <ul className="settings-provider-catalog__list">{entries.map(provider => <li key={provider.id} data-provider-entry={provider.id}>
      <div className="settings-provider-catalog__identity"><AgentProviderIcon providerId={provider.id} size={24} />
        <span><strong>{provider.label}</strong><small><code>{provider.id}</code> · <code>{provider.executable}</code></small></span>
      </div>
      <div className="settings-provider-catalog__capabilities">
        <span>{provider.capabilities.timeline === 'unavailable' ? 'Terminal conversation' : provider.capabilities.timeline === 'streaming' ? 'Live conversation' : 'Conversation history'}</span>
        <span>{provider.capabilities.permission === 'respond' ? 'Permission responses' : provider.capabilities.permission === 'observe' ? 'Permission observation' : 'CLI permissions'}</span>
        <span>{provider.capabilities.providerResume ? 'Native resume' : 'No native resume'}</span>
      </div>
      <button type="button" className="small-button" disabled={saving} aria-label={`Create executor with ${provider.label}`} onClick={() => onCreate(provider)}>Create executor <ArrowUpRight size={13} /></button>
    </li>)}</ul> : null}
  </section>
}
