import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
import { MobileApp } from '../src/MobileApp'
import { mobileChatStart } from '../src/navigation/chat-start'
import { parsePresentationRoute } from '../src/recovery/presentation-route'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted, paste } from './conversation-fixture'

const connected = { state: 'connected' as const, message: 'Connected' }
export function chatCatalog(): AgentMuxSpaceCatalog {
  return {
    spaces: ['recent', 'primary'].map(id => ({ spaceId: id, kind: 'mote', name: id === 'primary' ? '搭档' : '研究',
      topicId: id === 'primary' ? PMO_TEAMS_TOPIC_ID : 'custom-topic', hostId: 'host-original', directoryPath: null, projectId: null })),
    zones: [], tabs: [], regions: [], bindings: [], locations: [],
    motePresentation: ['recent', 'primary'].map(id => ({ spaceId: id, content: null,
      quickMode: { status: 'saved', version: 'original-version', defaults: { conversation: { hostId: 'host-original',
        sessionId: id === 'primary' ? 'session-original' : 'other', displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } } }, conversation: null }))
  }
}
function original(catalog = chatCatalog()) {
  const f = fixture()
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'space.ls' || method === 'space.inspect' ? { catalog }
    : method === 'goal.ls' ? { goals: [], unavailable: [] } : { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] })
  f.client.ensureAgentContinuity = vi.fn()
  return f
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
describe('phone chat-first navigation through the actual App', () => {
  it('opens the saved original conversation even when its metadata is unavailable, preserving its prior workface', async () => {
    await getDeviceWorkface().updatePresentation({ selectedSessionId: 'unobserved-original', hostUrl: '', panel: 'terminal' },
      { primary: 'topics', showSession: false, showGoalWork: false, identity: { name: '原对话', project: '原项目' }, profile: null,
        topics: { context: { categoryId: 'original-category', topicId: null, mode: 'discussion' }, sources: [] } })
    const f = original()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('unobserved-original')
    expect(getDeviceWorkface().snapshot().record.presentation?.topics?.context.categoryId).toBe('original-category')
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('opens the last explicitly selected Mote main conversation ahead of the primary Mote, without lifecycle effects', async () => {
    await getDeviceWorkface().updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' },
      { primary: 'focus', showSession: false, showGoalWork: false, identity: null, profile: null, recentMoteSpaceId: 'recent' })
    const f = original()
    await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('other'))
    expect(getDeviceWorkface().snapshot().record.presentation?.identity?.mote?.spaceId).toBe('recent')
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  })
  it('uses the unique primary Mote saved reference on first entry, and retains draft and selected identity across remount', async () => {
    const f = original(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original'))
    await paste(view.element, '保留这个草稿')
    const previous = mounted.splice(mounted.findIndex(value => value.element === view.element), 1)[0]!
    await act(async () => previous.root.unmount()); previous.element.remove()
    const restored = await mount(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Offline' }} platform={platform} />)
    expect(restored.element.querySelector('.tiptap')?.textContent).toBe('保留这个草稿')
    expect(restored.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(getDeviceWorkface().snapshot().record.presentation?.identity?.mote?.spaceId).toBe('primary')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  })
  it('does not let delayed default discovery replace an explicit user navigation', async () => {
    const f = original(), pending = deferred<{ catalog: AgentMuxSpaceCatalog }>()
    f.client.forwardRpc = vi.fn().mockImplementation((method: string) => method === 'space.ls' ? pending.promise : Promise.resolve({ agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }))
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
    await act(async () => { pending.resolve({ catalog: chatCatalog() }) })
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('keeps unknown original Mote configuration instead of silently choosing a different Agent', () => {
    const catalog = chatCatalog()
    catalog.motePresentation![0]!.quickMode = { status: 'unconfirmed', message: 'Original config unavailable' }
    expect(mobileChatStart(catalog, 'recent')).toMatchObject({ sessionId: null, identity: { mote: { spaceId: 'recent' } }, issue: 'Original config unavailable' })
    expect(mobileChatStart(catalog, 'missing-original')).toMatchObject({ sessionId: null })
    catalog.spaces.push({ ...catalog.spaces[1]!, spaceId: 'another-primary', hostId: 'other-host' })
    expect(mobileChatStart(catalog, null)).toMatchObject({ sessionId: null })
  })
  it('preserves long original spatial identities with the public spatial reference bounds', () => {
    const spaceId = 'original-mote:' + 'nested-segment/'.repeat(40)
    const route = { primary: 'mote', showSession: true, showGoalWork: false, recentMoteSpaceId: spaceId,
      identity: { name: '原 Mote', project: '原项目', mote: { spaceId } }, profile: null }
    expect(parsePresentationRoute(route)).toEqual(route)
    expect(() => parsePresentationRoute({ ...route, recentMoteSpaceId: 'self' })).toThrow()
    expect(() => parsePresentationRoute({ ...route, recentMoteSpaceId: '原'.repeat(6000) })).toThrow()
  })
  it('opens a saved Session without borrowing a replacement Agent occurrence', () => {
    const catalog = chatCatalog(), fact = catalog.motePresentation![1]!
    if (fact.quickMode.status !== 'saved') throw Error('Original saved fixture required')
    fact.conversation = fact.quickMode.defaults.conversation!
    const main = fact.conversation
    catalog.locations.push({ ...main, spaceId: 'primary', zoneId: 'original-zone', workspaceId: 'original-workspace' })
    catalog.regions.push({ regionId: main.regionId, tabId: main.tabId, kind: 'agent', agentSessionId: 'replacement', runId: 'replacement-run', execution: { hostId: main.hostId, cwd: null } })
    expect(mobileChatStart(catalog, null)).toMatchObject({ sessionId: 'session-original' })
    expect(mobileChatStart(catalog, null).identity?.context).toBeUndefined()
    catalog.regions[0]!.agentSessionId = main.sessionId
    expect(mobileChatStart(catalog, null).identity?.context?.regionId).toBe(main.regionId)
  })
  it('only falls through an explicitly unconfigured recent Mote and never guesses primary from its icon or name', () => {
    const catalog = chatCatalog()
    catalog.motePresentation![0]!.quickMode = { status: 'missing' }
    expect(mobileChatStart(catalog, 'recent').sessionId).toBe('session-original')
    catalog.spaces[1]!.topicId = 'different-original-topic'
    catalog.appearance = [{ spaceId: 'primary', preset: 'primary-mote' }]
    expect(mobileChatStart(catalog, null).sessionId).toBeNull()
  })
  it('shows Motes as direct horizontal choices with a sibling Profile action and remembers only explicit selection', async () => {
    const f = original()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Mote'))
    await vi.waitFor(() => expect(view.element.querySelectorAll('.mobile-mote-choice')).toHaveLength(2))
    await click(view.element.querySelector('[aria-label="选择 Mote · 研究"]')!)
    expect(view.element.querySelector('.mobile-mote-selected')?.getAttribute('data-space-id')).toBe('recent')
    const profile = view.element.querySelector('[aria-label="查看 Mote 资料 · 研究"]')!
    expect(profile.closest('header')).not.toBeNull(); expect(profile.closest('.mobile-space-children')).toBeNull()
    expect(getDeviceWorkface().snapshot().record.presentation?.recentMoteSpaceId).toBe('recent')
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  })
})
