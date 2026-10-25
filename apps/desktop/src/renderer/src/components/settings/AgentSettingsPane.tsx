import { ExecutorLaunchPreview } from './ExecutorLaunchPreview'
import { configValuesEqual } from '../../../../shared/config-edit'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENT_AVATAR_BADGE_IDS, AGENT_AVATAR_BADGE_LABELS } from '../../../../shared/contracts'
import { AgentAvatar } from '../AgentAvatar'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { quote } from 'shlex'
import type { AgentExecutorConfig, AppConfig, AgentAvatarAppearance, AgentAvatarBadge } from '../../../../shared/contracts'
import { executorDetectionKey, useAppStore } from '../../store'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { agentProviderLabel } from '../AgentProviderIcon'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { withUnrestrictedLaunchArgs } from '@agentmux/core/provider-launch-options'
import { parseExecutorArgs } from '../../lib/executors'
export { parseExecutorArgs } from '../../lib/executors'
import { HostExecutorSettings } from './HostExecutorSettings'
import { currentExecutorDetection, executorDetectionLabel } from '../../lib/executor-detection'
import { useResourceDrafts } from './use-resource-drafts'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { ProviderCatalogPane } from './ProviderCatalogPane'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import './settings-agents-editor.css'

const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeStatusFailedIcon = semanticIconComponent('status.failed')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionCreateExecutorIcon = semanticIconComponent('action.create-executor')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusUnrestrictedIcon = semanticIconComponent('status.unrestricted')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')


const NO_DETECTIONS: ReturnType<typeof useAppStore.getState>['executorDetections'] = {}

type ExecutorDraft = {
  label: string
  providerId: string
  command: string
  args: string
  env: string
  injectAgentMuxGuide: boolean
  avatar?: AgentAvatarAppearance | undefined
}

function toDraft(config: AgentExecutorConfig): ExecutorDraft {
  return {
    label: config.label,
    providerId: config.providerId,
    command: config.command,
    args: config.args.map(quote).join('\n'),
    env: JSON.stringify(config.env, null, 2),
    injectAgentMuxGuide: config.injectAgentMuxGuide,
    avatar: config.avatar
  }
}

function parseEnv(text: string): Record<string, string> {
  let env: unknown
  try { env = JSON.parse(text) } catch { throw new Error('Environment must be a JSON object of string values.') }
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new Error('Environment must be a JSON object of string values.')
  }
  return env as Record<string, string>
}

function statusCopy(state: ReturnType<typeof useAppStore.getState>['executorDetections'][string] | undefined) {
  const label = executorDetectionLabel(state)
  switch (state?.state) {
    case 'ready': return { label, icon: <ThemeStatusCompletedIcon size={13} /> }
    case 'checking': return { label, icon: <ThemeStatusLoadingIcon animation="spin" size={13} /> }
    case 'error': return { label, icon: <ThemeStatusWarningIcon size={13} /> }
    default: return { label, icon: <ThemeStatusFailedIcon size={13} /> }
  }
}

export function assertExecutorProviderIdentity(
  executorId: string,
  existing: AgentExecutorConfig | undefined,
  nextProviderId: string
): void {
  if (!existing || existing.providerId === nextProviderId) return
  throw new Error(
    `Executor ${executorId} already belongs to ${agentProviderLabel(existing.providerId)}. ` +
    'Create a new Executor to choose another Provider.'
  )
}

// Quote and split are one reversible codec. This is argv editing, with no shell execution
// or environment expansion; adding a flag must preserve every other literal argument.

