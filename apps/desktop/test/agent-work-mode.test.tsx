// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { agentWorkPlacement, workReferenceHostId } from '../src/renderer/src/lib/agent-work-mode'
import { AgentWorkModeBadge } from '../src/renderer/src/components/AgentWorkModeBadge'
import { AgentWorkModeSetup } from '../src/renderer/src/components/AgentWorkModeSetup'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { chooseField } from './helpers/selection-field'
import { retainedFocusContext, createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const hosts = [...composerConfig.hosts, { id: 'other', kind: 'ssh' as const, hostname: 'fixture.invalid', label: 'Other Mac' }]
const binding = { bindingId: 'original', resourceRuntimeId: 'physical-project', resourceHostId: 'original-alias', workspacePath: '/project' }
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
    const label = { 'remote-project': 'Reach · Remote Project', 'remote-agent': 'Relay · Remote Agent', 'remote-workspace': 'Orbit · Remote Workspace', unknown: 'Placement unknown' }[mode]
    expect(badge.textContent).toBe(label); expect(badge.getAttribute('aria-label')).toContain(label)
  }
  expect(source).toEqual(before)
})

it('the real shared selector names each family and places its Agent and Project in the stated location', async () => {
  await dom.render(<AgentWorkModeSetup config={{ hosts, workspaces: [] }} active initialMode="remote-agent" actionLabel="Prepare" onApply={vi.fn()} />)
  for (const [id, brand, descriptor, agent, project] of [
    ['remote-project', 'Reach', 'Remote Project', 'here', 'remote'],
    ['remote-agent', 'Relay', 'Remote Agent', 'remote', 'here'],
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
  await chooseField(dom.container.querySelector<HTMLElement>('[aria-label="Project for this arrangement"]')!, remote.id)
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
