import { fixturePath as _reshape_fixturePath } from "../../../test/fixture-values.mjs"
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { projectRailTree } from '@agentmux/client-ui/project-rail-tree'
import * as railTree from '@agentmux/client-ui/project-rail-tree'
import { projectRailTree as desktopTree } from '../../desktop/src/renderer/src/lib/workspace-projects'
import { spatialCatalog } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../../desktop/src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '../../../packages/layout/src/index'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileDirectoryNotice } from '../src/navigation/MobileDirectoryNotice'
import { button, click, fixture, mount, mounted } from './conversation-fixture'
const catalog: AgentMuxSpaceCatalog = {
  spaces: [{ spaceId: 'mote-original', name: '原 Mote', kind: 'mote', hostId: 'host-original', directoryPath: _reshape_fixturePath("private/mote"), projectId: null }],
  zones: [{ zoneId: 'zone-original', workspaceId: 'resource-original', kind: 'home', hostId: 'host-original', directoryPath: _reshape_fixturePath("private/mote"), branch: null }],
  bindings: [{ spaceId: 'mote-original', zoneId: 'zone-original' }],
  tabs: [{ tabId: 'tab-original', zoneId: 'zone-original', workspaceId: 'resource-original', name: '原计划 Tab', regionIds: ['region-original'] }],
  regions: [{ tabId: 'tab-original', regionId: 'region-original', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: _reshape_fixturePath("private/execution") } }],
  locations: [{ spaceId: 'mote-original', zoneId: 'zone-original', workspaceId: 'resource-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-original' }],
  agentPresentation: [{ agentSessionId: 'session-original', name: '原 Agent', project: '原项目', detail: '原 detail', group: 'working', state: 'working', providerId: 'codex', recap: { text: '从原 owner 读回的 recap', source: 'native-hook' } }],
  motePresentation: [{ spaceId: 'mote-original', content: null, quickMode: { status: 'saved', version: 'fixture-original', defaults: { conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-original' } } }, conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-original' } }]
}
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; localStorage.clear(); vi.restoreAllMocks() })
const decoded = (value: AgentMuxSpaceCatalog) => (parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-tree-read', operation: 'space.ls', ok: true, result: { catalog: value } }).result as { catalog: AgentMuxSpaceCatalog }).catalog

describe('original mobile directory tree consumers', () => {
  it('opens original Mote Tabs inline even with a default conversation, shows owner recap, then explicitly opens the exact original occurrence', async () => {
    const f = fixture(), open = vi.fn(), rpc = vi.fn(async () => ({ catalog: decoded(catalog) })); f.client.forwardRpc = rpc as never
    if (process.env.MOBILE_TREE_EVIDENCE) await writeFile(resolve(process.env.MOBILE_TREE_EVIDENCE, 'mote-owner-catalog.json'), JSON.stringify(decoded(catalog)))
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    expect(view.element.querySelector('.mobile-space-row'), view.element.textContent ?? '').not.toBeNull()
    await click(view.element.querySelector('.mobile-space-row')!)
    expect(open).not.toHaveBeenCalled()
    expect(view.element.querySelector('h1')?.textContent).toBe('Mote')
    expect(view.element.querySelector('.mobile-space-row')?.getAttribute('aria-expanded')).toBe('true')
    expect(view.element.querySelector('.mobile-space-children')?.textContent).toContain('原计划 Tab')
    expect(view.element.querySelector('.mobile-session-recap')?.textContent).toBe('从原 owner 读回的 recap')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('space.ls', { target: {}, presentation: true })
    await click(view.element.querySelector('.mobile-spatial-tab button')!)
    expect(open).toHaveBeenCalledExactlyOnceWith('session-original', expect.objectContaining({ context: catalog.locations[0] }))
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('keeps distinct original Agent names under a multi-Region Tab and opens each exact occurrence', async () => {
    const f = fixture(), open = vi.fn(), second = { ...catalog.regions[0]!, regionId: 'region-peer', agentSessionId: 'peer', runId: 'run-peer' }
    const split = { ...catalog, tabs: [{ ...catalog.tabs[0]!, regionIds: ['region-original', 'region-peer'] }], regions: [...catalog.regions, second],
      locations: [...catalog.locations, { ...catalog.locations[0]!, regionId: 'region-peer' }],
      agentPresentation: [{ ...catalog.agentPresentation![0]!, name: 'Original left', recap: null }, { ...catalog.agentPresentation![0]!, agentSessionId: 'peer', name: 'Original right', recap: null }] }
    f.client.forwardRpc = vi.fn(async () => ({ catalog: decoded(split) })) as never
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    await click(view.element.querySelector('.mobile-space-row')!)
    const rows = view.element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')
    expect([...rows].map(row => row.querySelector('strong')?.textContent)).toEqual(['Original left', 'Original right'])
    await click(rows[1]!);expect(open).toHaveBeenLastCalledWith('peer', expect.objectContaining({ context: split.locations[1] }))
    await click(rows[0]!);expect(open).toHaveBeenLastCalledWith('session-original', expect.objectContaining({ context: split.locations[0] }))
  })
  it('closes only the directory layer through Back and retains the original Mote after a failed refresh', async () => {
    const f = fixture(), back = vi.fn(), open = vi.fn();let fail = false
    f.client.forwardRpc = vi.fn(async () => { if (fail) throw Error('original observation failed'); return { catalog: decoded(catalog) } }) as never
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} onBackChange={back} />)
    await click(view.element.querySelector('.mobile-space-row')!);fail = true;await click(button(view.element, '刷新空间目录'))
    expect(view.element.querySelector('.mobile-directory-notice')?.textContent).toContain('original observation failed')
    expect(view.element.querySelector('.mobile-directory-notice')?.hasAttribute('open')).toBe(false)
    expect(view.element.querySelector('.mobile-spatial-tab')).not.toBeNull()
    await act(async () => back.mock.calls.at(-1)![0]())
    expect(view.element.querySelector('.mobile-spatial-tab')).toBeNull()
    expect(view.element.querySelector('.mobile-space-row')).not.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
  it('consumes real Desktop spatialCatalog binding facts with its exact shared grouping algorithm, retaining worktree and Tab identity', async () => {
    expect(desktopTree).toBe(projectRailTree)
    const root = _reshape_fixturePath("private/fixture/projects"), workspaces = [
      { id: 'root', hostId: 'local', name: 'Original root', path: root + '/repo', kind: 'folder' },
      { id: 'nested', hostId: 'local', name: 'Nested repo', path: root + '/repo/sub', kind: 'folder' },
      { id: 'prefix', hostId: 'local', name: 'Prefix sibling', path: root + '/repo-copy', kind: 'folder' },
      { id: 'remote', hostId: 'remote-host', name: 'Remote root', path: root + '/repo', kind: 'folder' },
      { id: 'worktree', hostId: 'local', name: 'Real branch', path: _reshape_fixturePath("private/worktree"), repoPath: root + '/repo', branch: 'feature/original', kind: 'worktree' }
    ]
    const tab = createWorkbenchTab('worktree-tab', { kind: 'launcher', regionId: 'worktree-region', workspaceId: 'worktree' }, 'Original branch Tab')
    const state = { config: { workspaces, executors: {}, hosts: [{ id: 'local', kind: 'local' }] }, sessions: [], tabs: { [tab.id]: tab }, layouts: { worktree: createWorkspaceLayout('worktree-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} } as any
    const original = decoded(spatialCatalog(state, []))
    if (process.env.MOBILE_TREE_EVIDENCE) await writeFile(resolve(process.env.MOBILE_TREE_EVIDENCE, 'desktop-owner-catalog.json'), JSON.stringify(original))
    const client = { forwardRpc: vi.fn(async () => ({ catalog: original })) } as any
    const view = await mount(<MobileSpatialNavigation home="space" client={client} connected sessions={[]} openSession={vi.fn()} />)
    expect(view.element.textContent).toContain('projects')
    expect(view.element.textContent).toContain('remote-host')
    const row = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-space-row')].find(item => item.textContent?.includes('Original root'))!
    await click(row)
    const nested = [...view.element.querySelectorAll<HTMLElement>('.mobile-space-node')].find(item => item.querySelector(':scope > button')?.textContent?.includes('Nested repo'))!
    expect(nested.style.getPropertyValue('--tree-depth')).toBe('1')
    const sibling = [...view.element.querySelectorAll<HTMLElement>('.mobile-space-node')].find(item => item.querySelector(':scope > button')?.textContent?.includes('Prefix sibling'))!
    expect(sibling.style.getPropertyValue('--tree-depth')).toBe('0')
    expect(view.element.textContent).toContain('feature/original')
    expect(view.element.textContent).toContain('Original branch Tab')
    const location = original.locations.find(value => value.tabId === 'worktree-tab')!
    expect([...view.element.querySelectorAll('[data-zone-id]')].map(value => value.getAttribute('data-zone-id'))).toContain(location.zoneId)
    expect(client.forwardRpc).toHaveBeenCalledOnce()
  })
  it('keeps unrelated Folder derivation outside the Mote consumer and builds it only for Space', async () => {
    const tree = vi.spyOn(railTree, 'projectRailTree'), f = fixture()
    const folders = Array.from({ length: 64 }, (_, i) => ({ spaceId: `folder${i}`, name: `Folder ${i}`, kind: 'folder' as const, hostId: 'local', directoryPath: _reshape_fixturePath(`fixture/projects/repo${i}`), projectId: `project${i}` }))
    f.client.forwardRpc = vi.fn(async () => ({ catalog: decoded({ ...catalog, spaces: [...catalog.spaces, ...folders] }) })) as never
    const component = (home: 'mote' | 'space') => <MobileSpatialNavigation home={home} client={f.client} connected sessions={f.client.agentSessions()} openSession={vi.fn()} />
    const view = await mount(component('mote'))
    await click(view.element.querySelector('.mobile-space-row')!)
    expect(view.element.querySelector('.mobile-session-recap')?.textContent).toBe('从原 owner 读回的 recap')
    expect(tree).not.toHaveBeenCalled()
    await view.render(component('space'))
    expect(tree).toHaveBeenCalledOnce()
    expect(view.element.textContent).toContain('Folder 63')
  })
  it('folds the real parent chain beyond capped indentation and keeps independent prefix siblings', async () => {
    const spaces = Array.from({ length: 6 }, (_, i) => ({ spaceId: `deep${i}`, name: `Level ${i}`, kind: 'folder' as const, hostId: 'local', directoryPath: _reshape_fixturePath("private/chain/") + Array.from({ length: i + 1 }, (_, j) => `l${j}`).join('/'), projectId: `project${i}` }))
    spaces.push({ ...spaces[3]!, spaceId: 'prefix-independent', name: 'Independent prefix sibling', directoryPath: spaces[3]!.directoryPath + '-copy', projectId: 'project-prefix' })
    const original = decoded({ spaces, zones: [], bindings: [], tabs: [], regions: [], locations: [] })
    const rpc = vi.fn(async () => ({ catalog: original }))
    const view = await mount(<MobileSpatialNavigation home="space" client={{ forwardRpc: rpc } as any} connected sessions={[]} openSession={vi.fn()} />)
    const row = (id: string) => view.element.querySelector(`[data-space-id="${id}"] > button`)!
    expect(row('deep5')).toBeNull()
    for (let i = 0; i < 5; i++) await click(row(`deep${i}`))
    expect(row('deep5')).not.toBeNull()
    expect(view.element.querySelector<HTMLElement>('[data-space-id="deep5"]')!.style.getPropertyValue('--tree-depth')).toBe('3')
    await click(row('deep4'))
    expect(row('deep4')).not.toBeNull(); expect(row('deep5')).toBeNull()
    expect(row('prefix-independent')).not.toBeNull()
    expect(row('deep3').getAttribute('aria-expanded')).toBe('true')
    await click(row('deep4')); expect(row('deep5')).not.toBeNull()
    expect(rpc).toHaveBeenCalledOnce()
  })
  it('uses original manual Project groups without hiding their temporarily undiscovered members', async () => {
    const { motePresentation: _mote, ...directory } = catalog
    const original = { ...directory, spaces: [{ ...catalog.spaces[0]!, kind: 'folder' as const, projectId: 'original-project' }], projectGroups: [{ groupId: 'manual-original', name: 'Original group', projectIds: ['original-project', 'missing-original-project'] }] }
    const view = await mount(<MobileSpatialNavigation home="space" client={{ forwardRpc: async () => ({ catalog: decoded(original) }) } as any} connected sessions={[]} openSession={vi.fn()} />)
    expect(view.element.textContent).toContain('Original group'); expect(view.element.textContent).toContain('missing-original-project')
    expect(view.element.querySelector('.mobile-tree-unconfirmed button')).toBeNull()
  })
  it('retains exact original failure details and recovery under a compact persistent service disclosure', async () => {
    const retry = vi.fn(), view = await mount(<MobileDirectoryNotice issues={[{ source: 'Original Mote', message: 'Actual owner observation failed; durable binding retained.' }]} retry={retry} />)
    const details = view.element.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('部分目录信息未确认')
    expect(details.querySelector('summary')?.textContent).not.toContain('Actual owner observation failed')
    expect(details.textContent).toContain('Actual owner observation failed; durable binding retained.')
    await act(async () => { details.open = true })
    await click(details.querySelector('button')!);expect(retry).toHaveBeenCalledOnce()
  })

})