export function AgentSettingsPane({ config, onSave, executorId, navigationRequest, active = true }: {
  active?: boolean
  navigationRequest?: SettingsNavigationRequest | undefined
  config: AppConfig
  executorId?: string | undefined
  onSave: (executors: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>) => Promise<void>
}) {
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const initialHost = config.hosts.find(host => host.kind === 'local')?.id ?? 'local'
  const [filter, setFilter] = useState({ query: '', snapshot: new Set<string>() })
  const [selectedId, setSelectedId] = useState<string | null>(() => executorId ?? Object.keys(config.executors)[0] ?? null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [view, setView] = useState<'library' | 'editor'>('library')
  const [catalogRead, setCatalogRead] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; error?: string }>({ state: 'idle' })
  const catalogPending = useRef(false)
  const mounted = useRef(true)
  const [pendingEdit, setPendingEdit] = useState<{ id: string; select: boolean; field?: 'provider' } | null>(null)
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [launchOpen, setLaunchOpen] = useState<Record<string, boolean>>({})
  const editor = useRef<HTMLDivElement>(null)
  const consumedNavigation = useRef<SettingsNavigationRequest | string | undefined>(undefined)
  const [hostId] = useState(initialHost)
  const [scope, setScope] = useState<'templates' | 'host'>('templates')
  const resource = useResourceDrafts(Object.fromEntries(Object.entries(config.executors).map(([id, executor]) =>
    [id, toDraft(executor)])))
  const drafts = resource.value, setDrafts = resource.setValue
  const detectionKeys = useRef<string[]>([])
  const nextDetectionKeys = Object.keys(drafts).map(id => executorDetectionKey(hostId, id))
  if (nextDetectionKeys.length !== detectionKeys.current.length || nextDetectionKeys.some((key, index) => key !== detectionKeys.current[index])) {
    detectionKeys.current = nextDetectionKeys
  }
  const relevantDetectionKeys = detectionKeys.current
  const selectDetections = useMemo(() => {
    let source: typeof NO_DETECTIONS | undefined
    let selected = NO_DETECTIONS
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (!active || scope !== 'templates') return NO_DETECTIONS
      if (source === state.executorDetections) return selected
      source = state.executorDetections
      let next = selected
      for (const key of relevantDetectionKeys) {
        if (source[key] === selected[key]) continue
        if (next === selected) next = { ...selected }
        if (source[key]) next[key] = source[key]
        else delete next[key]
      }
      selected = next
      return selected
    }
  }, [active, scope, relevantDetectionKeys])
  const detections = useAppStore(selectDetections)
  const saveState = useSettingsSave()
  const { saving } = saveState
  const dirty = resource.dirty
  // Detection is a user-visible probe, not a subscription to every result update. Tying
  // this effect to the result map retries a failed probe forever (a failed native call
  // leaves one executor without a result, so every state update starts another probe).
  // Re-run only when the host or the saved executor set changes; Refresh remains the
  // explicit retry path after an environment failure.
  const detectionTarget = useMemo(
    () => Object.keys(config.executors).sort().join('\0'),
    [config.executors]
  )
  const detectionHost = config.hosts.find((host) => host.id === hostId)
  const executors = useMemo(() => Object.entries(drafts).map(([id, draft]) => {
    let env: Record<string, string>
    try { env = parseEnv(draft.env) }
    catch { return { id, draft, detection: undefined } }
    return { id, draft, detection: currentExecutorDetection(
      detections[executorDetectionKey(hostId, id)], id, { ...draft, env }, detectionHost
    ) }
  }), [detectionHost, detections, drafts, hostId])
  const checking = executors.some((executor) => executor.detection?.state === 'checking')
  function filterExecutors(query: string): void {
    // Search chooses a stable set of editors. Renaming a found executor must not hide it mid-input.
    const normalized = query.trim().toLowerCase()
    setFilter({ query, snapshot: new Set(executors.filter(({ id, draft }) =>
      `${id} ${draft.label} ${draft.providerId} ${agentProviderLabel(draft.providerId)} ${draft.command}`
        .toLowerCase().includes(normalized)
    ).map(({ id }) => id)) })
  }
  const matches = (id: string) => !filter.query.trim() || filter.snapshot.has(id)
  const inProvider = (candidate: string) => providerId === null || candidate === providerId
  const scopedExecutors = executors.filter(({ draft }) => inProvider(draft.providerId))
  const visibleExecutors = scopedExecutors.filter(({ id }) => matches(id))

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function refreshProviders(): Promise<void> {
    if (catalogPending.current) return
    catalogPending.current = true
    setCatalogRead({ state: 'loading' })
    try {
      const catalog = await api.providers.list()
      if (!mounted.current) return
      useAppStore.setState({ providerCatalog: catalog })
      setCatalogRead({ state: 'ready' })
    } catch (cause) {
      if (mounted.current) setCatalogRead({ state: 'error', error: presentError(cause) })
    } finally {
      catalogPending.current = false
    }
  }

  useEffect(() => {
    if (active && scope === 'templates' && providerCatalog.length === 0 && catalogRead.state === 'idle') void refreshProviders()
  }, [active, scope, providerCatalog.length, catalogRead.state])

  function selectProvider(next: string | null): void {
    setProviderId(next)
    setFilter({ query: '', snapshot: new Set<string>() })
    const current = drafts[selectedId ?? '']
    if (!current || (next !== null && current.providerId !== next)) {
      setSelectedId(executors.find(({ draft }) => next === null || draft.providerId === next)?.id ?? null)
    }
    setView('library')
  }

  useEffect(() => {
    if (!active || !detectionTarget) return
    void detectExecutors(hostId)
  }, [active, detectionTarget, detectExecutors, hostId])

  useEffect(() => {
    const request = navigationRequest?.section === 'agents' ? navigationRequest : executorId
    const targetId = typeof request === 'string' ? request : request?.executorId
    if (!active || !targetId || consumedNavigation.current === request) return
    consumedNavigation.current = request
    setSelectedId(targetId)
    setProviderId(drafts[targetId]?.providerId ?? config.executors[targetId]?.providerId ?? null)
    setView('editor')
    setScope('templates')
    setFilter({ query: '', snapshot: new Set<string>() })
    setPendingEdit({ id: targetId, select: false })
  }, [active, executorId, navigationRequest])

  useEffect(() => {
    if (!pendingEdit || pendingEdit.id !== selectedId) return
    const name = editor.current?.querySelector<HTMLInputElement>('input[data-executor-name]')
    const target = pendingEdit.field === 'provider'
      ? editor.current?.querySelector<HTMLSelectElement>('[data-executor-provider]')
      : name ?? editor.current?.querySelector<HTMLElement>('.settings-resource-editor__empty')
    if (!target) return
    target.focus()
    if (target === name && pendingEdit.select) name.select()
    setPendingEdit(null)
  }, [pendingEdit, selectedId])

  function selectExecutor(id: string): void {
    setSelectedId(id)
    setView('editor')
    setPendingEdit({ id, select: false })
  }

  function removeExecutor(id: string): void {
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== id)))
    const next = scopedExecutors.find((executor) => executor.id !== id)?.id ?? null
    setSelectedId(next)
    setFilter({ query: '', snapshot: new Set<string>() })
    setReturnFocus({ id: next })
    setView('library')
  }

  function updateAvatar(id: string, patch: AgentAvatarAppearance | undefined) {
    update(id, { avatar: patch })
  }

  function update(id: string, patch: Partial<ExecutorDraft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }

  function createExecutorId(): string {
    let id: string
    do { id = mintObjectId() }
    while (Object.hasOwn(drafts, id) || Object.hasOwn(config.executors, id) || Object.hasOwn(resource.expected, id))
    return id
  }

  function chooseProvider(id: string, providerId: string): void {
    const draft = drafts[id]!
    if (saving || Object.hasOwn(resource.expected, id) || draft.providerId === providerId) return
    const previous = providerCatalog.find((provider) => provider.id === draft.providerId)
    const next = providerCatalog.find((provider) => provider.id === providerId)!
    const nextId = createExecutorId()
    setDrafts((current) => {
      const records = { ...current }
      records[nextId] = { ...records[id]!, providerId,
        command: draft.command === previous?.executable ? next.executable : draft.command }
      delete records[id]
      return records
    })
    setLaunchOpen((current) => {
      const records = { ...current, [nextId]: current[id] ?? false }
      delete records[id]
      return records
    })
    setFilter({ query: '', snapshot: new Set<string>() })
    setSelectedId(nextId)
    setProviderId(providerId)
    setView('editor')
    setPendingEdit({ id: nextId, select: false, field: 'provider' })
  }

  async function saveDrafts(makeDrafts: () => Record<string, ExecutorDraft>): Promise<void> {
    await saveState.run(async () => {
      const next = makeDrafts()
      const decode = (records: Record<string, ExecutorDraft>) => Object.fromEntries(Object.entries(records).map(([id, draft]) => {
        return [id, {
          label: draft.label.trim(), providerId: draft.providerId, command: draft.command.trim(),
          args: parseExecutorArgs(draft.args),
          env: parseEnv(draft.env), injectAgentMuxGuide: draft.injectAgentMuxGuide,
          ...(draft.avatar ? { avatar: draft.avatar } : {})
        }]
      }))
      const expected = decode(resource.expected)
      const executors = decode(next)
      for (const [id, executor] of Object.entries(executors)) {
        assertExecutorProviderIdentity(id, Object.hasOwn(expected, id) ? expected[id] : undefined, executor.providerId)
        // Preserve unchanged environment from its authored baseline, never from fresher props.
        if (next[id]!.env === resource.expected[id]?.env) executor.env = expected[id]!.env
      }
      if (Object.values(executors).some((executor) => !executor.label || !executor.command)) {
        throw new Error('Executor names and commands cannot be empty')
      }
      const submitted = resource.beginSave(next)
      let committed = false
      try {
        await onSave(executors, expected)
        committed = true
      } finally {
        submitted.finish(committed ? Object.fromEntries(Object.entries(executors).map(([id, executor]) => [id, toDraft(executor)])) : undefined)
      }
    })
  }

  async function enableYolo(id?: string): Promise<void> {
    await saveDrafts(() => {
      const next = Object.fromEntries(Object.entries(drafts).map(([candidate, draft]) => {
        const args = candidate === id || id === undefined ? withUnrestrictedLaunchArgs(draft.providerId, parseExecutorArgs(draft.args)) : null
        return [candidate, args ? { ...draft, args: args.map(quote).join('\n') } : draft]
      }))
      setDrafts(() => next)
      return next
    })
  }

  function addExecutor(provider = providerId === null ? providerCatalog[0] : providerCatalog.find(entry => entry.id === providerId)): void {
    if (!provider) { void refreshProviders(); return }
    setScope('templates')
    const id = createExecutorId()
    setDrafts((current) => ({ ...current, [id]: {
      label: `${provider.label} ${Object.keys(current).length + 1}`, providerId: provider.id,
      command: provider.executable, args: '', env: '{}', injectAgentMuxGuide: true
    } }))
    setFilter({ query: '', snapshot: new Set<string>() })
    setSelectedId(id)
    setProviderId(provider.id)
    setView('editor')
    setPendingEdit({ id, select: true })
  }

  const scopeControl = <label className="settings-compact-field"><span>Configure</span><select aria-label="Executor configuration scope" value={scope} onChange={event => setScope(event.target.value as 'templates' | 'host')}><option value="templates">Global templates</option><option value="host">On a Host</option></select></label>
  const executorCounts = Object.values(drafts).reduce<Record<string, number>>((counts, draft) => {
    counts[draft.providerId] = (counts[draft.providerId] ?? 0) + 1
    return counts
  }, {})
  return (
    <div className="settings-agent-pane" data-editor-view={scope === 'templates' ? view : 'host'}>
      <div className="settings-pane-toolbar settings-agent-toolbar">
        {scopeControl}
        <span className="settings-resource-count">{scope === 'templates' ? `${executors.length} global templates` : null}</span>
      </div>
      <div className="settings-agent-body" hidden={scope !== 'host'}><HostExecutorSettings config={config} active={active && scope === 'host'} /></div>
      <div hidden={scope !== 'templates'} className="settings-agent-templates">
        <ProviderCatalogPane entries={providerCatalog} read={catalogRead} executorCounts={executorCounts}
          selectedId={providerId} onSelect={selectProvider} onRefresh={() => void refreshProviders()} />
        <div className="settings-resource-workbench settings-executor-detail-layout" data-resource-view={view}>
          <div className="settings-pane-toolbar settings-executor-toolbar">
            <strong>Executors <span>{visibleExecutors.length}{filter.query.trim() ? ` of ${scopedExecutors.length}` : ''}</span></strong>
            <button className="icon-button" aria-label="Refresh saved executor availability" title="Refresh saved commands" disabled={checking} onClick={() => void detectExecutors(hostId)}>{checking ? <ThemeStatusLoadingIcon animation="spin" size={14} /> : <ThemeActionRefreshIcon size={14} />}</button>
            <button className="small-button" disabled={saving} onClick={() => addExecutor()}><ThemeActionCreateExecutorIcon size={13} /> Add executor</button>
          </div>
          <div className="settings-resource-split">
        <SettingsResourceLibrary label="Executors" selectedId={selectedId} query={filter.query} onQuery={filterExecutors} onSelect={selectExecutor} focusRequest={returnFocus}
          items={visibleExecutors.map(({ id, draft, detection }) => ({
            id, name: draft.label, detail: draft.command,
            mark: <AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={draft.avatar ?? (config.appearance.agentAvatars && Object.hasOwn(config.appearance.agentAvatars, id) ? config.appearance.agentAvatars[id] : undefined) ?? {}} size={20} />,
            status: <>{!configValuesEqual(drafts[id], resource.expected[id]) ? <span className="settings-dirty-dot" title="Unsaved changes" /> : null}<span className={`settings-resource-row__check check-pill--${detection?.state ?? 'idle'}`} role="img" aria-label={statusCopy(detection).label} title={statusCopy(detection).label}>{statusCopy(detection).icon}</span></>,
          }))} />
        <div ref={editor} className="settings-resource-editor">
          <button className="small-button settings-resource-back" onClick={() => { setView('library'); setReturnFocus({ id: selectedId }) }}><ThemeNavigationBackIcon size={13} />All executors</button>
          {selectedId && !visibleExecutors.some(({ id }) => id === selectedId) && drafts[selectedId] ? <p className="settings-filter-notice">This executor is outside your search. <button type="button" onClick={() => setFilter({ query: '', snapshot: new Set<string>() })}>Show in list</button></p> : null}
        {executors.filter(({ id }) => id === selectedId).map(({ id, draft, detection }) => {
          const status = statusCopy(detection)
          // Effective appearance is a projection; the editable baseline remains the Executor DTO.
          const legacy = config.appearance.agentAvatars
          const avatar = draft.avatar ?? (legacy && Object.hasOwn(legacy, id) ? legacy[id] : undefined)
          return (
            <section className="agent-settings-card" key={id} id={`executor-settings-${id}`} data-resource-editor={id}>
              <header className="settings-resource-editor__header">
                <span className="agent-provider-mark"><AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={avatar ?? {}} size={20} /></span>
                <label className="settings-executor-name"><span>Name</span><TextInput data-executor-name value={draft.label} onChange={(event) => update(id, { label: event.target.value })} /><small>{agentProviderLabel(draft.providerId)} executor · Global template</small></label>
                <em className={`check-pill check-pill--${detection?.state ?? 'idle'}`}>{status.icon}{status.label}</em>
              </header>
              <div className="agent-settings-fields">
                {detection?.detail ? <p className="settings-inline-error">{detection.detail}</p> : null}
                {Object.hasOwn(resource.expected, id) ? <dl className="settings-executor-identity"><div><dt>Provider</dt><dd>{agentProviderLabel(draft.providerId)}</dd></div><div><dt>Executor ID</dt><dd><code>{id}</code></dd></div></dl> :
                  <label><span>Provider</span><select data-executor-provider disabled={saving} value={draft.providerId} onChange={(event) => chooseProvider(id, event.target.value)}>{!providerCatalog.some(provider => provider.id === draft.providerId) ? <option value={draft.providerId}>{agentProviderLabel(draft.providerId)} · current draft</option> : null}{providerCatalog.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>}
                <label><span>Executable</span><TextInput aria-label="Executor executable" value={draft.command} onChange={(event) => update(id, { command: event.target.value })} /></label>
                <p className="settings-group-note">One executable name or path, without arguments or shell quotes. Paths may contain spaces.</p>
                <label><span>Arguments <small>shell-style quoting</small></span><ComposerTextarea aria-label="Executor arguments" value={draft.args} onValueChange={(value) => update(id, { args: value })} placeholder={'--model "model name" --effort high'} rows={2} /></label>
                <ExecutorLaunchPreview command={draft.command} args={draft.args} />
                <p className="settings-group-note">Used for new sessions. Running agents keep their current configuration. Save changes before checking availability.</p>
                <div className="agent-avatar-settings__row">
                  <span className="agent-avatar-settings__name"><strong>Appearance</strong><small>Recognize this executor across your workspace</small></span>
                  <label>Tint<input type="color" aria-label={`${draft.label} avatar tint`} value={avatar?.tint ?? '#8ab4f8'} onChange={(event) => updateAvatar(id, { ...avatar, tint: event.target.value })} /></label>
                  <label>Icon<select aria-label={`${draft.label} avatar icon`} value={avatar?.badge ?? ''} onChange={(event) => { const next = { ...avatar }; if (event.target.value) next.badge = event.target.value as AgentAvatarBadge; else delete next.badge; updateAvatar(id, next) }}><option value="">None</option>{AGENT_AVATAR_BADGE_IDS.map((badge) => <option key={badge} value={badge}>{AGENT_AVATAR_BADGE_LABELS[badge]}</option>)}</select></label>
                  <button type="button" className="small-button" aria-label={`Reset ${draft.label} avatar`} disabled={!avatar?.tint && !avatar?.badge} onClick={() => updateAvatar(id, {})}>Reset</button>
                </div>
                <details className="settings-launch-config" open={launchOpen[id] ?? false} onToggle={(event) => { const open = event.currentTarget.open; setLaunchOpen((current) => current[id] === open ? current : { ...current, [id]: open }) }}>
                  <summary><span><strong>Advanced</strong><small>Environment variables, guide, and permissions</small></span><ThemeNavigationDownIcon size={14} /></summary>
                  <div className="settings-launch-config__fields">
                    <p className="settings-group-note">Used for new sessions. Running agents keep their current configuration.</p>
                    {!config.executors[id] ? <p className="settings-group-note">Executor ID: <code>{id}</code>. Provider and ID are fixed after saving.</p> : null}
                        <label><span>Environment variables <small>JSON object · values stay literal</small></span><ComposerTextarea value={draft.env} onValueChange={(value) => update(id, { env: value })} placeholder={'{"API_BASE": "https://example.test"}'} rows={3} /></label>
                    <label className="agent-guide-toggle"><input type="checkbox" checked={draft.injectAgentMuxGuide} onChange={(event) => update(id, { injectAgentMuxGuide: event.target.checked })} /><span><strong>AgentMux guide</strong><small>Help this agent use your views, tabs, and configured executors.</small></span></label>
                    {withUnrestrictedLaunchArgs(draft.providerId, []) ? <div className="settings-launch-action"><span>Skip permission prompts on future launches.</span><button type="button" className="small-button" disabled={saving} onClick={() => void enableYolo(id)}><ThemeStatusUnrestrictedIcon size={13} /> Enable YOLO</button></div> : null}
                  </div>
                </details>
                <div className="settings-executor-remove"><button type="button" className="small-button" disabled={saving} onClick={() => removeExecutor(id)}><ThemeActionRemoveIcon size={13} /> Delete executor</button></div>
              </div>
            </section>
          )
        })}
          {!executors.some(({ id }) => id === selectedId) ? <div className="settings-resource-editor__empty" tabIndex={-1} role="status"><ThemeObjectAgentIcon size={28} aria-hidden="true" /><strong>{selectedId ? 'Executor unavailable' : scopedExecutors.length ? 'Choose an executor' : 'No executors for this provider'}</strong><p>{selectedId ? 'This executor is no longer in the configuration. Select another, or add a new one.' : 'Create a launch configuration with its own command, arguments and appearance.'}</p>{!selectedId ? <button className="small-button" disabled={saving} onClick={() => addExecutor()}>Add executor</button> : null}</div> : null}
          {executors.some(({ draft }) => withUnrestrictedLaunchArgs(draft.providerId, []) !== null) ? <details className="settings-bulk-actions"><summary>Launch actions <ThemeNavigationDownIcon size={13} /></summary><div className="settings-launch-action"><span>Use unrestricted access for supported executors on future launches.</span><button className="small-button" disabled={saving} onClick={() => void enableYolo()}><ThemeStatusUnrestrictedIcon size={13} /> Enable YOLO for supported executors</button></div></details> : null}
        </div>
          </div>
          </div>
        </div>
      <div className="settings-agent-save" hidden={scope !== 'templates'}>
        <SettingsSaveBar save={saveState} dirty={dirty} label="Save all executors" onSave={() => void saveDrafts(() => drafts)} />
      </div>
    </div>
  )
}
