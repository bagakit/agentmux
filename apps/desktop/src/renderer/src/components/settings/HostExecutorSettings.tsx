import { missingExecutableLabel } from '../../lib/executor-detection'
import { ExecutorLaunchPreview } from './ExecutorLaunchPreview'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { configValuesEqual } from '../../../../shared/config-edit'
import type { AppConfig, HostConfig, HostExecutorConfiguration } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { hostExecutorInventoryMatches, parseExecutorArgs } from '../../lib/executors'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { AgentAvatar } from '../AgentAvatar'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { ServiceWindowNotice } from '../ServiceWindowNotice'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionRegisterCommandIcon = semanticIconComponent('action.register-command')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')


// A display rename does not change the target that acknowledged a registration.
function registrationTarget(host: HostConfig | undefined) {
  if (!host) return undefined
  const { label: _label, ...target } = host
  return target
}

type RegistrationDraft = {
  executorId: string; label: string; providerId: string; command: string
  args: string; env: string; guide: boolean
}
type Registration = {
  adding: boolean
  value: RegistrationDraft
  accepted?: { host: HostConfig | undefined; value: RegistrationDraft; receipt: HostExecutorConfiguration }
}

type HookResult = AgentMuxRpcResult<'settings.executors.hooks-inspect'>
type HookObservation = { pending?: 'check' | 'update'; result?: HookResult; error?: string }
const hookHealth = { current: 'Configuration current', issue: 'Hook needs attention', unknown: 'Hook state unconfirmed', 'not-managed': 'No managed Hook' }

