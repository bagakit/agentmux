const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { registerWorkspace } from '../src/main/settings-workspace-add-control'
import { ConfigStore } from '../src/main/config-store'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SCRATCH_WORKSPACE_ID, type WorkspaceRecord } from '../src/shared/contracts'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'

const dom = composerDOM(), close = vi.fn(), saveHosts = vi.fn()
let f: Awaited<ReturnType<typeof configOwnerFixture>>
function View({ active = true }: { active?: boolean }) {
  const config = useAppStore(state => state.config)!
  return <HostSettingsPane config={config} active={active} onSave={saveHosts} onClose={close} />
}
beforeEach(async () => {
  f = await configOwnerFixture({
    hosts: [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'saved.invalid' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [{ id: 'original', name: 'Original', hostId: 'local', path: _hygiene_fixturePath("owned-original"), kind: 'folder' },
      { id: 'remote-root', name: 'Remote project', hostId: 'remote', path: _hygiene_fixturePath("srv/project"), kind: 'folder' },
      { id: 'remote-tree', name: 'Feature', hostId: 'remote', path: _hygiene_fixturePath("srv/project/.worktrees/feature"), repoPath: _hygiene_fixturePath("srv/project"), branch: 'feature', kind: 'worktree' },
      { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: _hygiene_fixturePath("owned-scratch"), kind: 'folder' }]
  })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.getState().setConfig(saved) })
  useAppStore.setState({ config: f.owner.current, activeWorkspaceId: 'original',
    layouts: { original: createWorkspaceLayout('original-group') }, hostChecks: { local: { state: 'ready' }, remote: { state: 'error', detail: 'Check did not acquire facts' } },
    checkHost: vi.fn(async () => {}), detectExecutors: vi.fn(async () => {}), launchAgent: vi.fn(async () => {}) })
  vi.spyOn(api.workspaces, 'add').mockImplementation(async input => (await registerWorkspace(input, f.owner, () => ({}))).workspace)
  close.mockClear(); saveHosts.mockClear()
})
function pane(id = 'remote') {
  const node = dom.container.querySelector<HTMLElement>(`[data-host-projects="${id}"]`)
  expect(node, `connected Projects consumer ${id}`).not.toBeNull()
  expect(node!.isConnected).toBe(true)
  return node!
}
async function select(id = 'remote', panel = 'projects') {
  await dom.click(`[data-host-disclosure="${id}"] [data-host-panel="${panel}"]`)
}
async function show(id = 'remote') {
  await dom.render(<View />); await select(id)
  await act(async () => pane(id).querySelector<HTMLButtonElement>('.host-projects__heading button')!.click())
}
async function fill(placeholder: string, value: string, id = 'remote') {
  const node = pane(id).querySelector<HTMLInputElement>(`[placeholder="${placeholder}"]`)
  expect(node).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(selector: string, id = 'remote') {
  const node = pane(id).querySelector<HTMLButtonElement>(selector)
  expect(node).not.toBeNull()
  await act(async () => node!.click())
}
async function settle() {
  for (let tries = 0; tries < 100; tries++) {
    await act(async () => { await new Promise(done => setTimeout(done, 5)) })
    if (!dom.container.querySelector('.host-projects .spin')) return
  }
  throw new Error('Folder operation did not settle')
}

it('keeps Main-owned registration outside the Renderer Control bridge', async () => {
  const before = structuredClone(useAppStore.getState().layouts)
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'wrong-renderer-route', operation: 'settings.workspaces.add', input: { hostId: 'remote', path: _hygiene_fixturePath("srv/new") } })).rejects.toMatchObject({ code: 'CONTROL_FAILED' })
  expect(api.workspaces.add).not.toHaveBeenCalled(); expect(useAppStore.getState().layouts).toEqual(before)
})

it('registers on the exact committed Host despite unknown checks, without opening, starting or saving connection drafts', async () => {
  await show(); await fill('Project directory', ("  " + _hygiene_fixturePath("owned-new") + "  ")); await fill('Project name', '  Authored project  ')
  const before = structuredClone(useAppStore.getState().layouts), drafts = structuredClone(useAppStore.getState().agentComposerDrafts)
  const selectWorkspace = vi.spyOn(useAppStore.getState(), 'selectWorkspace')
  await click('[data-register-folder]'); await settle()
  expect(api.workspaces.add).toHaveBeenCalledExactlyOnceWith({ hostId: 'remote', path: _hygiene_fixturePath("owned-new"), name: 'Authored project' })
  const saved = f.owner.current.workspaces.find(workspace => workspace.path === _hygiene_fixturePath("owned-new"))!
  expect(saved.hostId).toBe('remote'); expect(saved.id).toBeTruthy()
  expect((await new ConfigStore(f.store.filePath).get()).workspaces).toEqual(f.owner.current.workspaces)
  expect(selectWorkspace).not.toHaveBeenCalled(); expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceId).toBe('original'); expect(useAppStore.getState().layouts).toEqual(before)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts); expect(close).not.toHaveBeenCalled(); expect(saveHosts).not.toHaveBeenCalled()
  expect(pane().querySelector('[data-folder-stage]')!.textContent).toContain('Folder registered on Remote')
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled(); expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
})

