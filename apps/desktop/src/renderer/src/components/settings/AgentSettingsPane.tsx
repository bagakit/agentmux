import { AGENT_AVATAR_BADGE_IDS, AGENT_AVATAR_BADGE_LABELS } from '../../../../shared/contracts'
import { AgentAvatar } from '../AgentAvatar'
import {
  ArrowLeft,
  Bot,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  ShieldOff,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { quote, split } from 'shlex'
import type { AgentExecutorConfig, AppConfig, AgentAvatarAppearance, AgentAvatarBadge } from '../../../../shared/contracts'
import { executorDetectionKey, useAppStore } from '../../store'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { agentProviderLabel } from '../AgentProviderIcon'
import { ComposerTextarea } from '../ComposerTextarea'
import { withYoloArgs } from '../../lib/executors'
import { currentExecutorDetection, executorDetectionLabel } from '../../lib/executor-detection'
import { useResourceDrafts } from './use-resource-drafts'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import type { SettingsNavigationRequest } from '../SettingsNavigation'

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
    case 'ready': return { label, icon: <CheckCircle2 size={13} /> }
    case 'checking': return { label, icon: <LoaderCircle className="spin" size={13} /> }
    case 'error': return { label, icon: <AlertTriangle size={13} /> }
    default: return { label, icon: <XCircle size={13} /> }
  }
}