/** Read the executing Host's registry. Registration is an explicit complete configuration. */
export function HostExecutorSettings({ config, active, requestedHostId, requestedProviderId, hookNavigation }: {
  config: AppConfig; active: boolean; requestedHostId?: string | undefined; requestedProviderId?: string | undefined
  hookNavigation?: { executorId: string } | undefined
}) {
  const [hostId, setHostId] = useState(() => config.workspaces.find(workspace => workspace.id === useAppStore.getState().activeWorkspaceId)?.hostId ?? config.hosts[0]?.id ?? '')
  useEffect(() => { if (requestedHostId) setHostId(requestedHostId) }, [requestedHostId])
  const inventory = useAppStore(state => state.hostExecutorInventories[hostId])
  const detect = useAppStore(state => state.discoverHostExecutors)
  const providers = useAppStore(state => state.providerCatalog)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState(requestedProviderId)
  useEffect(() => {
    setProviderFilter(requestedProviderId)
    if (requestedProviderId) { setSelected(null); setQuery('') }
  }, [requestedHostId, requestedProviderId])
  useEffect(() => {
    if (hookNavigation) { setProviderFilter(undefined); setSelected(hookNavigation.executorId); setQuery('') }
  }, [hookNavigation])
  const [registration, setRegistration] = useState<Registration>(() => ({ adding: false, value: {
    executorId: '', label: '', providerId: providers[0]?.id ?? '', command: '', args: '', env: '{}', guide: true
  } }))
  const { adding, value, accepted } = registration
  const { executorId, label, providerId, command, args, env, guide } = value
  const update = (patch: Partial<RegistrationDraft>) => setRegistration(current => ({ ...current, value: { ...current.value, ...patch } }))
  const setAdding = (adding: boolean) => setRegistration(current => ({ ...current, adding }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removalError, setRemovalError] = useState<{ hostId: string; executorId: string; detail: string } | null>(null)
  const host = config.hosts.find(item => item.id === hostId)
  const acceptedHost = accepted && accepted.receipt.routeHostId === hostId && configValuesEqual(registrationTarget(accepted.host), registrationTarget(host))
  const acceptedTarget = acceptedHost && accepted.receipt.executor.executorId === executorId
  // This panel always reads the Core registry, including on the receiving local Host.
  const observed = hostExecutorInventoryMatches(inventory, host) ? inventory : undefined
  const descriptors = observed?.result?.executors ?? []
  const queryText = query.toLowerCase()
  const visibleDescriptors = descriptors.filter(item => (!providerFilter || item.providerId === providerFilter) &&
    `${item.label} ${item.executorId} ${item.command}`.toLowerCase().includes(queryText))
  const selectedExecutor = descriptors.find(item => item.executorId === selected && (!providerFilter || item.providerId === providerFilter))
  const runtimeId = observed?.result?.runtimeId
  const workspaces = config.workspaces.filter(workspace => workspace.hostId === hostId && !workspace.closeout)
  const [workspaceSelection, setWorkspaceSelection] = useState<{ hostId: string; executorId: string; revision: string; path: string }>()
  const workspacePath = selectedExecutor && workspaceSelection?.hostId === hostId && workspaceSelection.executorId === selectedExecutor.executorId &&
    workspaceSelection.revision === selectedExecutor.configRevision ? workspaceSelection.path : ''
  function chooseWorkspace(path: string) {
    if (selectedExecutor) setWorkspaceSelection({ hostId, executorId: selectedExecutor.executorId, revision: selectedExecutor.configRevision, path })
  }
  const [hookObservations, setHookObservations] = useState<Record<string, HookObservation>>({})
  const pendingHooks = useRef(new Set<string>())
  const hookKey = (item: { executorId: string; configRevision: string }) =>
    JSON.stringify([hostId, runtimeId, workspacePath, item.executorId, item.configRevision])
  const selectedHookKey = selectedExecutor ? hookKey(selectedExecutor) : null
  const hook = selectedHookKey ? hookObservations[selectedHookKey] : undefined
  const needsWorkspace = hook?.result?.inspection.code === 'HOOK_WORKSPACE_REQUIRED' ||
    hook?.result?.inspection.code === 'HOOK_NATIVE_LOADING_UNCONFIRMED'
  async function maintainHook(updateHook: boolean) {
    if (!selectedExecutor || !selectedHookKey || !runtimeId || pendingHooks.current.has(selectedHookKey)) return
    const key = selectedHookKey
    pendingHooks.current.add(key)
    setHookObservations(current => ({ ...current, [key]: {
      ...(current[key]?.result ? { result: current[key].result } : {}), pending: updateHook ? 'update' : 'check'
    } }))
    try {
      const result = await api.executors.hooks({ hostId, runtimeId, ...(workspacePath ? { workspacePath } : {}), executorId: selectedExecutor.executorId,
        configRevision: selectedExecutor.configRevision }, updateHook)
      setHookObservations(current => ({ ...current, [key]: { result } }))
    } catch (cause) {
      setHookObservations(current => ({ ...current, [key]: {
        ...(current[key]?.result ? { result: current[key].result } : {}), error: presentError(cause)
      } }))
    } finally {
      pendingHooks.current.delete(key)
    }
  }
  const autoCheckScope = !workspacePath || workspaces.some(workspace => workspace.path === workspacePath)
  useEffect(() => {
    if (active && !adding && selectedHookKey && autoCheckScope && !hook) void maintainHook(false)
  }, [active, adding, selectedHookKey, autoCheckScope, hook])
  const checking = inventory?.state === 'checking'
  useEffect(() => {
    if (active && host && !hostExecutorInventoryMatches(inventory, host)) void refresh()
  }, [active, hostId, host, inventory])
  async function refresh() {
    if (host && !checking) await detect(hostId)
  }
  async function register() {
    if (saving) return
    const submitted = value
    const submittedHost = host
    setSaving(true); setError(null)
    try {
      const environment: unknown = JSON.parse(env)
      if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.values(environment).some(value => typeof value !== 'string')) throw new Error('Environment must be a JSON object of string values.')
      const receipt = await api.executors.register(hostId, { executorId, ...(acceptedTarget ? { expectedRevision: accepted.receipt.executor.configRevision } : {}), config: { label, providerId, command, args: parseExecutorArgs(args),
        env: environment as Record<string, string>, injectAgentMuxGuide: guide } })
      setSelected(submitted.executorId)
      setRegistration(current => ({ ...current, adding: !configValuesEqual(current.value, submitted),
        accepted: { host: submittedHost, value: submitted, receipt } }))
      await refresh()
    } catch (cause) { setError(presentError(cause)) }
    finally { setSaving(false) }
  }
  async function unregister() {
    if (saving || !host || selectedExecutor?.source !== 'registered' || !selectedExecutor.registrationRevision) return
    const submitted = selectedExecutor
    setSaving(true); setError(null); setRemovalError(null)
    try {
      await api.executors.unregister({ hostId, executorId: submitted.executorId, expectedRegistrationRevision: submitted.registrationRevision! })
      setRegistration(current => {
        if (current.accepted?.receipt.executor.executorId !== submitted.executorId) return current
        const { accepted: _removed, ...remaining } = current
        return remaining
      })
      await refresh()
    } catch (cause) { setRemovalError({ hostId, executorId: submitted.executorId, detail: presentError(cause) }) }
    finally { setSaving(false) }
  }
  return <div className="settings-pane-stack settings-host-executors" aria-label="Host executors">
    <div className="settings-pane-toolbar">
      <label className="settings-compact-field"><span>Run on</span><select aria-label="Executor Host" value={hostId} disabled={saving} onChange={event => { setHostId(event.target.value); setProviderFilter(undefined); setSelected(null); setQuery(''); setError(null) }}>
        {config.hosts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <span className="settings-resource-count">{descriptors.length} configurations</span>
      <button className="icon-button" aria-label="Refresh Host executors" disabled={checking} onClick={() => void refresh()}>{checking ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionRefreshIcon size={14} />}</button>
      <button className="small-button" disabled={saving || !host} onClick={() => setAdding(true)}><ThemeActionRegisterCommandIcon size={13} />Register command</button>
    </div>
    {providerFilter ? <div className="settings-pane-toolbar"><span>Provider <strong>{providers.find(item => item.id === providerFilter)?.label ?? agentProviderLabel(providerFilter)}</strong></span><button className="small-button" type="button" onClick={() => setProviderFilter(undefined)}>Show all executors</button></div> : null}
    <p className="settings-group-note">Commands and launch configuration belong to {host?.label ?? hostId}. Custom wrappers need an explicit target command. Discovery does not install software.</p>
    {inventory?.state === 'error' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Host Executor discovery failed', mode: inventory.detail ?? 'Current Host inventory is unknown. The last configurations are retained.', restore: 'Refresh this Host after restoring its connection. Existing Sessions remain available.' } }} /> : null}
    {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    {removalError?.hostId === hostId && removalError.executorId === selected ? <p role="alert" className="dialog-error">{removalError.detail}</p> : null}
    {adding ? <section className="agent-settings-card">
      <header className="agent-settings-card__header"><ThemeObjectAgentIcon size={18} /><strong>Register on {host?.label ?? hostId}</strong><button className="icon-button" aria-label="Cancel Host registration" disabled={saving} onClick={() => setAdding(false)}><ThemeActionCancelIcon size={14} /></button></header>
      <p className="settings-group-note">Enter this Host's configuration. Saved credentials stay on that Host and are never returned. Replacing an existing registered configuration uses its revision through the public register command.</p>
      {acceptedHost ? <p className="settings-group-note" role="status">{configValuesEqual(value, accepted.value) ? 'Registration saved.' : 'The submitted registration was saved. Your later edits are not registered yet.'}</p> : null}
      <div className="agent-settings-fields">
        <label><span>Executor ID</span><TextInput aria-label="Host Executor ID" value={executorId} onChange={event => update({ executorId: event.target.value })} /></label>
        <label><span>Name</span><TextInput aria-label="Host Executor name" value={label} onChange={event => update({ label: event.target.value })} /></label>
        <label><span>Provider</span><select aria-label="Host Executor Provider" value={providerId} onChange={event => update({ providerId: event.target.value })}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
        <label><span>Executable on this Host</span><TextInput aria-label="Host Executor command" placeholder="executable name or absolute path" value={command} onChange={event => update({ command: event.target.value })} /></label>
        <p className="settings-group-note">One executable name or path on this Host, without arguments or shell quotes. Paths may contain spaces.</p>
        <label><span>Arguments <small>shell-style quoting</small></span><ComposerTextarea aria-label="Host Executor arguments" value={args} onValueChange={args => update({ args })} /></label>
        <ExecutorLaunchPreview command={command} args={args} />
        <label><span>Environment JSON</span><ComposerTextarea aria-label="Host Executor environment" value={env} onValueChange={env => update({ env })} /></label>
      </div>
      <div className="settings-host-executor-actions">
      <label className="agent-guide-toggle"><input type="checkbox" checked={guide} onChange={event => update({ guide: event.target.checked })} /><span>Inject AgentMux guide</span></label>
      <button className="primary-button" disabled={saving} onClick={() => void register()}>{saving ? 'Saving…' : 'Register command'}</button>
      </div>
    </section> : <div className="settings-resource-split">
      <SettingsResourceLibrary label="Host Executors" selectedId={selected} query={query} onQuery={setQuery} onSelect={setSelected} focusRequest={null}
        items={visibleDescriptors.length === 0 && observed?.state !== 'ready' ? null : visibleDescriptors.map(item => ({ id: item.executorId, name: item.label,
          detail: `${agentProviderLabel(item.providerId)} · ${item.executorId}`,
          mark: <AgentAvatar executorId={item.executorId} providerId={item.providerId} label={item.label} size={22} />,
          status: <><span>{inventory?.state === 'error' ? 'Check failed' : item.availability === 'available' ? 'Available' : item.availability === 'missing' ? missingExecutableLabel(item.cause) : item.availability === 'check-failed' ? 'Check failed' : 'Not checked'}</span>
            {hookObservations[hookKey(item)]?.result?.health === 'issue' ? <span className="settings-hook-problem-dot" role="img" aria-label="Hook needs attention" title="Hook needs attention" /> : null}</>
        }))} />
      <div className="settings-resource-editor">{selectedExecutor ? <section className="agent-settings-card"><header className="agent-settings-card__header"><AgentAvatar executorId={selectedExecutor.executorId} providerId={selectedExecutor.providerId} label={selectedExecutor.label} size={22} /><strong>{selectedExecutor.label}</strong></header>
        <dl className="settings-executor-identity"><div><dt>Host</dt><dd>{host?.label ?? hostId}</dd></div><div><dt>Command</dt><dd><code>{selectedExecutor.command}</code></dd></div><div><dt>Resolved executable</dt><dd><code>{selectedExecutor.executable ?? 'Not confirmed'}</code></dd></div><div><dt>Source</dt><dd>{selectedExecutor.source === 'registered' ? 'Registered on this Host' : selectedExecutor.source === 'configured' ? 'Saved on this Host' : 'Provider default'}</dd></div></dl>
        <section className="settings-executor-hooks" aria-label="Managed Hook">
          <div className="settings-host-executor-actions">
            <strong>Managed Hook</strong>
            <button className="small-button" type="button" disabled={!runtimeId || Boolean(hook?.pending)} onClick={() => void maintainHook(false)}>Check Hook</button>
            {hook?.result?.canUpdate ? <button className="small-button" type="button" disabled={Boolean(hook.pending) || Boolean(hook.error) || hook.result.update.status === 'unconfirmed'} onClick={() => void maintainHook(true)}>Update configuration</button> : null}
          </div>
          {needsWorkspace || workspacePath ? <label className="settings-compact-field"><span>Workspace</span>{workspaces.length > 0
            ? <select aria-label="Hook workspace" value={workspacePath} onChange={event => chooseWorkspace(event.target.value)}>
              <option value="">Choose a workspace</option>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.path}>{workspace.name}</option>)}
            </select>
            : <TextInput aria-label="Hook workspace" placeholder="Absolute path on this Host" value={workspacePath} onChange={event => chooseWorkspace(event.target.value)} />}
          </label> : null}
          <div className="settings-executor-hooks__result" role="status">
            <strong>{hook?.pending === 'update' ? 'Updating Hook…' : hook?.pending ? 'Checking Hook…' : hook?.error ? 'Hook check unconfirmed' : hook?.result ? hookHealth[hook.result.health] : 'Hook not checked'}</strong>
            {hook?.error ? <p>{hook.error}</p> : null}
            {hook?.result?.inspection.targets.map(target => <div key={target.path}>
              <code>{target.path}</code>
              {target.legacyDeclarations ? <p>{target.legacyDeclarations} older {target.legacyDeclarations === 1 ? 'declaration' : 'declarations'}{target.missingLegacyEntrypoints ? ` · ${target.missingLegacyEntrypoints} with a missing executable or runner` : ''}</p> : null}
            </div>)}
            {hook?.result?.inspection.action ? <p>{hook.result.inspection.action}</p> : null}
            {hook?.result?.inspection.targets.length ? <p>Delivery to existing runs is not checked here.</p> : null}
            {hook?.result?.update.status === 'updated' ? <p>Managed configuration updated. Loading by existing Runs is unconfirmed.</p> : null}
            {hook?.result?.update.status === 'unchanged' ? <p>The managed configuration required no write.</p> : null}
            {hook?.result?.update.status === 'unconfirmed' ? <p>Update unconfirmed ({hook.result.update.code}). Check the Hook again before retrying.</p> : null}
            {hook?.result?.update.status === 'not-applicable' ? <p>This Hook has no configuration update for the selected Executor.</p> : null}
          </div>
        </section>
        {selectedExecutor.source === 'registered' ? <div>
          <p className="settings-group-note">Remove only this Host registration. A same-ID Provider default may remain. Retained Sessions, history and admitted launches keep their required registration.</p>
          <div className="settings-host-executor-actions"><button className="small-button" disabled={saving || !selectedExecutor.registrationRevision} onClick={() => void unregister()}>Remove registration</button></div>
        </div> : null}
        {selectedExecutor.cause ? <p className="settings-group-note">{selectedExecutor.cause.message}</p> : null}
      </section> : <div className="settings-resource-editor__empty"><ThemeObjectAgentIcon size={28} /><strong>{checking ? 'Reading Host configurations…' : inventory?.state === 'error' ? 'Host inventory is unknown' : 'Choose a Host Executor'}</strong><p>Inspect the command and availability supplied by this Host.</p></div>}</div>
    </div>}
  </div>
}
