import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileZoneWorkface } from '../src/navigation/MobileZoneWorkface'
import { spatialCatalog } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab, addWorkbenchRegion } from '../../desktop/src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '../../../packages/layout/src/index'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const views: { root: Root; element: HTMLElement }[] = []
afterEach(async () => { for (const view of views.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } })
async function mount(node: React.ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); views.push({ root, element })
  await act(async () => root.render(node)); return element
}
async function click(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
function original(kind: 'folder' | 'mote' = 'folder') {
  const workspace = { id: 'resource', hostId: 'local', name: 'Original Project', path: (new URL('file:///').pathname + "private/original-resource"), kind: 'folder' }
  let tab = createWorkbenchTab('tab-original', { kind: 'agent', regionId: 'region-original', workspaceId: workspace.id, sessionId: 'sid-original' }, 'Original work')
  tab = addWorkbenchRegion(tab, 'region-original', 'right', { kind: 'agent', regionId: 'region-second', workspaceId: workspace.id, sessionId: 'sid-second' })
  const raw = spatialCatalog({ config: { workspaces: [workspace], executors: {}, hosts: [] }, sessions: [], tabs: { [tab.id]: tab },
    layouts: { display: createWorkspaceLayout('group-original', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} } as any, [])
  const catalog: AgentMuxSpaceCatalog = { ...raw, spaces: raw.spaces.map(space => ({ ...space, kind })), agentPresentation: [
    { agentSessionId: 'sid-original', name: 'Known original Agent', project: workspace.name, detail: '', group: 'results', state: 'done', providerId: 'codex', recap: { text: 'Original result', source: 'Reply' } }
  ] }
  const service = new AgentMuxRpcService({ execute: async request => ({ operation: request.operation, catalog } as never) })
  const rpc = vi.fn((method: string, params: unknown) => service.call(method as never, params as never))
  return { catalog, rpc, client: { forwardRpc: rpc, onEvent: () => () => {} } as any, open: vi.fn() }
}
describe('original spatial Agent remains readable before SDK inventory hydration', () => {
  it.each(['space', 'mote'] as const)('opens every original Region in %s even with an empty SDK inventory', async home => {
    const f = original(home === 'mote' ? 'mote' : 'folder')
    const element = await mount(<MobileSpatialNavigation client={f.client} connected home={home} sessions={[]} openSession={f.open} />)
    await click(element, 'Original Project'); await click(element, 'Known original Agent')
    expect(f.open).toHaveBeenLastCalledWith('sid-original', expect.objectContaining({ name: 'Known original Agent', context: expect.objectContaining({ tabId: 'tab-original', regionId: 'region-original', groupId: 'group-original' }) }))
    const rows = element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list > li > button')
    expect(rows).toHaveLength(2)
    await act(async () => rows[1]!.click())
    expect(f.open).toHaveBeenLastCalledWith('sid-second', expect.objectContaining({ context: expect.objectContaining({ regionId: 'region-second' }) }))
    expect(rows[1]!.textContent).toContain('状态未确认')
    expect(f.rpc.mock.calls.map(([method]) => method)).toEqual(['space.ls'])
  })
  it('retains a Focus presentation row without substituting a fabricated SDK Session', async () => {
    const f = original()
    const element = await mount(<MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={f.open} />)
    await click(element, 'Known original Agent')
    expect(f.open).toHaveBeenLastCalledWith('sid-original', expect.objectContaining({ name: 'Known original Agent' }))
    expect(f.rpc).toHaveBeenCalledTimes(1)
  })
  it('retains exact Topic occurrences instead of borrowing the first display position', async () => {
    const f = original()
    const first = f.catalog.locations.find(value => value.regionId === 'region-original')!
    f.catalog.locations.push({ ...first, displayWorkspaceId: 'second-display', groupId: 'second-group' })
    const element = await mount(<MobileZoneWorkface client={f.client} zoneId={f.catalog.zones[0]!.zoneId} name="Original Topic" visible openSession={f.open} />)
    await click(element, 'Known original Agent')
    expect(f.open.mock.calls.at(-1)![1]).not.toHaveProperty('context')
    await click(element, 'second-display / second-group')
    expect(f.open).toHaveBeenLastCalledWith('sid-original', expect.objectContaining({ context: { ...first, displayWorkspaceId: 'second-display', groupId: 'second-group' } }))
    expect(f.rpc.mock.calls.map(([method]) => method)).toEqual(['space.ls'])
  })
})
