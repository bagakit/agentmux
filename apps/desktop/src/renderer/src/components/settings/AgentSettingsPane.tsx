import { AGENT_AVATAR_BADGE_IDS, AGENT_AVATAR_BADGE_LABELS } from '../../../../shared/contracts'
import { AgentAvatar } from '../AgentAvatar'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  WandSparkles,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { quote, split } from 'shlex'
import type { AgentExecutorConfig, AppConfig, AgentAvatarAppearance, AgentAvatarBadge } from '../../../../shared/contracts'
import { executorDetectionKey, useAppStore } from '../../store'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { agentProviderLabel } from '../AgentProviderIcon'
import { ComposerTextarea } from '../ComposerTextarea'
import { withYoloArgs } from '../../lib/executors'

type ExecutorDraft = {
  label: string
  providerId: string
  command: string
  args: string
  env: string
  injectAgentMuxGuide: boolean
  avatar?: AgentAvatarAppearance | undefined
}

function toDraft(config: AgentExecutorConfig, legacyAvatar?: AgentAvatarAppearance): ExecutorDraft {
  return {
    label: config.label,
    providerId: config.providerId,
    command: config.command,
    args: config.args.map(quote).join('\n'),
    env: Object.entries(config.env).map(([name, value]) => `${name}=${value}`).join('\n'),
    injectAgentMuxGuide: config.injectAgentMuxGuide,
    // Read the pre-Executor appearance by stable id into the draft so the settings card shows
    // what the user already sees. A later explicit reset stores `{}` on the Executor, which
    // wins over the preserved legacy record without deleting that durable record.
    avatar: config.avatar ?? legacyAvatar
  }
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trimStart()
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    const name = separator > 0 ? line.slice(0, separator).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Environment line ${index + 1} must use NAME=value`)
    }
    env[name] = line.slice(separator + 1)
  }
  return env
}

function statusCopy(state: ReturnType<typeof useAppStore.getState>['executorDetections'][string] | undefined) {
  switch (state?.state) {
    case 'ready': return { label: 'Available', icon: <CheckCircle2 size={13} /> }
    case 'missing': return { label: 'Not installed', icon: <XCircle size={13} /> }
    case 'checking': return { label: 'Checking', icon: <LoaderCircle className="spin" size={13} /> }
    case 'error': return { label: 'Check failed', icon: <AlertTriangle size={13} /> }
    default: return { label: 'Not checked', icon: <XCircle size={13} /> }
  }
}

function nextExecutorId(providerId: string, drafts: Readonly<Record<string, ExecutorDraft>>): string {
  const base = providerId.replace(/[^A-Za-z0-9_-]/g, '-') || 'agent'
  let suffix = 2
  if (!drafts[base]) return base
  while (drafts[`${base}-${suffix}`]) suffix += 1
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

export function AgentSettingsPane({ config, onSave, executorId }: {
  config: AppConfig
  executorId?: string | undefined
  onSave: (executors: Record<string, AgentExecutorConfig>) => Promise<void>
}) {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const initialHost = config.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.hostId ?? 'local'
  const [filter, setFilter] = useState({ query: '', snapshot: [] as string[] })
  const [pendingEditId, setPendingEditId] = useState<string | null>(null)
  const [hostId, setHostId] = useState(initialHost)
  const [drafts, setDrafts] = useState<Record<string, ExecutorDraft>>(() =>
    Object.fromEntries(Object.entries(config.executors).map(([id, executor]) => [id, toDraft(executor, config.appearance.agentAvatars?.[id])]))
  )
  const saveState = useSettingsSave()
  const { saving } = saveState
  const [savedDrafts, setSavedDrafts] = useState(() => JSON.stringify(drafts))
  const dirty = JSON.stringify(drafts) !== savedDrafts
  // Detection is a user-visible probe, not a subscription to every result update. Tying
  // this effect to the result map retries a failed probe forever (a failed native call
  // leaves one executor without a result, so every state update starts another probe).
  // Re-run only when the host or the saved executor set changes; Refresh remains the
  // explicit retry path after an environment failure.
  const detectionTarget = useMemo(
    () => Object.keys(config.executors).sort().join('\0'),
    [config.executors]
  )
  const executors = useMemo(() => Object.entries(drafts).map(([id, draft]) => ({
    id,
    draft,
    detection: detections[executorDetectionKey(hostId, id)]
  })), [detections, drafts, hostId])
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
    if (!detectionTarget) return
    void detectExecutors(hostId)
  }, [detectionTarget, detectExecutors, hostId])

  useEffect(() => {
    const targetId = pendingEditId ?? executorId
    if (!targetId) return
    const card = document.getElementById(`executor-settings-${targetId}`) as HTMLDetailsElement | null
    if (!card) return
    card.open = true
    card.scrollIntoView?.({ block: 'nearest' })
    const name = card.querySelector<HTMLInputElement>('input[data-executor-name]')
    name?.focus()
    if (pendingEditId) name?.select()
  }, [executorId, pendingEditId])

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
      const executors = Object.fromEntries(Object.entries(next).map(([id, draft]) => {
        const existing = config.executors[id]
        assertExecutorProviderIdentity(id, existing, draft.providerId)
        const original = existing ? toDraft(existing) : undefined
        return [id, {
          label: draft.label.trim(), providerId: draft.providerId, command: draft.command.trim(),
          args: parseExecutorArgs(draft.args),
          env: original?.env === draft.env ? existing!.env : parseEnv(draft.env), injectAgentMuxGuide: draft.injectAgentMuxGuide,
          ...(draft.avatar ? { avatar: draft.avatar } : {})
        }]
      }))
      if (Object.values(executors).some((executor) => !executor.label || !executor.command)) {
        throw new Error('Executor names and commands cannot be empty')
      }
      await onSave(executors)
      setSavedDrafts(JSON.stringify(next))
    })
  }

  async function enableYolo(id?: string): Promise<void> {
    await saveDrafts(() => {
      const next = Object.fromEntries(Object.entries(drafts).map(([candidate, draft]) => {
        const args = candidate === id || id === undefined ? withYoloArgs(draft.providerId, parseExecutorArgs(draft.args)) : null
        return [candidate, args ? { ...draft, args: args.map(quote).join('\n') } : draft]
      }))
      setDrafts(next)
      return next
    })
  }

  function addExecutor(): void {
    const provider = providerCatalog[0]
    if (!provider) return
    const id = nextExecutorId(provider.id, drafts)
    setDrafts((current) => ({ ...current, [id]: {
      label: `${provider.label} ${Object.keys(current).length + 1}`, providerId: provider.id,
      command: provider.executable, args: '', env: '', injectAgentMuxGuide: true
    } }))
    setFilter({ query: '', snapshot: [] })
    setPendingEditId(id)
  }

  return (
    <div className="settings-pane-stack">
      <div className="settings-pane-toolbar">
        <span className="settings-resource-count">{filter.query.trim() ? `${matchCount} of ` : ''}{executors.length} {executors.length === 1 ? 'executor' : 'executors'}</span>
        <button className="small-button" disabled={providerCatalog.length === 0 || saving} onClick={addExecutor}><Plus size={13} /> Add executor</button>
      </div>
      <div className="settings-executor-tools">
        <label className="settings-resource-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Filter executors" placeholder="Find an executor…" value={filter.query} onChange={(event) => filterExecutors(event.target.value)} /></label>
        <div className="settings-detection-tools">
          <label className="settings-compact-field"><span>Check on</span><select value={hostId} onChange={(event) => setHostId(event.target.value)}>{config.hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
          <button className="icon-button" aria-label="Refresh executor availability" title="Refresh availability" disabled={checking} onClick={() => void detectExecutors(hostId)}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
        </div>
      </div>
      <div className="agent-settings-list">
        {executors.map(({ id, draft, detection }) => {
          const status = statusCopy(detection)
          return (
            <details className="agent-settings-card" key={id} id={`executor-settings-${id}`} tabIndex={-1} hidden={!matches(id)}>
              <summary>
                <span className="agent-provider-mark"><AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={draft.avatar ?? {}} size={20} /></span>
                <span><strong>{draft.label}</strong><small>{agentProviderLabel(draft.providerId)} · {id}</small></span>
                <em className={`check-pill check-pill--${detection?.state ?? 'idle'}`}>{status.icon}{status.label}</em>
                <ChevronDown className="settings-disclosure-icon" size={14} />
              </summary>
              <div className="agent-settings-fields">
                <label><span>Name</span><input data-executor-name value={draft.label} onChange={(event) => update(id, { label: event.target.value })} /></label>
                {config.executors[id] ? <dl className="settings-executor-identity"><div><dt>Provider</dt><dd>{agentProviderLabel(draft.providerId)}</dd></div><div><dt>Executor ID</dt><dd><code>{id}</code></dd></div></dl> :
                  <label><span>Provider</span><select value={draft.providerId} onChange={(event) => chooseProvider(id, event.target.value)}>{providerCatalog.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>}
                <div className="agent-avatar-settings__row">
                  <span className="agent-avatar-settings__name"><strong>Appearance</strong><small>Recognize this executor across your workspace</small></span>
                  <label>Tint<input type="color" aria-label={`${draft.label} avatar tint`} value={draft.avatar?.tint ?? '#8ab4f8'} onChange={(event) => updateAvatar(id, { ...draft.avatar, tint: event.target.value })} /></label>
                  <label>Icon<select aria-label={`${draft.label} avatar icon`} value={draft.avatar?.badge ?? ''} onChange={(event) => { const next = { ...draft.avatar }; if (event.target.value) next.badge = event.target.value as AgentAvatarBadge; else delete next.badge; updateAvatar(id, Object.keys(next).length ? next : (config.appearance.agentAvatars?.[id] ? {} : undefined)) }}><option value="">None</option>{AGENT_AVATAR_BADGE_IDS.map((badge) => <option key={badge} value={badge}>{AGENT_AVATAR_BADGE_LABELS[badge]}</option>)}</select></label>
                  <button type="button" className="small-button" aria-label={`Reset ${draft.label} avatar`} disabled={!draft.avatar?.tint && !draft.avatar?.badge} onClick={() => updateAvatar(id, config.appearance.agentAvatars?.[id] ? {} : undefined)}>Reset</button>
                </div>
                <details className="settings-launch-config">
                  <summary><span><strong>Launch configuration</strong><small>Command, arguments, and environment</small></span><ChevronDown size={14} /></summary>
                  <div className="settings-launch-config__fields">
                    <p className="settings-group-note">Used for new sessions. Running agents keep their current configuration.</p>
                    {!config.executors[id] ? <p className="settings-group-note">Executor ID: <code>{id}</code>. Provider and ID are fixed after saving.</p> : null}
                    <label><span>Command</span><input value={draft.command} onChange={(event) => update(id, { command: event.target.value })} /></label>
                    <label><span>Arguments <small>shell-style quoting</small></span><ComposerTextarea value={draft.args} onValueChange={(value) => update(id, { args: value })} placeholder="--model fable --effort high" rows={3} /></label>
                    <label><span>Environment <small>NAME=value, one per line</small></span><ComposerTextarea value={draft.env} onValueChange={(value) => update(id, { env: value })} placeholder="API_BASE=https://example.test" rows={3} /></label>
                    <label className="agent-guide-toggle"><input type="checkbox" checked={draft.injectAgentMuxGuide} onChange={(event) => update(id, { injectAgentMuxGuide: event.target.checked })} /><span><strong>AgentMux guide</strong><small>Help this agent use your views, tabs, and configured executors.</small></span></label>
                    {withYoloArgs(draft.providerId, []) ? <div className="settings-launch-action"><span>Skip permission prompts on future launches.</span><button type="button" className="small-button" disabled={saving} onClick={() => void enableYolo(id)}><WandSparkles size={13} /> Enable YOLO</button></div> : null}
                  </div>
                </details>
                {detection?.detail ? <p className="settings-inline-error">{detection.detail}</p> : null}
                <div className="settings-executor-remove"><button type="button" className="small-button" disabled={saving} onClick={() => setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== id)))}><Trash2 size={13} /> Delete executor</button></div>
              </div>
            </details>
          )
        })}
      </div>
      {executors.length === 0 ? <p className="settings-resource-empty">No executors yet. Add one to choose a provider.</p> : matchCount === 0 ? <p className="settings-resource-empty" role="status">No executors match “{filter.query}”.</p> : null}
      {executors.some(({ draft }) => withYoloArgs(draft.providerId, []) !== null) ? <details className="settings-bulk-actions"><summary>Launch actions <ChevronDown size={13} /></summary><div className="settings-launch-action"><span>Skip permission prompts for all Claude and Codex executors on future launches.</span><button className="small-button" disabled={saving} onClick={() => void enableYolo()}><WandSparkles size={13} /> Enable YOLO for Claude &amp; Codex</button></div></details> : null}
      <SettingsSaveBar save={saveState} dirty={dirty} label="Save executors" onSave={() => void saveDrafts(() => drafts)} />
    </div>
  )
}
