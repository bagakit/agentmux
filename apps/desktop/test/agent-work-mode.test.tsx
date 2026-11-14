// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentWorkPlacement, workReferenceHostId } from '../src/renderer/src/lib/agent-work-mode'
import { AgentWorkModeBadge } from '../src/renderer/src/components/AgentWorkModeBadge'
import { AgentWorkModeSetup } from '../src/renderer/src/components/AgentWorkModeSetup'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { LauncherAgentDevice } from '../src/renderer/src/components/LauncherAgentDevice'
import { ExecutionRouteLink } from '../src/renderer/src/components/AgentExecutionRelation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { chooseField } from './helpers/selection-field'
import { retainedFocusContext, createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const hosts = [...composerConfig.hosts, { id: 'other', kind: 'ssh' as const, hostname: 'fixture.invalid', label: 'Other Mac' }]
const binding = { bindingId: 'original', resourceRuntimeId: 'physical-project', resourceHostId: 'original-alias', workspacePath: '/project' }
it('a retained missing Agent workspace stays unknown without changing the original project or selection', async () => {
  const project = composerConfig.workspaces[0]!, config = { ...composerConfig, hosts }
  useAppStore.setState({ config })
  const before = useAppStore.getState(), select = vi.fn(), prepare = vi.fn()
  await dom.render(<LauncherAgentDevice hosts={hosts} workspace={project} agentWorkspace={undefined}
    explicitAgentWorkspaceId="retained-unavailable-agent" disabled={false} active onSelect={select} onPreparingChange={prepare} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Agent location"]')!
  expect(trigger.querySelector('[data-agent-host-id]')?.getAttribute('data-agent-host-id')).toBe('')
  expect(trigger.querySelector('[data-path-state]')?.getAttribute('data-path-state')).toBe('unconfirmed')
  expect(trigger.title).toContain('Agent on Host unknown')
  expect(trigger.textContent).not.toContain('Project device')
  expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().config).toBe(before.config)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it.each([
  ['local', 'local', 'local'], ['local', 'other', 'remote-project'],
  ['other', 'local', 'remote-agent'], ['other', 'other', 'remote-workspace'], ['other', null, 'unknown']
] as const)('actual identity badge projects Agent %s / project %s as %s', async (agentHostId, resourceHostId, mode) => {
  const source = { hostId: agentHostId, workspacePath: '/agent', toolExecution: binding, workPlacement: { agentHostId, resourceHostId } }
  const before = structuredClone(source)
  await dom.render(<AgentWorkModeBadge source={source} hosts={hosts} />)
  expect(agentWorkPlacement(source, workReferenceHostId(hosts)).mode).toBe(mode)
  if (mode === 'local') expect(dom.container.querySelector('[data-work-mode]')).toBeNull()
  else {
    const badge = dom.container.querySelector('[data-work-mode]')!
    expect(badge.getAttribute('data-work-mode')).toBe(mode)
    expect(badge.querySelector('[data-execution-role="project"]')).not.toBeNull()
    expect(badge.querySelector('[data-execution-role="agent"]')).not.toBeNull()
    expect(badge.getAttribute('aria-label')).toContain('Run mode; Project ·')
    expect(badge.getAttribute('aria-label')).toContain('Agent ·')
    expect(badge.textContent).not.toMatch(/Reach|Orbit|Remote Agent/)
    expect(badge.getAttribute('data-execution-relation')).toBe(agentHostId === resourceHostId ? 'same-device' : 'unconfirmed')
  }
  expect(source).toEqual(before)
})

it('a remote project starts with its own Agent and switching execution never offers to move that project', async () => {
  const local = composerConfig.workspaces[0]!, project = { ...local, id: 'project-b', hostId: 'other', path: '/B/project', name: 'Project B' }
  const config = { ...composerConfig, hosts, workspaces: [local, project] }
  useAppStore.setState({ config })
  const apply = vi.fn(), home = vi.spyOn(api.hosts, 'home')
  await dom.render(<AgentWorkModeSetup config={config} active fixedResourceWorkspaceId={project.id}
    initialSelection={{ resourceWorkspaceId: project.id, agentWorkspaceId: null }} actionLabel="Prepare" onApply={apply} />)
  expect(dom.container.querySelector('.agent-work-mode-choices')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Agent runs on"]')?.textContent).toContain('Other Mac')
  expect(dom.container.querySelector('input[value="remote-project"]')).toBeNull()
  expect(dom.container.querySelector('input[value="remote-workspace"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Working folder for this arrangement"]')).toBeNull()
  expect(dom.container.querySelector('.agent-work-project-anchor')?.textContent).toContain('Other Mac')
  await dom.click('.agent-work-setup__actions .primary-button')
  expect(apply).toHaveBeenCalledExactlyOnceWith({ resourceWorkspaceId: project.id, agentWorkspaceId: null })
  expect(home).not.toHaveBeenCalled()
})

it('Outpost for a remote project can select this viewer’s device while keeping the project fixed', async () => {
  const local = composerConfig.workspaces[0]!, project = { ...local, id: 'project-b', hostId: 'other', path: '/B/project', name: 'Project B' }
  const config = { ...composerConfig, hosts, workspaces: [local, project] }
  useAppStore.setState({ config })
  const apply = vi.fn()
  await dom.render(<AgentWorkModeSetup config={config} active fixedResourceWorkspaceId={project.id}
    initialSelection={{ resourceWorkspaceId: project.id, agentWorkspaceId: local.id }} actionLabel="Prepare" onApply={apply} />)
  expect(dom.container.querySelector('.agent-work-mode-choices')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Agent runs on"]')?.textContent).toContain(hosts[0]!.label)
  await dom.click('.agent-work-setup__actions .primary-button')
  expect(apply).toHaveBeenCalledExactlyOnceWith({ resourceWorkspaceId: project.id, agentWorkspaceId: local.id })
})

it.each([
  ['local', 'other', 'agent'], ['other', 'local', 'project'], ['other', 'other', null]
] as const)('compact Agent identity marks only the original local end (%s / %s)', async (agentHostId, resourceHostId, localRole) => {
  const source = { hostId: agentHostId, workspacePath: '/agent', toolExecution: binding, workPlacement: { agentHostId, resourceHostId } }
  const longHosts = hosts.map(host => ({ ...host, label: host.label + ' with a long device name' }))
  await dom.render(<AgentWorkModeBadge source={source} hosts={longHosts} />)
  const badge = dom.container.querySelector<HTMLElement>('.agent-work-mode-badge')!
  expect(badge.textContent).toBe('')
  expect(badge.querySelectorAll('[data-local]')).toHaveLength(localRole ? 1 : 0)
  if (localRole) expect(badge.querySelector('[data-local]')?.getAttribute('data-execution-role')).toBe(localRole)
  expect(badge.querySelector('svg[data-path-state] text')).toBeNull()
  await act(async () => badge.focus())
  const detail = document.querySelector('[role="tooltip"]')!
  expect(detail.textContent).toContain(longHosts.find(host => host.id === agentHostId)!.label)
  expect(detail.textContent).toContain(longHosts.find(host => host.id === resourceHostId)!.label)
  expect(detail.textContent).toContain('/agent'); expect(detail.textContent).toContain('/project')
})

it.each([
  [{ kind: 'same-device' } as const, 'same-device', ''],
  [{ kind: 'direct' } as const, 'direct', ''],
  [{ kind: 'unconfirmed' } as const, 'unconfirmed', ''],
  [{ kind: 'cascade', hops: 3 } as const, 'cascade', '3'],
  [{ kind: 'cascade', hops: 1 } as const, 'unconfirmed', '']
])('draws the supplied route relation without a zero/one-hop number (%j)', async (relation, kind, count) => {
  await dom.render(<ExecutionRouteLink relation={relation} />)
  const line = dom.container.querySelector('svg')!
  expect(line.getAttribute('data-path-state')).toBe(kind)
  expect(line.querySelector('text')?.textContent ?? '').toBe(count)
  expect(line.querySelector('path')).not.toBeNull()
  if (kind !== 'cascade') expect(Number(line.getAttribute('width'))).toBeLessThan(28)
  expect(line.getAttribute('aria-label')).toBe(kind === 'same-device' ? 'Same device' : kind === 'direct' ? 'Direct execution path' : kind === 'cascade' ? '3 execution hops' : 'Execution path unconfirmed')
})

it('one fixed-project device selection applies the other Agent end and retains the task without launching', async () => {
  const local = composerConfig.workspaces[0]!, project = { ...local, id: 'project-b', hostId: 'other', path: '/B/project', name: 'Project B' }
  const config = { ...composerConfig, hosts, workspaces: [local, project] }
  useAppStore.setState({ config, agentComposerDrafts: { original: 'Keep the original task' } })
  const before = useAppStore.getState(), apply = vi.fn(), launch = vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: local.hostId, homeDirectory: local.path })
  await dom.render(<AgentWorkModeSetup config={config} active fixedResourceWorkspaceId={project.id}
    initialSelection={{ resourceWorkspaceId: project.id, agentWorkspaceId: null }} actionLabel="Apply" onApply={apply} />)
  await chooseField(dom.container.querySelector<HTMLElement>('[aria-label="Agent runs on"]')!, local.hostId)
  expect(apply).not.toHaveBeenCalled(); expect(api.hosts.home).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.agent-work-project-anchor')?.textContent).toContain('Project B')
  await dom.click('.agent-work-setup__actions .primary-button')
  await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith({ resourceWorkspaceId: project.id, agentWorkspaceId: local.id }))
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(launch).not.toHaveBeenCalled()
})

it('reselecting the same device preserves its explicit startup, while a different device uses its own home', async () => {
  const local = composerConfig.workspaces[0]!, project = { ...local, id: 'project-b', hostId: 'other', path: '/B/project', name: 'Project B' }
  const startup = { ...project, id: 'custom-startup', path: '/B/agent-settings', name: 'Agent settings' }
  const config = { ...composerConfig, hosts, workspaces: [local, project, startup] }
  useAppStore.setState({ config })
  const apply = vi.fn(), home = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: local.hostId, homeDirectory: local.path })
  await dom.render(<AgentWorkModeSetup config={config} active fixedResourceWorkspaceId={project.id}
    initialSelection={{ resourceWorkspaceId: project.id, agentWorkspaceId: startup.id }} actionLabel="Apply" onApply={apply} />)
  await chooseField(dom.container.querySelector<HTMLElement>('[aria-label="Agent runs on"]')!, project.hostId)
  await dom.click('.agent-work-setup__actions .primary-button')
  expect(apply).toHaveBeenLastCalledWith({ resourceWorkspaceId: project.id, agentWorkspaceId: startup.id })
  expect(home).not.toHaveBeenCalled()
  await chooseField(dom.container.querySelector<HTMLElement>('[aria-label="Agent runs on"]')!, local.hostId)
  await dom.click('.agent-work-setup__actions .primary-button')
  await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith({ resourceWorkspaceId: project.id, agentWorkspaceId: local.id }))
  expect(home).toHaveBeenCalledExactlyOnceWith(hosts[0], expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it('a suppressed relation tooltip never adds an inactive focus stop inside its original button', async () => {
  const source = { hostId: 'other', workspacePath: '/agent', toolExecution: binding, workPlacement: { agentHostId: 'other', resourceHostId: 'local' } }
  await dom.render(<button type="button" aria-label="Original device action"><AgentWorkModeBadge source={source} hosts={hosts} hideTooltip /></button>)
  const badge = dom.container.querySelector<HTMLElement>('.agent-work-mode-badge')!
  expect(badge.hasAttribute('tabindex')).toBe(false)
  await act(async () => dom.container.querySelector('button')!.focus())
  expect(document.activeElement).toBe(dom.container.querySelector('button'))
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('a connected observer channel never becomes an execution route or hop count', async () => {
  const source = { hostId: 'other', workspacePath: '/agent', toolExecution: binding, workPlacement: { agentHostId: 'other', resourceHostId: 'local' } }
  useAppStore.setState({ hostTransports: { other: { state: 'connected', transport: 'ssh', establishedAt: 1, observedAt: 2, fallback: false } } })
  await dom.render(<button type="button">Original Agent<AgentWorkModeBadge source={source} hosts={hosts} embedded /></button>)
  const badge = dom.container.querySelector<HTMLElement>('[data-work-mode]')!
  expect(badge.getAttribute('data-execution-relation')).toBe('unconfirmed')
  expect(badge.querySelector('[data-path-state]')?.getAttribute('aria-label')).toBe('Execution path unconfirmed')
  expect(badge.tabIndex).toBe(-1)
  await act(async () => dom.container.querySelector('button')!.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Execution path unconfirmed')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Access from this device')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Channel connected')
  expect(document.querySelector('[role="tooltip"]')?.textContent).not.toMatch(/1 hop|Direct execution/)
})

it('the actual Agent header keeps one relation identity while Terminal retains its single Host identity', async () => {
  const session = { ...composerSession('original-header'), hostId: 'other', control: { ...composerSession('original-header').control, hostId: 'other' },
    toolExecution: binding, workPlacement: { agentHostId: 'other', resourceHostId: 'local' } }
  useAppStore.setState({ config: { ...composerConfig, hosts }, sessions: [session] })
  const properties = { name: 'Original work', executorLabel: 'Original executor', sessionId: session.id,
    executionHost: { id: 'other', label: 'Other Mac', kind: 'ssh' as const, configured: true, cwd: session.workspacePath }, regionId: 'original-header-region',
    readOnly: false, onHistory: undefined }
  await dom.render(<AgentRegionHeader {...properties} sessionKind="agent" nativeSession={session} />)
  expect(dom.container.querySelectorAll('.agent-work-mode-badge')).toHaveLength(1)
  expect(dom.container.querySelector('.agent-region-header__execution')).toBeNull()
  expect(dom.container.querySelector('header')?.textContent).toContain('Original work')
  await dom.render(<AgentRegionHeader {...properties} sessionKind="terminal" />)
  expect(dom.container.querySelector('.agent-work-mode-badge')).toBeNull()
  expect(dom.container.querySelectorAll('.agent-region-header__execution')).toHaveLength(1)
})

it('default startup details retain block flow while only the anchored variant owns grid gaps', async () => {
  await dom.render(<AgentWorkModeSetup config={{ hosts, workspaces: [] }} active initialMode="remote-agent" actionLabel="Prepare" onApply={vi.fn()} />)
  const details = dom.container.querySelector<HTMLDetailsElement>('details.agent-work-startup')!
  details.open = true
  expect(details.querySelector(':scope > .agent-work-setup__details-body')).not.toBeNull()
  expect(dom.container.querySelector('.agent-work-setup')?.getAttribute('data-presentation')).toBeNull()
  const css = readFileSync(resolve('apps/desktop/src/renderer/src/components/agent-work-mode.css'), 'utf8')
  const base = css.match(/\.agent-work-startup\[open\] > \.agent-work-setup__details-body \{([^}]+)\}/)?.[1]
  const anchored = css.match(/\.agent-work-setup\[data-presentation='anchored-editor'\] \.agent-work-setup__details-body \{([^}]+)\}/)?.[1]
  expect(base).toContain('display: block')
  expect(base).not.toContain('gap: 10px')
  expect(anchored).toContain('display: grid')
  expect(anchored).toContain('gap: 10px')
})

it('the real shared selector names each family and places its Agent and Project in the stated location', async () => {
  await dom.render(<AgentWorkModeSetup config={{ hosts, workspaces: [] }} active initialMode="remote-agent" actionLabel="Prepare" onApply={vi.fn()} />)
  for (const [id, brand, descriptor, agent, project] of [
    ['remote-project', 'Reach', 'Remote Project', 'here', 'remote'],
    ['remote-agent', 'Outpost', 'Remote Agent', 'remote', 'here'],
    ['remote-workspace', 'Orbit', 'Remote Workspace', 'remote', 'remote']
  ]) {
    const input = dom.container.querySelector<HTMLInputElement>(`input[value="${id}"]`)!, choice = input.closest('label')!
    expect(input.getAttribute('aria-label')).toContain(`${brand} · ${descriptor}`)
    expect(choice.textContent).toContain(brand); expect(choice.textContent).toContain(descriptor)
    expect(choice.querySelector(`[data-placement-zone="${agent}"] [data-placement-role="agent"]`)).not.toBeNull()
    expect(choice.querySelector(`[data-placement-zone="${project}"] [data-placement-role="project"]`)).not.toBeNull()
    await act(async () => choice.click())
    expect(input.checked).toBe(true); expect(choice.getAttribute('data-selected')).toBe('true')
    await act(async () => input.focus()); expect(document.activeElement).toBe(input)
  }
})

it('selecting Reach through its full Surface still prepares the original two ends without touching the task or launching', async () => {
  const local = composerConfig.workspaces[0]!, remote = { ...local, id: 'remote-project', hostId: 'other', path: '/original/project' }
  const config = { ...composerConfig, hosts, workspaces: [local, remote] }
  useAppStore.setState({ config, agentComposerDrafts: { original: 'Preserve @relative/file and the task' } })
  const before = useAppStore.getState(), apply = vi.fn(), launch = vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'local', homeDirectory: local.path })
  await dom.render(<AgentWorkModeSetup config={config} active allowLocal initialMode="remote-agent" initialSelection={{ resourceWorkspaceId: local.id, agentWorkspaceId: null }} actionLabel="Prepare" onApply={apply} />)
  const reach = dom.container.querySelector<HTMLInputElement>('input[value="remote-project"]')!
  await act(async () => reach.closest('label')!.click())
  await chooseField(dom.container.querySelector<HTMLElement>('[aria-label="Working folder for this arrangement"]')!, remote.id)
  expect(apply).not.toHaveBeenCalled(); expect(api.hosts.home).not.toHaveBeenCalled()
  await dom.click('.agent-work-setup__actions .primary-button')
  expect(apply).toHaveBeenCalledExactlyOnceWith({ resourceWorkspaceId: remote.id, agentWorkspaceId: local.id })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(launch).not.toHaveBeenCalled()
})
it('ordinary remote Agent needs no fake binding; raw coordinator local cannot claim observer local', () => {
  expect(agentWorkPlacement({ hostId: 'other', workspacePath: '/project' }, 'local').mode).toBe('remote-workspace')
  expect(agentWorkPlacement({ hostId: 'other', workspacePath: '/agent', toolExecution: { ...binding, resourceHostId: 'local' } }, 'local')).toMatchObject({ mode: 'unknown', projectHostId: null })
})
it('retained identity carries original binding and client projection without inventing a current Run', () => {
  const source = { hostId: 'other', agentSessionId: 'old-agent', state: 'retained' as const,
    history: { ...composerSession(), toolExecution: binding }, workPlacement: { agentHostId: 'other', resourceHostId: 'local' } }
  const retained = retainedFocusContext(source as Parameters<typeof retainedFocusContext>[0])
  expect(retained.toolExecution).toBe(binding)
  expect(agentWorkPlacement(retained, 'local').mode).toBe('remote-agent')
  expect(retained.runUnobserved).toBe(true)
  expect(retained.liveAgent).toBe(false)
})

it('Focus cache retains equal placement clones and updates only the changed Agent when route facts change',()=>{
  const session={...composerSession(),toolExecution:binding,workPlacement:{agentHostId:'local',resourceHostId:'other'}}
  const other={...composerSession('unchanged'),toolExecution:binding,workPlacement:{agentHostId:'local',resourceHostId:'other'}}
  const input={sessions:[session,other],config:composerConfig,timelines:{},agentNames:{},scratchTopicSnapshots:{}}
  const select=createFocusProjectionSelector(),before=select(input)
  const same=select({...input,sessions:[{...session,toolExecution:{...binding},workPlacement:{...session.workPlacement}},other]})
  expect(same.contexts).toBe(before.contexts)
  const changed=select({...input,sessions:[{...session,workPlacement:{agentHostId:'local',resourceHostId:null}},other]})
  expect(agentWorkPlacement(changed.contexts.find(row=>row.id===session.id)!, 'local').mode).toBe('unknown')
  expect(changed.contexts.find(row=>row.id===other.id)).toBe(before.contexts.find(row=>row.id===other.id))
})
