import { useLayoutEffect, useRef, useState } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import type { LauncherExecutionSelection } from '../store'
import { LauncherExecutionPicker } from './LauncherExecutionPicker'

const LocalIcon = semanticIconComponent('object.host')
const ProjectIcon = semanticIconComponent('object.folder')
const RemoteIcon = semanticIconComponent('object.remote-execution')
const SelectedIcon = semanticIconComponent('status.selected')
const CloseIcon = semanticIconComponent('action.close')
const BackIcon = semanticIconComponent('navigation.back')
const DownIcon = semanticIconComponent('navigation.down')

type Intent = 'local' | 'remote' | 'remote-agent' | 'custom'
type Setup = { intent: Intent; resourceWorkspaceId: string | undefined; agentWorkspaceId: string | null; picking: 'resource' | 'runtime' | null }
const modes = [
  { id: 'local', title: 'Local development', detail: 'Project and Agent on this machine', Icon: LocalIcon },
  { id: 'remote', title: 'Remote development', detail: 'Project and Agent on a server', Icon: ProjectIcon },
  { id: 'remote-agent', title: 'Remote Agent', detail: 'Local project · remote Agent', Icon: RemoteIcon }
] as const

/** Common intentions project the original two addresses; only an exact choice commits. */
export function LauncherExecutionModes({ hosts, workspaces, workspace, agentWorkspace, explicitAgentWorkspaceId, disabled, onSelect, onManageProjects, onGuide }: {
  hosts: readonly HostConfig[]
  workspaces: readonly WorkspaceRecord[]
  workspace: WorkspaceRecord | undefined
  agentWorkspace: WorkspaceRecord | undefined
  explicitAgentWorkspaceId: string | undefined
  disabled: boolean
  onSelect(selection: LauncherExecutionSelection, options: { navigateProject: boolean }): boolean
  onManageProjects(): void
  onGuide?: (() => void) | undefined
}) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const setupRef = useRef<HTMLDivElement | null>(null)
  const previousPicker = useRef<Setup['picking']>(null)
  useLayoutEffect(() => {
    const previous = previousPicker.current
    previousPicker.current = setup?.picking ?? null
    if (setup && setup.picking === null && previous) setupRef.current?.querySelector<HTMLButtonElement>(`[data-endpoint="${previous}"]`)?.focus()
  }, [setup?.picking])
  const projectHost = hosts.find(host => host.id === workspace?.hostId)
  const runtimeHost = hosts.find(host => host.id === agentWorkspace?.hostId)
  const selected: Intent = explicitAgentWorkspaceId !== undefined
    ? projectHost?.kind === 'local' && runtimeHost?.kind === 'ssh' ? 'remote-agent' : 'custom'
    : projectHost?.kind === 'local' ? 'local' : projectHost?.kind === 'ssh' ? 'remote' : 'custom'
  const projects = workspaces.filter(item => !isScratchWorkspaceId(item.id))
  const resource = projects.find(item => item.id === setup?.resourceWorkspaceId)
  const runtime = projects.find(item => item.id === setup?.agentWorkspaceId)

  function environmentLabel(target: WorkspaceRecord | undefined) {
    if (!target) return 'No machine selected'
    const host = hosts.find(item => item.id === target.hostId)
    if (!host) return target.hostId
    return host.kind === 'ssh' ? `${host.label} · ${host.user ? `${host.user}@` : ''}${host.hostname}${host.port ? `:${host.port}` : ''}`
      : `${host.label} · This machine`
  }

  function commit(resourceWorkspaceId: string, agentWorkspaceId: string | null, intent: Intent) {
    if (onSelect({ resourceWorkspaceId, agentWorkspaceId }, { navigateProject: intent !== 'custom' })) {
      setSetup(null)
      if (resourceWorkspaceId === workspace?.id) trigger.current?.focus({ preventScroll: true })
    }
  }
  function begin(intent: Intent, button: HTMLButtonElement) {
    trigger.current = button
    if (intent === 'local' && workspace && projectHost?.kind === 'local') return commit(workspace.id, null, intent)
    if (intent === 'remote' && workspace && projectHost?.kind === 'ssh') return commit(workspace.id, null, intent)
    if (intent === 'remote-agent' && workspace && projectHost?.kind === 'local' && agentWorkspace && runtimeHost?.kind === 'ssh') {
      return commit(workspace.id, agentWorkspace.id, intent)
    }
    setSetup({ intent, resourceWorkspaceId: workspace?.id, agentWorkspaceId: explicitAgentWorkspaceId ?? null,
      picking: intent === 'custom' ? null : intent === 'remote-agent' && projectHost?.kind === 'local' ? 'runtime' : 'resource' })
  }
  function cancel() { setSetup(null); trigger.current?.focus() }
  function choose(id: string) {
    if (!setup) return
    if (setup.picking === 'runtime') {
      if (setup.intent === 'custom') setSetup({ ...setup, agentWorkspaceId: id, picking: null })
      else if (setup.resourceWorkspaceId) commit(setup.resourceWorkspaceId, id, setup.intent)
    } else if (setup.intent === 'custom') setSetup({ ...setup, resourceWorkspaceId: id, picking: null })
    else if (setup.intent === 'remote-agent') setSetup({ ...setup, resourceWorkspaceId: id, picking: 'runtime' })
    else commit(id, null, setup.intent)
  }
  const pickingRuntime = setup?.picking === 'runtime'
  const allowedKind = setup?.intent === 'custom' ? undefined : pickingRuntime || setup?.intent === 'remote' ? 'ssh' : 'local'
  const availableHosts = allowedKind ? hosts.filter(host => host.kind === allowedKind) : hosts
  const setupTitle = setup?.intent === 'custom' ? 'Custom arrangement' : pickingRuntime ? 'Choose the remote Agent environment' : setup?.intent === 'remote' ? 'Choose a remote project' : 'Choose a local project'
  return <section className="launcher-execution" aria-label="Execution arrangement">
    <div className="launcher-execution__modes" aria-label="Common execution modes">
      {modes.map(({ id, title, detail, Icon }) => <button key={id} type="button" className="launcher-execution__mode"
        aria-pressed={selected === id} data-pending={setup?.intent === id || undefined} disabled={disabled}
        onClick={event => begin(id, event.currentTarget)} title={detail}>
        <Icon size={17} aria-hidden="true" /><span><strong>{title}</strong><small>{detail}</small></span>
        {selected === id ? <SelectedIcon size={13} aria-label="Selected arrangement" /> : null}
      </button>)}
    </div>
    <div className="launcher-execution__actions">
      <button type="button" className="launcher-execution__custom" aria-pressed={selected === 'custom'} aria-expanded={setup?.intent === 'custom'}
        disabled={disabled} onClick={event => begin('custom', event.currentTarget)}>
        <RemoteIcon size={13} />{selected === 'custom' ? 'Custom arrangement' : 'Custom'}<DownIcon size={11} />
      </button>
      {onGuide ? <button type="button" className="launcher-execution__guide" onClick={onGuide}>How it works</button> : null}
    </div>
    {setup ? <div ref={setupRef} className="launcher-execution__setup" onKeyDown={event => { if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) { event.preventDefault(); event.stopPropagation(); cancel() } }}>
      <header><div><strong>{setupTitle}</strong><p>{pickingRuntime ? 'Native configuration and Skills load here. No project copy is needed.'
        : setup.intent === 'custom' ? 'Choose project tools and Agent runtime independently.' : `Opens this project’s own work. Your draft stays in ${workspace?.name ?? 'its original project'}.`}</p></div>
        <button type="button" className="icon-button" aria-label="Cancel execution setup" onClick={cancel}><CloseIcon size={14} /></button></header>
      {setup.intent === 'custom' && setup.picking ? <button type="button" className="launcher-execution__custom"
        onClick={() => setSetup({ ...setup, picking: null })}><BackIcon size={12} />Back to arrangement</button> : null}
      {setup.picking ? <LauncherExecutionPicker key={`${setup.intent}:${setup.picking}`} hosts={availableHosts}
        workspaces={projects.filter(item => availableHosts.some(host => host.id === item.hostId))}
        selected={pickingRuntime ? runtime : resource} disabled={disabled} purpose={pickingRuntime ? 'runtime' : 'project'}
        autoFocus onSelect={choose} onManageProjects={onManageProjects} /> : <>
        <div className="launcher-execution__endpoints">
          <button type="button" data-endpoint="resource" onClick={() => setSetup({ ...setup, picking: 'resource' })}><ProjectIcon size={15} /><span><small>Project & tools</small><strong>{resource?.name ?? 'Choose a project'}</strong><span className="launcher-execution__machine">{environmentLabel(resource)}</span><code>{resource?.path ?? 'No directory selected'}</code></span><DownIcon size={12} /></button>
          <button type="button" data-endpoint="runtime" onClick={() => setSetup({ ...setup, picking: 'runtime' })}><RemoteIcon size={15} /><span><small>Agent runtime</small><strong>{setup.agentWorkspaceId === null ? 'Follow project' : runtime?.name ?? 'Environment unavailable'}</strong><span className="launcher-execution__machine">{environmentLabel(setup.agentWorkspaceId === null ? resource : runtime)}</span><code>{setup.agentWorkspaceId === null ? resource?.path : runtime?.path}</code></span><DownIcon size={12} /></button>
        </div>
        <footer><button type="button" className="small-button" onClick={cancel}>Cancel</button>
          <button type="button" className="small-button" onClick={() => setSetup({ ...setup, agentWorkspaceId: null })}>Agent follows project</button>
          <button type="button" className="primary-button" disabled={disabled || !resource || setup.agentWorkspaceId !== null && !runtime}
            onClick={() => resource && commit(resource.id, setup.agentWorkspaceId, setup.intent)}>Use arrangement</button></footer>
      </>}
    </div> : null}
  </section>
}