function nextExecutorId(providerId: string, drafts: Readonly<Record<string, ExecutorDraft>>): string {
  const base = providerId.replace(/[^A-Za-z0-9_-]/g, '-') || 'agent'
  let suffix = 2
  if (!Object.hasOwn(drafts, base)) return base
  while (Object.hasOwn(drafts, `${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
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
export function parseExecutorArgs(text: string): string[] {
  return split(text)
}

export function AgentSettingsPane({ config, onSave, executorId, navigationRequest, active = true }: {
  active?: boolean
  navigationRequest?: SettingsNavigationRequest | undefined
  config: AppConfig
  executorId?: string | undefined
  onSave: (executors: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>) => Promise<void>
}) {
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const detections = useAppStore((state) => active ? state.executorDetections : NO_DETECTIONS)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const initialHost = config.workspaces.find((workspace) => workspace.id === useAppStore.getState().activeWorkspaceId)?.hostId ?? 'local'
  const [filter, setFilter] = useState({ query: '', snapshot: [] as string[] })
  const [selectedId, setSelectedId] = useState<string | null>(() => executorId ?? Object.keys(config.executors)[0] ?? null)
  const [view, setView] = useState<'library' | 'editor'>(executorId ? 'editor' : 'library')
  const [pendingEdit, setPendingEdit] = useState<{ id: string; select: boolean } | null>(null)
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [launchOpen, setLaunchOpen] = useState<Record<string, boolean>>({})
  const editor = useRef<HTMLDivElement>(null)
  const consumedNavigation = useRef<SettingsNavigationRequest | string | undefined>(undefined)
  const [hostId, setHostId] = useState(initialHost)
  const resource = useResourceDrafts(Object.fromEntries(Object.entries(config.executors).map(([id, executor]) =>
    [id, toDraft(executor)])))
  const drafts = resource.value, setDrafts = resource.setValue
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
  const executors = useMemo(() => Object.entries(drafts).map(([id, draft]) => ({
    id,
    draft,
    detection: currentExecutorDetection(detections[executorDetectionKey(hostId, id)], id, draft, detectionHost)
  })), [detectionHost, detections, drafts, hostId])
  const checking = executors.some((executor) => executor.detection?.state === 'checking')
  function filterExecutors(query: string): void {
    // Search chooses a stable set of editors. Renaming a found executor must not hide it mid-input.
    const normalized = query.trim().toLowerCase()
    setFilter({ query, snapshot: executors.filter(({ id, draft }) =>
      `${id} ${draft.label} ${draft.providerId} ${agentProviderLabel(draft.providerId)} ${draft.command}`
        .toLowerCase().includes(normalized)
    ).map(({ id }) => id) })
  }
  const matches = (id: string) => !filter.query.trim() || filter.snapshot.includes(id)
  const matchCount = executors.filter(({ id }) => matches(id)).length


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
    setView('editor')
    setFilter({ query: '', snapshot: [] })
    setPendingEdit({ id: targetId, select: false })
  }, [active, executorId, navigationRequest])

  useEffect(() => {
    if (!pendingEdit || pendingEdit.id !== selectedId) return
    const name = editor.current?.querySelector<HTMLInputElement>('input[data-executor-name]')
    const target = name ?? editor.current?.querySelector<HTMLElement>('.settings-resource-editor__empty')
    if (!target) return
    target.focus()
    if (name && pendingEdit.select) name.select()
    setPendingEdit(null)
  }, [pendingEdit, selectedId])

  function selectExecutor(id: string): void {
    setSelectedId(id)
    setView('editor')
    setPendingEdit({ id, select: false })
  }

  function backToLibrary(): void {
    setView('library')
    if (selectedId) {
      if (!matches(selectedId)) setFilter({ query: '', snapshot: [] })
      setReturnFocus({ id: selectedId })
    }
  }

  function removeExecutor(id: string): void {
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== id)))
    const next = executors.find((executor) => executor.id !== id)?.id ?? null
    setSelectedId(next)
    setFilter({ query: '', snapshot: [] })
    setView('library')
    setReturnFocus({ id: next })
  }

  function updateAvatar(id: string, patch: AgentAvatarAppearance | undefined) {
    update(id, { avatar: patch })
  }

  function update(id: string, patch: Partial<ExecutorDraft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }

  function chooseProvider(id: string, providerId: string): void {
    const draft = drafts[id]!
    const previous = providerCatalog.find((provider) => provider.id === draft.providerId)
    const next = providerCatalog.find((provider) => provider.id === providerId)!
    update(id, { providerId, command: draft.command === previous?.executable ? next.executable : draft.command })
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
        const args = candidate === id || id === undefined ? withYoloArgs(draft.providerId, parseExecutorArgs(draft.args)) : null
        return [candidate, args ? { ...draft, args: args.map(quote).join('\n') } : draft]
      }))
      setDrafts(() => next)
      return next
    })
  }

  function addExecutor(): void {
    const provider = providerCatalog[0]
    if (!provider) return
    const id = nextExecutorId(provider.id, drafts)
    setDrafts((current) => ({ ...current, [id]: {
      label: `${provider.label} ${Object.keys(current).length + 1}`, providerId: provider.id,
      command: provider.executable, args: '', env: '{}', injectAgentMuxGuide: true
    } }))
    setFilter({ query: '', snapshot: [] })
    setSelectedId(id)
    setView('editor')
    setPendingEdit({ id, select: true })
  }

  return (
    <div className="settings-pane-stack settings-resource-workbench" data-resource-view={view}>
      <div className="settings-pane-toolbar">
        <span className="settings-resource-count">{filter.query.trim() ? `${matchCount} of ` : ''}{executors.length} {executors.length === 1 ? 'executor' : 'executors'}</span>
        <div className="settings-resource-check-tools">
            <label className="settings-compact-field"><span>Check on</span><select value={hostId} onChange={(event) => setHostId(event.target.value)}>{config.hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
            <button className="icon-button" aria-label="Refresh saved executor availability" title="Refresh saved commands" disabled={checking} onClick={() => void detectExecutors(hostId)}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
        </div>
        <button className="small-button" disabled={providerCatalog.length === 0 || saving} onClick={addExecutor}><Plus size={13} /> Add executor</button>
      </div>
      <div className="settings-resource-split">
        <SettingsResourceLibrary label="Executors" selectedId={selectedId} query={filter.query} onQuery={filterExecutors} onSelect={selectExecutor} focusRequest={returnFocus}
          items={executors.filter(({ id }) => matches(id)).map(({ id, draft, detection }) => ({
            id, name: draft.label, detail: `${agentProviderLabel(draft.providerId)} · ${id}`,
            mark: <AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={draft.avatar ?? (config.appearance.agentAvatars && Object.hasOwn(config.appearance.agentAvatars, id) ? config.appearance.agentAvatars[id] : undefined) ?? {}} size={22} />,
            status: <span className={`settings-resource-row__check check-pill--${detection?.state ?? 'idle'}`} role="img" aria-label={statusCopy(detection).label} title={statusCopy(detection).label}>{statusCopy(detection).icon}<span>{statusCopy(detection).label}</span></span>
          }))} />
        <div ref={editor} className="settings-resource-editor">
          <button type="button" className="settings-resource-back small-button" onClick={backToLibrary}><ArrowLeft size={14} /> All executors</button>
          <p className="settings-group-note">Checks use saved commands. Save a changed command before refreshing.</p>
        {executors.filter(({ id }) => id === selectedId).map(({ id, draft, detection }) => {
          const status = statusCopy(detection)
          // Effective appearance is a projection; the editable baseline remains the Executor DTO.
          const legacy = config.appearance.agentAvatars
          const avatar = draft.avatar ?? (legacy && Object.hasOwn(legacy, id) ? legacy[id] : undefined)
          return (
            <section className="agent-settings-card" key={id} id={`executor-settings-${id}`} data-resource-editor={id}>
              <header className="settings-resource-editor__header">
                <span className="agent-provider-mark"><AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={avatar ?? {}} size={20} /></span>
                <span><strong>{draft.label}</strong><small>{agentProviderLabel(draft.providerId)} · {id}</small></span>
                <em className={`check-pill check-pill--${detection?.state ?? 'idle'}`}>{status.icon}{status.label}</em>
              </header>
              <div className="agent-settings-fields">
                {detection?.detail ? <p className="settings-inline-error">{detection.detail}</p> : null}
                <label><span>Name</span><input data-executor-name value={draft.label} onChange={(event) => update(id, { label: event.target.value })} /></label>
                {Object.hasOwn(resource.expected, id) ? <dl className="settings-executor-identity"><div><dt>Provider</dt><dd>{agentProviderLabel(draft.providerId)}</dd></div><div><dt>Executor ID</dt><dd><code>{id}</code></dd></div></dl> :
                  <label><span>Provider</span><select value={draft.providerId} onChange={(event) => chooseProvider(id, event.target.value)}>{providerCatalog.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>}
                <div className="agent-avatar-settings__row">
                  <span className="agent-avatar-settings__name"><strong>Appearance</strong><small>Recognize this executor across your workspace</small></span>
                  <label>Tint<input type="color" aria-label={`${draft.label} avatar tint`} value={avatar?.tint ?? '#8ab4f8'} onChange={(event) => updateAvatar(id, { ...avatar, tint: event.target.value })} /></label>
                  <label>Icon<select aria-label={`${draft.label} avatar icon`} value={avatar?.badge ?? ''} onChange={(event) => { const next = { ...avatar }; if (event.target.value) next.badge = event.target.value as AgentAvatarBadge; else delete next.badge; updateAvatar(id, next) }}><option value="">None</option>{AGENT_AVATAR_BADGE_IDS.map((badge) => <option key={badge} value={badge}>{AGENT_AVATAR_BADGE_LABELS[badge]}</option>)}</select></label>
                  <button type="button" className="small-button" aria-label={`Reset ${draft.label} avatar`} disabled={!avatar?.tint && !avatar?.badge} onClick={() => updateAvatar(id, {})}>Reset</button>
                </div>
                <details className="settings-launch-config" open={launchOpen[id] ?? false} onToggle={(event) => { const open = event.currentTarget.open; setLaunchOpen((current) => current[id] === open ? current : { ...current, [id]: open }) }}>
                  <summary><span><strong>Launch configuration</strong><small>Command, arguments, and environment</small></span><ChevronDown size={14} /></summary>
                  <div className="settings-launch-config__fields">
                    <p className="settings-group-note">Used for new sessions. Running agents keep their current configuration.</p>
                    {!config.executors[id] ? <p className="settings-group-note">Executor ID: <code>{id}</code>. Provider and ID are fixed after saving.</p> : null}
                    <label><span>Command</span><input value={draft.command} onChange={(event) => update(id, { command: event.target.value })} /></label>
                    <label><span>Arguments <small>shell-style quoting</small></span><ComposerTextarea value={draft.args} onValueChange={(value) => update(id, { args: value })} placeholder="--model fable --effort high" rows={3} /></label>
                    <label><span>Environment <small>JSON object · values stay literal</small></span><ComposerTextarea value={draft.env} onValueChange={(value) => update(id, { env: value })} placeholder={'{"API_BASE": "https://example.test"}'} rows={3} /></label>
                    <label className="agent-guide-toggle"><input type="checkbox" checked={draft.injectAgentMuxGuide} onChange={(event) => update(id, { injectAgentMuxGuide: event.target.checked })} /><span><strong>AgentMux guide</strong><small>Help this agent use your views, tabs, and configured executors.</small></span></label>
                    {withYoloArgs(draft.providerId, []) ? <div className="settings-launch-action"><span>Skip permission prompts on future launches.</span><button type="button" className="small-button" disabled={saving} onClick={() => void enableYolo(id)}><ShieldOff size={13} /> Enable YOLO</button></div> : null}
                  </div>
                </details>
                <div className="settings-executor-remove"><button type="button" className="small-button" disabled={saving} onClick={() => removeExecutor(id)}><Trash2 size={13} /> Delete executor</button></div>
              </div>
            </section>
          )
        })}
          {!executors.some(({ id }) => id === selectedId) ? <div className="settings-resource-editor__empty" tabIndex={-1} role="status"><Bot size={28} aria-hidden="true" /><strong>{selectedId ? 'Executor unavailable' : 'Your agent configurations'}</strong><p>{selectedId ? 'This executor is no longer in the configuration. Select another, or add a new one.' : 'Choose an executor to edit its identity and launch configuration.'}</p></div> : null}
          {executors.some(({ draft }) => withYoloArgs(draft.providerId, []) !== null) ? <details className="settings-bulk-actions"><summary>Launch actions <ChevronDown size={13} /></summary><div className="settings-launch-action"><span>Skip permission prompts for all Claude and Codex executors on future launches.</span><button className="small-button" disabled={saving} onClick={() => void enableYolo()}><ShieldOff size={13} /> Enable YOLO for Claude &amp; Codex</button></div></details> : null}
        </div>
      </div>
      <SettingsSaveBar save={saveState} dirty={dirty} label="Save executors" onSave={() => void saveDrafts(() => drafts)} />
    </div>
  )
}
