import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileAgentMenuContext } from '../src/navigation/MobileAgentRow'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, session } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

async function directory(home: 'mote' | 'space' | 'focus', emptyPresentation = false) {
  const f = fixture(), open = vi.fn(), menu = vi.fn()
  f.sessions.set('peer', { ...session('peer'), providerId: 'claude' })
  const pointRead = vi.spyOn(f.client, 'agentSession'), fullRead = vi.spyOn(f.client, 'agentSessions')
  const catalog = { spaces: [{ spaceId: 'original-space', kind: home === 'space' ? 'folder' : 'mote', name: 'Original owner', hostId: 'host-original', directoryPath: '', projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', hostId: 'host-original', kind: 'home', directoryPath: '', branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original member', regionIds: ['original-region'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: 'peer', runId: 'run-peer', execution: { hostId: 'host-original', cwd: '' } }],
    bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }],
    locations: [{ spaceId: 'original-space', zoneId: 'original-zone', workspaceId: 'original-workspace', displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }],
    agentPresentation: emptyPresentation ? [] : [{ agentSessionId: 'peer', name: 'Original member', project: 'Original owner', state: 'done', group: 'results' }] }
  f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog })
  const node = (visible = true, nextHome = home) => <MobileAgentMenuContext.Provider value={menu}><MobileSpatialNavigation home={nextHome} client={f.client} connected visible={visible} openSession={open} /></MobileAgentMenuContext.Provider>
  const view = await mount(node())
  const expand = () => click(view.element.querySelector('.mobile-mote-choice, .mobile-space-row')!)
  const provider = () => view.element.querySelector('.mobile-agent-row .mobile-session-state small')?.textContent
  return { ...f, ...view, pointRead, fullRead, open, menu, node, expand, provider }
}

it.each(['mote', 'space'] as const)('resolves an initial %s member Provider without visiting Focus and caches it across menu visibility', async home => {
  const f = await directory(home)
  expect(f.pointRead).not.toHaveBeenCalled(); expect(f.fullRead).not.toHaveBeenCalled()
  await f.expand(); expect(f.provider()).toBe('claude')
  expect(f.pointRead).toHaveBeenCalledExactlyOnceWith('peer')
  for (let index = 0; index < 3; index++) {
    await click(button(f.element, 'Original member · 更多操作'))
    expect(f.menu.mock.lastCall?.[0].agentSessionId).toBe('peer')
    await f.render(f.node(false)); await f.render(f.node(true))
    expect(f.pointRead).toHaveBeenCalledExactlyOnceWith('peer')
  }
  expect(f.fullRead).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('updates an expanded initial Mote member from its exact SDK event even when the public presentation has no rows', async () => {
  const f = await directory('mote', true)
  await f.expand(); expect(f.provider()).toBe('claude')
  expect(f.pointRead).toHaveBeenCalledExactlyOnceWith('peer')
  const reads = vi.mocked(f.client.forwardRpc!).mock.calls.length
  await act(async () => f.emit({ type: 'agent-session', session: { ...session('other'), providerId: 'gemini' } }))
  expect(f.pointRead).toHaveBeenCalledTimes(1)
  await act(async () => f.emit({ type: 'agent-session', session: { ...session('peer'), providerId: 'gemini' } }))
  expect(f.pointRead.mock.calls).toEqual([['peer'], ['peer']]); expect(f.provider()).toBe('gemini')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls).toHaveLength(reads)
  expect(f.fullRead).not.toHaveBeenCalled()
})

it('preserves the exact SDK Provider learned in Focus when the original Mote point read is temporarily unavailable', async () => {
  const f = await directory('focus')
  expect(f.provider()).toBe('claude')
  f.pointRead.mockImplementation(() => { throw new Error('point metadata temporarily unavailable') })
  await f.render(f.node(true, 'mote')); await f.expand()
  expect(f.provider()).toBe('claude')
  await click(f.element.querySelector('.mobile-agent-row__open')!)
  expect(f.open).toHaveBeenCalledExactlyOnceWith('peer', expect.objectContaining({ name: 'Original member' }))
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['wrong-SID', 'unknown'] as const)('keeps the original spatial member navigable without adopting %s metadata', async failure => {
  const f = await directory(failure === 'wrong-SID' ? 'mote' : 'space')
  f.pointRead.mockImplementation(() => { if (failure === 'unknown') throw new Error('metadata not hydrated'); return { ...session('other'), providerId: 'gemini' } })
  await f.expand(); expect(f.provider()).toBe('元信息未确认')
  expect(f.element.textContent).not.toContain('gemini')
  await click(f.element.querySelector('.mobile-agent-row__open')!)
  expect(f.open).toHaveBeenCalledExactlyOnceWith('peer', expect.objectContaining({ name: 'Original member' }))
  expect(f.pointRead).toHaveBeenCalledExactlyOnceWith('peer'); expect(f.fullRead).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
