import { AGENT_AVATAR_BADGE_IDS, AGENT_AVATAR_BADGE_LABELS } from '../../../../shared/contracts'
import { AgentAvatar } from '../AgentAvatar'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  WandSparkles,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import parseArgsStringToArgv from 'string-argv'
import type { AgentExecutorConfig, AppConfig, AgentAvatarAppearance, AgentAvatarBadge } from '../../../../shared/contracts'
import { executorDetectionKey, useAppStore } from '../../store'
import { presentError } from '../../lib/error-presentation'
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

function toDraft(config: AgentExecutorConfig): ExecutorDraft {
  return {
    label: config.label,
    providerId: config.providerId,
    command: config.command,
    args: config.args.join('\n'),
    env: Object.entries(config.env).map(([name, value]) => `${name}=${value}`).join('\n'),
    injectAgentMuxGuide: config.injectAgentMuxGuide,
    avatar: config.avatar
  }
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line) continue
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

/**
 * Split the free-text Arguments field into the argv array core spawns with. A launch line is written the
 * way a shell would read it — space-separated tokens with optional quoting — so `--effort 'ultracode'` is
 * two argv entries and `--model "gpt 5"` is one whose value keeps its space. Newlines count as whitespace,
 * so the older one-flag-per-line style still parses. Splitting only on `\n` was the bug: a whole line like
 * `--model 'default' --effort 'ultracode'` became ONE argv token the downstream CLI rejected as an unknown
 * option. Quotes are shell syntax, not part of the value, so they are stripped — done by string-argv rather
 * than hand-rolled so escapes and mixed quoting are handled by a maintained parser.
 */
