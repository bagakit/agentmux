import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const connected = { state: 'connected' as const, message: 'Connected to the original Host' }
const order = ['Goals', 'Topics', 'Mote', 'Focus', 'Space']
function originalClient() {
  const f = fixture()
  const catalog = {
    spaces: [{ spaceId: 'original-mote', kind: 'mote', name: 'Original Mote', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', hostId: 'host-original', directoryPath: fixturePath("workspace"), kind: 'home', branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original Agent', regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath("workspace") } }],
    bindings: [{ spaceId: 'original-mote', zoneId: 'original-zone' }], locations: [],
    agentPresentation: [{ agentSessionId: 'session-original', name: 'Original Agent', project: 'Original Project', group: 'working', state: 'working', detail: 'Working', providerId: 'codex', recap: null }]
  }
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  })
  return f
}
function nav(element: HTMLElement) { return element.querySelector<HTMLElement>('.mobile-navigation')! }
function current(element: HTMLElement) { return nav(element).querySelector('[aria-current="page"]')?.textContent }
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('actual phone primary workfaces', () => {
  it('directly opens all five original surfaces in order and keeps auxiliary work in the actual menu', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    expect([...nav(view.element).querySelectorAll('button')].map(value => value.textContent)).toEqual(order)
    for (const label of order) {
      await click(button(nav(view.element), label)); expect(current(view.element)).toBe(label)
      const surface = label === 'Goals' ? '.mobile-goals' : label === 'Topics' ? '.mobile-topics' : '.mobile-spatial-panel'
      const body = view.element.querySelector<HTMLElement>(surface)!
      expect(body.closest('[hidden]')).toBeNull(); expect(body.querySelector('h1')?.textContent).toBe(label)
    }
    expect(f.client.forwardRpc).toHaveBeenCalledWith('goal.ls', { limit: 1000 })
    expect(f.client.forwardRpc).toHaveBeenCalledWith('topic.category.ls', {})
    expect(f.client.forwardRpc).toHaveBeenCalledWith('space.ls', { target: {}, presentation: true })
    await click(button(view.element, '手机设置与连接'))
    const menu = overlay.querySelector<HTMLElement>('.mobile-drawer-workfaces')!
    expect([...menu.querySelectorAll('button')].map(value => value.textContent)).toEqual(['Survey研究与笔记'])
    expect([...overlay.querySelectorAll('select option')].map(value => value.textContent)).toEqual(order)
    await click(button(menu, 'Survey研究与笔记'))
    expect(view.element.querySelector('.mobile-survey')?.closest('[hidden]')).toBeNull()
    expect(current(view.element)).toBeUndefined()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('retains the exact composer, draft and Session while switching every primary workface and returning to the original Mote', async () => {
    const f = originalClient(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    await click(button(nav(view.element), 'Mote'))
    await click(view.element.querySelector('.mobile-spatial-panel > .mobile-session-list button')!)
    const originalEditor = editor(view.element)
    await paste(view.element, '原 Mote 的未保存草稿')
    expect(current(view.element)).toBe('Mote')
    for (const label of order) {
      await click(button(nav(view.element), label))
      expect(editor(view.element)).toBe(originalEditor)
      expect(originalEditor.textContent).toBe('原 Mote 的未保存草稿')
      expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    }
    await click(button(nav(view.element), 'Mote'))
    await click(view.element.querySelector('.mobile-spatial-panel > .mobile-session-list button')!)
    expect(editor(view.element)).toBe(originalEditor)
    expect(view.element.querySelector('.mobile-mote-heading')).not.toBeNull()
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    await view.render(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Original Host connection interrupted' }} platform={platform} />)
    expect(editor(view.element)).toBe(originalEditor)
    expect(nav(view.element).querySelectorAll('button')).toHaveLength(5)
    expect(originalEditor.textContent).toBe('原 Mote 的未保存草稿')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['goals', 'topics', 'mote', 'focus', 'space'])('opens the saved %s home without changing its original record', async home => {
    localStorage.setItem('agentmux-mobile-home', home)
    const view = await mount(<MobileApp client={originalClient().client} connection={connected} platform={createBrowserPlatform()} />)
    expect(current(view.element)?.toLowerCase()).toBe(home)
    expect(localStorage.getItem('agentmux-mobile-home')).toBe(home)
  })

  it('keeps the exact unknown input across the five workfaces without generating another dispatch', async () => {
    const f = originalClient()
    f.submit.mockRejectedValueOnce(new Error('Acknowledgement is unknown after dispatch'))
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Mote'))
    await click(view.element.querySelector('.mobile-spatial-panel > .mobile-session-list button')!)
    await paste(view.element, '不能因为切换而重发的原输入')
    await click(button(view.element, 'Send'))
    const original = f.submit.mock.calls[0]![0]
    for (const label of order) await click(button(nav(view.element), label))
    await click(button(nav(view.element), 'Mote'))
    await click(view.element.querySelector('.mobile-spatial-panel > .mobile-session-list button')!)
    expect(button(view.element, 'Send').disabled).toBe(true)
    expect(editor(view.element).textContent).toBe('不能因为切换而重发的原输入')
    expect(f.submit).toHaveBeenCalledTimes(1)
    const durable = getDeviceWorkface().snapshot().record.conversation!.attempts[0]![1]
    expect(durable.operationId).toBe(original.operationId)
    expect(durable.runId).toBe('run-original'); expect(durable.phase).toBe('unknown')
  })

  it('keeps an unreadable preference while all five healthy workfaces remain usable', async () => {
    localStorage.setItem('agentmux-mobile-home', 'unknown-original')
    const view = await mount(<MobileApp client={originalClient().client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Goals'))
    expect(current(view.element)).toBe('Goals')
    expect(localStorage.getItem('agentmux-mobile-home')).toBe('unknown-original')
  })

  it('does not let a late Survey Topic inspection replace the later chosen primary workface', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const catalog = { spaces: [{ spaceId: 'topic-space', kind: 'topic', topicId: 'original-topic', name: 'Original Topic', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
      zones: [{ zoneId: 'research-zone' }], tabs: [], regions: [], locations: [], bindings: [{ zoneId: 'research-zone', spaceId: 'topic-space' }],
      survey: { items: [{ zoneId: 'research-zone', name: 'Original Research' }], selection: { zoneId: 'research-zone', selection: [], active: null } } }
    const read = deferred<{ catalog: typeof catalog }>()
    const ordinary = f.client.forwardRpc!
    f.client.forwardRpc = vi.fn().mockImplementation((method, params) => method === 'space.inspect' ? read.promise
      : method === 'space.ls' ? Promise.resolve({ catalog }) : ordinary(method, params))
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element, '手机设置与连接')); await click(button(overlay, 'Survey研究与笔记'))
    await click(button(view.element.querySelector('.mobile-survey') as HTMLElement, 'Original Topic'))
    expect(f.client.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { spaceId: 'topic-space' } })
    await click(button(nav(view.element), 'Goals'))
    await act(async () => read.resolve({ catalog }))
    expect(current(view.element)).toBe('Goals')
    expect(view.element.querySelector('.mobile-goals')?.closest('[hidden]')).toBeNull()
    expect(f.client.forwardRpc).not.toHaveBeenCalledWith('topic.inspect', { topicId: 'original-topic' })
    expect(f.submit).not.toHaveBeenCalled()
  })
})