it('opens only the returned registered identity and preserves unrelated owner publications', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new"))
  const pending = deferred<void>(), entered = deferred<void>(), real = vi.mocked(api.workspaces.add).getMockImplementation()!
  const get = vi.spyOn(api.config, 'get'), before = structuredClone(useAppStore.getState().layouts.original)
  vi.mocked(api.workspaces.add).mockImplementationOnce(async input => { const saved = await real(input); entered.resolve(); await pending.promise; return saved })
  await act(async () => { pane().querySelector<HTMLButtonElement>('[data-open-folder]')!.click(); await entered.promise })
  await act(async () => { await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true })) })
  await act(async () => pending.resolve()); await settle()
  expect(useAppStore.getState().activeWorkspaceId).toBe(f.owner.current.workspaces.find(workspace => workspace.path === _hygiene_fixturePath("owned-new"))!.id)
  expect(useAppStore.getState().config!.copyPathsAsAbsolute).toBe(true)
  expect(useAppStore.getState().layouts.original).toEqual(before); expect(get).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})

it('uses the returned folder and its layout for explicit opt-in Agent start without probing', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new"))
  const launch = vi.fn(async () => {
    const state = useAppStore.getState(), workspace = state.config!.workspaces.find(item => item.id === state.activeWorkspaceId)!
    expect(workspace).toMatchObject({ hostId: 'remote', path: _hygiene_fixturePath("owned-new") })
  })
  useAppStore.setState({ launchAgent: launch })
  await act(async () => { const node = pane().querySelector('select')!; node.value = 'codex'; node.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('[data-open-folder]'); await settle()
  const saved = f.owner.current.workspaces.find(workspace => workspace.path === _hygiene_fixturePath("owned-new"))!
  expect(launch).toHaveBeenCalledExactlyOnceWith('codex', '', useAppStore.getState().layouts[saved.id]!.activeGroupId)
  expect(close).toHaveBeenCalledOnce(); expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
})

it('retains registered facts and authored fields when Open fails, and retries Open without registering again', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new")); await fill('Project name', 'Keep my fields')
  vi.spyOn(useAppStore.getState(), 'selectWorkspace').mockRejectedValueOnce(new Error('Owned Open failure'))
  await click('[data-open-folder]'); await settle()
  expect(pane().querySelector('[data-folder-stage]')!.getAttribute('data-folder-stage')).toBe('registered')
  expect(pane().textContent).toContain('Folder registered. Opening did not complete.'); expect(pane().textContent).toContain('Owned Open failure')
  expect(pane().querySelector<HTMLInputElement>('[placeholder="Project name"]')!.value).toBe('Keep my fields')
  expect((await f.disk()).workspaces.some(workspace => workspace.path === _hygiene_fixturePath("owned-new"))).toBe(true)
  expect(close).not.toHaveBeenCalled()
  await click('.host-projects__progress button'); await settle()
  expect(api.workspaces.add).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledOnce()
})

it('reports the opened stage after Agent start failure and never rolls back registration or auto-retries startup', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new"))
  useAppStore.setState({ launchAgent: vi.fn(async () => { throw new Error('Owned Start failure') }) })
  await act(async () => { const node = pane().querySelector('select')!; node.value = 'codex'; node.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('[data-open-folder]'); await settle()
  expect(pane().querySelector('[data-folder-stage]')!.getAttribute('data-folder-stage')).toBe('opened')
  expect(pane().textContent).toContain('Agent start did not return a confirmed result'); expect(pane().textContent).toContain('Owned Start failure')
  expect((await f.disk()).workspaces.some(workspace => workspace.path === _hygiene_fixturePath("owned-new"))).toBe(true)
  expect(useAppStore.getState().launchAgent).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
  await click('.host-projects__progress button'); await settle()
  expect(useAppStore.getState().launchAgent).toHaveBeenCalledOnce(); expect(api.workspaces.add).toHaveBeenCalledOnce()
})

it('keeps registration failure fields and original work surface for an explicit retry', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new")); await fill('Project name', 'My project')
  const bytes = await f.bytes(), before = structuredClone(useAppStore.getState().layouts)
  f.save.mockRejectedValueOnce(new Error('Owned durable failure'))
  await click('[data-register-folder]'); await settle()
  expect(pane().querySelector('[role="alert"]')!.textContent).toContain('Owned durable failure')
  expect(pane().querySelector<HTMLInputElement>('[placeholder="Project directory"]')!.value).toBe(_hygiene_fixturePath("owned-new"))
  expect(await f.bytes()).toBe(bytes); expect(useAppStore.getState().layouts).toEqual(before)
  expect(close).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
  await click('[data-register-folder]'); await settle(); expect(f.publish).toHaveBeenCalledOnce()
})