export function parseExecutorArgs(text: string): string[] {
  return parseArgsStringToArgv(text)
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
  const [hostId, setHostId] = useState(initialHost)
  const [drafts, setDrafts] = useState<Record<string, ExecutorDraft>>(() =>
    Object.fromEntries(Object.entries(config.executors).map(([id, executor]) => [id, toDraft(executor)]))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  const groups = [
    { title: 'Available', items: executors.filter((executor) => executor.detection?.state === 'ready') },
    { title: 'Other executors', items: executors.filter((executor) => executor.detection?.state !== 'ready') }
  ]

  useEffect(() => {
    if (!detectionTarget) return
    void detectExecutors(hostId)
  }, [detectionTarget, detectExecutors, hostId])

  useEffect(() => {
    if (!executorId) return
    const card = document.getElementById(`executor-settings-${executorId}`) as HTMLDetailsElement | null
    if (card) { card.open = true; card.scrollIntoView?.({ block: 'nearest' }); card.focus() }
  }, [executorId])

  function updateAvatar(id: string, patch: AgentAvatarAppearance | undefined) {
    update(id, { avatar: patch })
  }

  function update(id: string, patch: Partial<ExecutorDraft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }

  async function enableYolo(id: string, providerId: string): Promise<void> {
    const args = withYoloArgs(providerId, parseExecutorArgs(drafts[id]?.args ?? ''))
    if (!args) return
    const next = Object.fromEntries(Object.entries(drafts).map(([candidate, draft]) => [candidate,
      candidate === id ? { ...draft, args: args.join(' ') } : draft]))
    setDrafts(next)
    await onSave(Object.fromEntries(Object.entries(next).map(([candidate, draft]) => [candidate, {
      label: draft.label.trim(), providerId: draft.providerId, command: draft.command.trim(),
      args: parseExecutorArgs(draft.args), env: parseEnv(draft.env), injectAgentMuxGuide: draft.injectAgentMuxGuide,
      ...(draft.avatar ? { avatar: draft.avatar } : {})
    }])))
  }

  async function enableAllYolo(): Promise<void> {
    const next = Object.fromEntries(Object.entries(drafts).map(([candidate, draft]) => {
      const args = withYoloArgs(draft.providerId, parseExecutorArgs(draft.args))
      return [candidate, args ? { ...draft, args: args.join(' ') } : draft]
    }))
    setDrafts(next)
    await onSave(Object.fromEntries(Object.entries(next).map(([candidate, draft]) => [candidate, {
      label: draft.label.trim(), providerId: draft.providerId, command: draft.command.trim(),
      args: parseExecutorArgs(draft.args), env: parseEnv(draft.env), injectAgentMuxGuide: draft.injectAgentMuxGuide,
      ...(draft.avatar ? { avatar: draft.avatar } : {})
    }])))
  }

  function addExecutor(): void {
    const provider = providerCatalog[0]
    if (!provider) return
    setDrafts((current) => {
      const id = nextExecutorId(provider.id, current)
      return {
        ...current,
        [id]: {
          label: `${provider.label} ${Object.keys(current).length + 1}`,
          providerId: provider.id,
          command: provider.executable,
          args: '',
          env: '',
          injectAgentMuxGuide: true
        }
      }
    })
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const executors = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => {
        const existing = config.executors[id]
        assertExecutorProviderIdentity(id, existing, draft.providerId)
        return [id, {
          label: draft.label.trim(),
          providerId: draft.providerId,
          command: draft.command.trim(),
          args: parseExecutorArgs(draft.args),
          env: parseEnv(draft.env),
          injectAgentMuxGuide: draft.injectAgentMuxGuide,
          ...(draft.avatar ? { avatar: draft.avatar } : {})
        }]
      }))
      if (Object.values(executors).some((executor) => !executor.label || !executor.command)) {
        throw new Error('Executor names and commands cannot be empty')
      }
      await onSave(executors)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <div className="settings-pane-toolbar">
        <label className="settings-compact-field"><span>Detect on</span><select value={hostId} onChange={(event) => setHostId(event.target.value)}>{config.hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
        <button className="small-button" disabled={checking} onClick={() => void detectExecutors(hostId)}>{checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Refresh</button>
        <button className="small-button" disabled={providerCatalog.length === 0} onClick={addExecutor}><Plus size={13} /> Add executor</button>
        {executors.some(({ draft }) => withYoloArgs(draft.providerId, []) !== null) ? <button className="small-button" disabled={saving} onClick={() => void enableAllYolo()}><WandSparkles size={13} /> Enable YOLO for Claude &amp; Codex</button> : null}
      </div>
      {groups.map((group) => group.items.length > 0 ? (
        <section className="settings-group" key={group.title}>
          <header><span>{group.title}</span><small>{group.items.length}</small></header>
          <div className="agent-settings-list">
            {group.items.map(({ id, draft, detection }) => {
              const status = statusCopy(detection)
              return (
                <details className="agent-settings-card" key={id} id={`executor-settings-${id}`} tabIndex={-1} {...(executorId === id ? { open: true } : {})}>
                  <summary>
                    <span className="agent-provider-mark"><AgentAvatar providerId={draft.providerId} executorId={id} label={draft.label} appearance={draft.avatar ?? {}} size={18} /></span>
                    <span><strong>{draft.label}</strong><small>{agentProviderLabel(draft.providerId)} · {draft.command}</small></span>
                    <em className={`check-pill check-pill--${detection?.state ?? 'idle'}`}>{status.icon}{status.label}</em>
                    <ChevronDown className="settings-disclosure-icon" size={14} />
                  </summary>
                  <div className="agent-settings-fields">
                    <div className="agent-avatar-settings__row">
                      <span className="agent-avatar-settings__name"><strong>Avatar</strong><small>Provider mark with a small fixed icon</small></span>
                      <label>Tint<input type="color" aria-label={`${draft.label} avatar tint`} value={draft.avatar?.tint ?? '#8ab4f8'}
                        onChange={(event) => updateAvatar(id, { ...draft.avatar, tint: event.target.value })} /></label>
                      <label>Icon<select aria-label={`${draft.label} avatar icon`} value={draft.avatar?.badge ?? ''}
                        onChange={(event) => { const next = { ...draft.avatar }; if (event.target.value) next.badge = event.target.value as AgentAvatarBadge; else delete next.badge; updateAvatar(id, Object.keys(next).length ? next : undefined) }}>
                        <option value="">None</option>{AGENT_AVATAR_BADGE_IDS.map((badge) => <option key={badge} value={badge}>{AGENT_AVATAR_BADGE_LABELS[badge]}</option>)}
                      </select></label>
                      <button type="button" className="small-button" aria-label={`Reset ${draft.label} avatar`} disabled={!draft.avatar} onClick={() => updateAvatar(id, undefined)}>Reset</button>
                    </div>
                    <label><span>Name</span><input value={draft.label} onChange={(event) => update(id, { label: event.target.value })} /></label>
                    <label>
                      <span>Provider</span>
                      <select
                        value={draft.providerId}
                        disabled={Boolean(config.executors[id])}
                        onChange={(event) => update(id, { providerId: event.target.value })}
                      >
                        {providerCatalog.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.label}</option>
                        ))}
                      </select>
                      {config.executors[id]
                        ? <small>Provider is part of this Executor identity. Create a new Executor to change it.</small>
                        : null}
                    </label>
                    <label><span>Executor ID</span><input value={id} readOnly /><small>Stable ID used by the AgentMux CLI and existing Sessions.</small></label>
                    <label><span>Command</span><input value={draft.command} onChange={(event) => update(id, { command: event.target.value })} /></label>
                    <label className="agent-guide-toggle"><input type="checkbox" checked={draft.injectAgentMuxGuide} onChange={(event) => update(id, { injectAgentMuxGuide: event.target.checked })} /><span><strong>AgentMux guide</strong><small>Tell this Agent to inspect the current View and use configured executors for tabs and splits.</small></span></label>
                    <label><span>Arguments <small>space or newline separated</small></span><ComposerTextarea value={draft.args} onValueChange={(value) => update(id, { args: value })} placeholder="--model fable&#10;--effort 'high'" rows={3} /></label>
                    <label><span>Environment <small>NAME=value</small></span><ComposerTextarea value={draft.env} onValueChange={(value) => update(id, { env: value })} placeholder="API_BASE=https://example.test" rows={3} /></label>
                    {detection?.detail ? <p className="settings-inline-error">{detection.detail}</p> : null}
                    {withYoloArgs(draft.providerId, []) ? <button type="button" className="small-button" disabled={saving} onClick={() => void enableYolo(id, draft.providerId)}><WandSparkles size={13} /> Enable YOLO</button> : null}
                    <button type="button" className="small-button" onClick={() => setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== id)))}><Trash2 size={13} /> Delete executor</button>
                  </div>
                </details>
              )
            })}
          </div>
        </section>
      ) : null)}
      {executors.length === 0 ? <div className="agent-catalog__empty">No executors configured. Add one and choose its Provider.</div> : null}
      {error ? <div className="dialog-error" role="alert">{error}</div> : null}
      <div className="settings-pane-actions"><span>Detection uses each saved executor command on the selected host.</span><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save executors'}</button></div>
    </div>
  )
}
