import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { FileReadResult } from '@agentmux/core/files'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { MobileApp } from '../src/MobileApp'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const listeners = new Set<() => void>()
const media = { matches: true, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
const connection = { state: 'connected' as const, message: 'Original Host' }
const rootPath = fixturePath('responsive-original')
const originalFile = 'plan.txt'
const originalBody = 'Original file stays on its exact resource.'
const resource = { hostId: 'host-original', workspaceId: 'resource-original', workspacePath: rootPath, zoneId: 'zone-original', zonePath: rootPath, path: originalFile }
const readParams = { zoneId: resource.zoneId, path: 'plan.txt', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } }
const shown = (node: Element) => !node.closest('[hidden]')
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 4000, interval: 10 }) }
async function resize(wide: boolean) { await act(async () => { media.matches = wide; for (const listener of listeners) listener() }) }

function setup(size = 2) {
  const f = fixture()
  const catalog: AgentMuxSpaceCatalog = {
    spaces: [{ spaceId: 'space-original', kind: 'folder', name: 'Original project', hostId: resource.hostId, directoryPath: rootPath, projectId: null }],
    zones: [{ zoneId: resource.zoneId, workspaceId: resource.workspaceId, kind: 'directory', hostId: resource.hostId, directoryPath: rootPath, branch: null }],
    bindings: [{ spaceId: 'space-original', zoneId: resource.zoneId }],
    tabs: [{ tabId: 'tab-original', zoneId: resource.zoneId, workspaceId: resource.workspaceId, name: 'Original workface', regionIds: ['region-file', 'region-agent'] }],
    regions: [
      { tabId: 'tab-original', regionId: 'region-file', kind: 'file', agentSessionId: null, runId: null, execution: null, file: { workspaceId: resource.workspaceId, path: originalFile, zoneRelativePath: 'plan.txt' } },
      { tabId: 'tab-original', regionId: 'region-agent', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: resource.hostId, cwd: rootPath } }
    ],
    locations: [{ spaceId: 'space-original', zoneId: resource.zoneId, workspaceId: resource.workspaceId, displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-agent' }],
    agentPresentation: Array.from({ length: size }, (_, index) => ({ agentSessionId: index === 0 ? 'session-original' : `responsive-peer-${index}`, providerId: 'codex', name: `Original Agent ${index}`, project: `Original project ${index % 2}`, state: 'working', stateMark: 'working', group: 'working', detail: 'Original working observation',
      projectGroup: { key: `project-${index % 2}`, projectId: `project-${index % 2}`, spaceId: null, hostId: resource.hostId, name: `Original project ${index % 2}` }, recap: { text: 'Original owner recap', source: 'native-hook' } }))
  }
  let foreignReply = false
  const forward = vi.fn(async (method: string, input?: unknown) => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: structuredClone(catalog) }
    if (method === 'app.snapshot') return { agents: [], workspaces: [{ workspaceId: resource.workspaceId, hostId: resource.hostId, path: rootPath, name: 'Original workspace' }] }
    if (method === 'file.read') return { resource: { ...resource, ...(foreignReply ? { hostId: 'foreign-host' } : {}) }, result: { status: 'read', document: { path: originalFile, content: foreignReply ? 'Foreign replacement must not appear.' : originalBody, revision: 'original-revision' } } } satisfies FileReadResult
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession((input as { target: { agentSessionId: string } }).target.agentSessionId), displayName: { override: null, availability: 'observed' } }
    throw Error('Unconfigured original read: ' + method)
  })
  f.client.forwardRpc = forward as NonNullable<typeof f.client.forwardRpc>
  return { ...f, catalog, forward, substituteFileReply() { foreignReply = true } }
}
const calls = (f: ReturnType<typeof setup>, method: string) => f.forward.mock.calls.filter(([name]) => name === method)
function noBusiness(f: ReturnType<typeof setup>) {
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
  expect(f.rejoinInput).not.toHaveBeenCalled(); expect(f.stopInput).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.filter(([method]) => ['agent.open', 'agent.recover', 'agent.stop', 'file.write'].includes(method))).toEqual([])
}
async function chooseFile(element: HTMLElement) {
  await wait(() => expect(element.querySelector('.mobile-space-row')).not.toBeNull())
  await click(element.querySelector('.mobile-space-row')!)
  const file = [...element.querySelectorAll<HTMLButtonElement>('.mobile-space-navigation .mobile-spatial-tab button')].find(node => node.textContent?.includes('plan.txt'))
  expect(file, 'The actual original file row is present in the expanded Space').toBeDefined()
  await click(file!)
  await wait(() => expect(element.querySelector('.mobile-region-content')?.textContent).toContain(originalBody))
}
beforeEach(async () => { media.matches = true; listeners.clear(); vi.stubGlobal('matchMedia', () => media); window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  await act(async () => vi.dynamicImportSettled())
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('responsive Space keeps its original tree and file reader through width changes without another catalog read', async () => {
  const f = setup(), open = vi.fn()
  const surface = (wide: boolean, visible = true) => <div hidden={!visible}><MobileSpatialNavigation home="space" wide={wide} visible={visible} client={f.client} connected sessions={f.client.agentSessions()} openSession={open} /></div>
  const view = await mount(surface(true))
  await chooseFile(view.element)
  const navigation = view.element.querySelector('.mobile-space-navigation')!, tree = view.element.querySelector('.mobile-space-node')!, row = tree.querySelector('.mobile-space-row')!
  const reader = view.element.querySelector<HTMLElement>('.mobile-region-content')!
  expect(shown(row), 'The original Space tree stays usable beside the selected file').toBe(true)
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(button(view.element, 'plan.txt文件').getAttribute('aria-current')).toBe('page')
  expect(calls(f, 'file.read')).toEqual([['file.read', readParams]])
  const catalogs = calls(f, 'space.ls').length
  reader.scrollTop = 27
  await view.render(surface(false))
  expect(view.element.querySelector('.mobile-space-node')).toBe(tree); expect(shown(row)).toBe(false)
  expect(view.element.querySelector('.mobile-region-content'), 'Width may not remount the original reader').toBe(reader)
  expect(shown(reader)).toBe(true); expect(reader.scrollTop).toBe(27)
  await view.render(surface(true))
  expect(view.element.querySelector('.mobile-space-navigation')).toBe(navigation); expect(shown(row)).toBe(true)
  expect(view.element.querySelector('.mobile-region-content')).toBe(reader)
  expect(calls(f, 'space.ls')).toHaveLength(catalogs); expect(calls(f, 'file.read')).toHaveLength(1)
  await view.render(surface(true, false)); await view.render(surface(false, false))
  expect(calls(f, 'space.ls')).toHaveLength(catalogs); expect(calls(f, 'file.read')).toHaveLength(1)
  expect(open).not.toHaveBeenCalled(); noBusiness(f)
})

it('responsive Space preserves the exact original binding and refuses a foreign file receipt while retaining its readable node', async () => {
  const f = setup(), open = vi.fn()
  const view = await mount(<MobileSpatialNavigation home="space" wide client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
  await chooseFile(view.element)
  const reader = view.element.querySelector('.mobile-region-content')!
  f.catalog.zones[0]!.hostId = 'foreign-host'
  await click(button(view.element, '刷新空间目录'))
  await wait(() => expect(view.element.textContent).toContain('这个位置的绑定还没重新确认'))
  expect(view.element.querySelector('.mobile-space-navigation [aria-current="page"]')).toBeNull()
  f.substituteFileReply()
  await click(button(reader as HTMLElement, '刷新文件'))
  expect(view.element.querySelector('.mobile-region-content')).toBe(reader)
  expect(reader.textContent).toContain(originalBody); expect(reader.textContent).not.toContain('Foreign replacement must not appear.')
  await wait(() => expect(reader.textContent).toContain('文件位置与读取结果对不上'))
  expect(calls(f, 'file.read')).toEqual([['file.read', readParams], ['file.read', readParams]])
  expect(open).not.toHaveBeenCalled(); noBusiness(f)
})

it.each([20, 480])('responsive Focus keeps %i original project rows and opens the original Agent with one directory owner', async size => {
  const f = setup(size), owner = getDeviceWorkface()
  await owner.updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' }, { primary: 'focus', showSession: false, showGoalWork: false, identity: null, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} restoreWorkface />)
  await wait(() => expect(view.element.querySelectorAll('.mobile-focus-project .mobile-agent-row')).toHaveLength(size))
  const projects = view.element.querySelector('.mobile-focus-projects')!, firstProject = projects.firstElementChild!, first = firstProject.querySelector('.mobile-agent-row__open')!
  expect(projects.children).toHaveLength(2)
  expect(firstProject.querySelector('h2')?.textContent).toContain('Original project 0')
  const catalogs = calls(f, 'space.ls').length, record = owner.recordIdentity()
  await resize(false); await resize(true)
  expect(view.element.querySelector('.mobile-focus-projects'), 'Width may not replace the original Focus project DOM').toBe(projects)
  expect(projects.firstElementChild).toBe(firstProject); expect(firstProject.querySelector('.mobile-agent-row__open')).toBe(first)
  expect(calls(f, 'space.ls')).toHaveLength(catalogs)
  await click(first)
  await wait(() => expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false))
  const originalEditor = editor(view.element)
  await paste(view.element, 'Original Focus draft remains attached.')
  expect(owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
  expect(view.element.querySelectorAll('.mobile-focus-projects')).toHaveLength(1)
  await click(button(view.element.querySelector('.mobile-header') as HTMLElement, '返回 Focus'))
  await click(first)
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('Original Focus draft remains attached.')
  expect(owner.recordIdentity()).toBe(record); expect(calls(f, 'space.ls')).toHaveLength(catalogs)
  noBusiness(f)
})