it('never steals later Host selection when an earlier registration reply returns', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new"))
  const pending = deferred<WorkspaceRecord>(), selected = vi.spyOn(useAppStore.getState(), 'selectWorkspace')
  vi.mocked(api.workspaces.add).mockImplementationOnce(async input => { const saved = (await registerWorkspace(input, f.owner, () => ({}))).workspace; await pending.promise; return saved })
  await click('[data-open-folder]'); await select('local')
  await act(async () => pending.resolve(f.owner.current.workspaces.find(workspace => workspace.path === _hygiene_fixturePath("owned-new"))!)); await settle()
  expect(selected).not.toHaveBeenCalled(); expect(useAppStore.getState().activeWorkspaceId).toBe('original'); expect(close).not.toHaveBeenCalled()
  await select('remote'); expect(pane().querySelector<HTMLInputElement>('[placeholder="Project directory"]')!.value).toBe(_hygiene_fixturePath("owned-new"))
  expect(pane().querySelector('[data-folder-stage]')!.textContent).toContain('Folder registered')
})

it('refuses to open a registration reply from a different Host', async () => {
  await show(); await fill('Project directory', _hygiene_fixturePath("owned-new"))
  vi.mocked(api.workspaces.add).mockResolvedValueOnce(f.owner.current.workspaces.find(workspace => workspace.id === 'original')!)
  const selected = vi.spyOn(useAppStore.getState(), 'selectWorkspace')
  await click('[data-open-folder]'); await settle()
  expect(pane().querySelector('[role="alert"]')!.textContent).toContain('another environment')
  expect(selected).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})

it('keeps per-Host folder drafts and connection drafts while using only the committed connection', async () => {
  await dom.render(<View />); await select('remote', 'connection')
  const input = dom.container.querySelector<HTMLInputElement>('.host-connection-fields input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Draft label'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await select(); await act(async () => pane().querySelector<HTMLButtonElement>('.host-projects__heading button')!.click())
  await fill('Project directory', _hygiene_fixturePath("owned-new")); await select('local'); await select('remote')
  expect(pane().querySelector<HTMLInputElement>('[placeholder="Project directory"]')!.value).toBe(_hygiene_fixturePath("owned-new"))
  expect(pane().textContent).toContain('saved Remote connection (saved.invalid)'); expect(pane().textContent).toContain('connection edits are still drafts')
  await click('[data-register-folder]'); await settle(); expect(f.owner.current.hosts.find(host => host.id === 'remote')!.label).toBe('Remote')
  await select('remote', 'connection'); expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('Draft label')
  expect(saveHosts).not.toHaveBeenCalled()
})

it('counts Projects by original root grouping, exposes folder/worktree facts and retains exact existing Open', async () => {
  await show()
  expect(dom.container.querySelector('[data-host-disclosure="remote"] [data-host-panel="projects"] small')!.textContent).toBe('1')
  expect(pane().querySelectorAll('[data-project-id]')).toHaveLength(1); expect(pane().querySelectorAll('[data-registered-folder]')).toHaveLength(2)
  expect(pane().textContent).toContain('Worktree · feature')
  await click('[data-registered-folder="remote-tree"] button'); await settle()
  expect(useAppStore.getState().activeWorkspaceId).toBe('remote-tree'); expect(api.workspaces.add).not.toHaveBeenCalled()
  await select('local'); expect(pane('local').querySelectorAll('[data-project-id]')).toHaveLength(1)
  expect(pane('local').querySelector(`[data-registered-folder="${SCRATCH_WORKSPACE_ID}"]`)).toBeNull()
})

it('explains an unsaved Host and passive or hidden panes do not probe or execute', async () => {
  await dom.render(<View />); await dom.click('.settings-pane-toolbar button')
  const newHost = dom.container.querySelector<HTMLElement>('[data-resource-editor]')!.dataset.resourceEditor!
  await select(newHost)
  expect(pane(newHost).textContent).toContain('Save this connection before registering a folder')
  expect(pane(newHost).querySelector<HTMLButtonElement>('.host-projects__heading button')!.disabled).toBe(true)
  await dom.render(<View active={false} />)
  await act(async () => useAppStore.setState({ hostChecks: {}, sessions: [] }))
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled(); expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(api.workspaces.add).not.toHaveBeenCalled(); expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled(); expect(saveHosts).not.toHaveBeenCalled()
})
