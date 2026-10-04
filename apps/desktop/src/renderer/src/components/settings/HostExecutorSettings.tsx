import { useEffect, useState } from 'react'
import { Bot, Plus, RefreshCw, LoaderCircle, X } from 'lucide-react'
import type { AppConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { hostExecutorInventoryMatches, parseExecutorArgs } from '../../lib/executors'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { AgentAvatar } from '../AgentAvatar'
import { agentProviderLabel } from '../AgentProviderIcon'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { ServiceWindowNotice } from '../ServiceWindowNotice'

/** Read the executing Host's registry. Registration is an explicit complete configuration. */
export function HostExecutorSettings({ config, active }: { config: AppConfig; active: boolean }) {
  const [hostId, setHostId] = useState(() => config.workspaces.find(workspace => workspace.id === useAppStore.getState().activeWorkspaceId)?.hostId ?? config.hosts[0]?.id ?? '')
  const inventory = useAppStore(state => state.hostExecutorInventories[hostId])
  const detect = useAppStore(state => state.discoverHostExecutors)
  const providers = useAppStore(state => state.providerCatalog)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [executorId, setExecutorId] = useState('')
  const [label, setLabel] = useState('')
  const [providerId, setProviderId] = useState(() => providers[0]?.id ?? '')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('{}')
  const [guide, setGuide] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = config.hosts.find(item => item.id === hostId)
  // This panel always reads the Core registry, including on the receiving local Host.
  const descriptors = hostExecutorInventoryMatches(inventory, host) ? inventory.result?.executors ?? [] : []
  const selectedExecutor = descriptors.find(item => item.executorId === selected)
  const checking = inventory?.state === 'checking'
  useEffect(() => {
    if (active && host && !hostExecutorInventoryMatches(inventory, host)) void refresh()
  }, [active, hostId, host, inventory])
  async function refresh() {
    if (host && !checking) await detect(hostId)
  }
  async function register() {
    if (saving) return
    setSaving(true); setError(null)
    try {
      const environment: unknown = JSON.parse(env)
      if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.values(environment).some(value => typeof value !== 'string')) throw new Error('Environment must be a JSON object of string values.')
      await api.executors.register(hostId, { executorId, config: { label, providerId, command, args: parseExecutorArgs(args),
        env: environment as Record<string, string>, injectAgentMuxGuide: guide } })
      setSelected(executorId); setAdding(false); setEnv('{}'); setArgs('')
      await refresh()
    } catch (cause) { setError(presentError(cause)) }
    finally { setSaving(false) }
  }
  return <div className="settings-pane-stack" aria-label="Host executors">
    <div className="settings-pane-toolbar">
      <label className="settings-compact-field"><span>Run on</span><select aria-label="Executor Host" value={hostId} disabled={saving} onChange={event => { setHostId(event.target.value); setSelected(null); setQuery(''); setError(null) }}>
        {config.hosts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <span className="settings-resource-count">{descriptors.length} configurations</span>
      <button className="icon-button" aria-label="Refresh Host executors" disabled={checking} onClick={() => void refresh()}>{checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button>
      <button className="small-button" disabled={saving || !host} onClick={() => setAdding(true)}><Plus size={13} />Register command</button>
    </div>
    <p className="settings-group-note">Commands and launch configuration belong to {host?.label ?? hostId}. Custom wrappers need an explicit target command. Discovery does not install software.</p>
    {inventory?.state === 'error' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Host Executor discovery failed', mode: inventory.detail ?? 'Current Host inventory is unknown. The last configurations are retained.', restore: 'Refresh this Host after restoring its connection. Existing Sessions remain available.' } }} /> : null}
    {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    {adding ? <section className="agent-settings-card">
      <header className="agent-settings-card__header"><Bot size={18} /><strong>Register on {host?.label ?? hostId}</strong><button className="icon-button" aria-label="Cancel Host registration" disabled={saving} onClick={() => setAdding(false)}><X size={14} /></button></header>
      <p className="settings-group-note">Enter this Host's configuration. Saved credentials stay on that Host and are never returned. Replacing an existing registered configuration uses its revision through the public register command.</p>
      <div className="settings-grid">
        <label><span>Executor ID</span><input aria-label="Host Executor ID" value={executorId} onChange={event => setExecutorId(event.target.value)} /></label>
        <label><span>Name</span><input aria-label="Host Executor name" value={label} onChange={event => setLabel(event.target.value)} /></label>
        <label><span>Provider</span><select aria-label="Host Executor Provider" value={providerId} onChange={event => setProviderId(event.target.value)}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
        <label><span>Command on this Host</span><input aria-label="Host Executor command" placeholder="Command name or wrapper file" value={command} onChange={event => setCommand(event.target.value)} /></label>
        <label><span>Arguments</span><textarea aria-label="Host Executor arguments" value={args} onChange={event => setArgs(event.target.value)} /></label>
        <label><span>Environment JSON</span><textarea aria-label="Host Executor environment" value={env} onChange={event => setEnv(event.target.value)} /></label>
      </div>
      <label className="agent-guide-toggle"><input type="checkbox" checked={guide} onChange={event => setGuide(event.target.checked)} /><span>Inject AgentMux guide</span></label>
      <button className="primary-button" disabled={saving} onClick={() => void register()}>{saving ? 'Saving…' : 'Register command'}</button>
    </section> : <div className="settings-resource-split">
      <SettingsResourceLibrary label="Host Executors" selectedId={selected} query={query} onQuery={setQuery} onSelect={setSelected} focusRequest={null}
        items={descriptors.filter(item => `${item.label} ${item.executorId} ${item.command}`.toLowerCase().includes(query.toLowerCase())).map(item => ({ id: item.executorId, name: item.label,
          detail: `${agentProviderLabel(item.providerId)} · ${item.executorId}`,
          mark: <AgentAvatar executorId={item.executorId} providerId={item.providerId} label={item.label} size={22} />,
          status: <span>{inventory?.state === 'error' ? 'Check failed' : item.availability === 'available' ? 'Available' : item.availability === 'missing' ? 'Not found' : item.availability === 'check-failed' ? 'Check failed' : 'Not checked'}</span>
        }))} />
      <div className="settings-resource-editor">{selectedExecutor ? <section className="agent-settings-card"><header className="agent-settings-card__header"><AgentAvatar executorId={selectedExecutor.executorId} providerId={selectedExecutor.providerId} label={selectedExecutor.label} size={22} /><strong>{selectedExecutor.label}</strong></header>
        <dl className="settings-executor-identity"><div><dt>Host</dt><dd>{host?.label ?? hostId}</dd></div><div><dt>Command</dt><dd><code>{selectedExecutor.command}</code></dd></div><div><dt>Resolved executable</dt><dd><code>{selectedExecutor.executable ?? 'Not confirmed'}</code></dd></div><div><dt>Source</dt><dd>{selectedExecutor.source === 'registered' ? 'Registered on this Host' : 'Provider default'}</dd></div></dl>
        {selectedExecutor.cause ? <p className="settings-group-note">{selectedExecutor.cause.message}</p> : null}
      </section> : <div className="settings-resource-editor__empty"><Bot size={28} /><strong>{checking ? 'Reading Host configurations…' : inventory?.state === 'error' ? 'Host inventory is unknown' : 'Choose a Host Executor'}</strong><p>Inspect the command and availability supplied by this Host.</p></div>}</div>
    </div>}
  </div>
}
