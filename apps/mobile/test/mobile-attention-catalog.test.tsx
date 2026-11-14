import { act, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileAttentionCatalog } from '../src/navigation/use-mobile-attention-catalog'
import { MobilePrimaryNavigation } from '../src/navigation/MobilePrimaryNavigation'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { saveMobileHome } from '../src/navigation/home-preference'
import type { MobileAgentPresentation } from '../src/navigation/mobile-agent-status'
import { button, click, fixture, mount, mounted, waitForElement } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'

const row: MobileAgentPresentation = { agentSessionId: 'peer', name: '等待中的工作', project: '项目', detail: '', group: 'attention', state: 'waiting', stateMark: 'attention', providerId: 'codex', recap: null }
const catalog = () => ({ spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [structuredClone(row)] })
const connection = { state: 'connected' as const, message: '已连接' }
/** Invoke the original effect's timer callback; module loading and all other browser work stay real. */
function intervals() {
  let id = 0
  const active = new Map<number, { ms: number; run(): void }>()
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, ms: number) => {
    active.set(++id, { ms, run }); return id
  }) as typeof setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(handle => { active.delete(Number(handle)) })
  return { tick: async (ms: number) => act(async () => {
    for (const [key, entry] of [...active]) if (active.has(key) && entry.ms === ms) entry.run()
  }) }
}
beforeEach(async () => { window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  vi.useRealTimers()
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('the shell attention reader', () => {
  it('keeps the real Focus badge unknown until the first and replacement clients confirm their own counts', async () => {
    const first = fixture(), replacement = fixture()
    let confirmFirst!: (value: { catalog: ReturnType<typeof catalog> }) => void
    let confirmReplacement!: (value: { catalog: ReturnType<typeof catalog> }) => void
    first.client.forwardRpc = vi.fn(() => new Promise(resolve => { confirmFirst = resolve })) as typeof first.client.forwardRpc
    replacement.client.forwardRpc = vi.fn(() => new Promise(resolve => { confirmReplacement = resolve })) as typeof replacement.client.forwardRpc
    function Reader({ client }: { client: typeof first.client }) {
      const state = useMobileAttentionCatalog(client, true, false)
      return <MobilePrimaryNavigation current="focus" onSelect={() => {}} needsYou={state.items.length} needsYouUnconfirmed={state.unconfirmed} />
    }
    const view = await mount(<Reader client={first.client} />)
    const badge = () => view.element.querySelector('[data-workface="focus"] .mobile-tab-badge')
    expect(badge()?.textContent).toBe('?')
    expect(badge()?.hasAttribute('data-count')).toBe(false)
    await act(async () => confirmFirst({ catalog: catalog() }))
    expect(badge()?.textContent).toBe('1')
    await view.render(<Reader client={replacement.client} />)
    expect(badge()?.textContent).toBe('?')
    expect(badge()?.hasAttribute('data-count')).toBe(false)
    await act(async () => confirmReplacement({ catalog: { ...catalog(), agentPresentation: [] } }))
    expect(badge()).toBeNull()
    expect(first.submit).not.toHaveBeenCalled(); expect(replacement.submit).not.toHaveBeenCalled()
    expect(first.respond).not.toHaveBeenCalled(); expect(replacement.respond).not.toHaveBeenCalled()
  })

  it('does not commit another render when the typed membership is unchanged, including changed unrelated rows', async () => {
    const f = fixture(), timer = intervals(); let commits = 0, unrelated = 0
    f.client.forwardRpc = vi.fn().mockImplementation(async () => ({ catalog: { ...catalog(), agentPresentation: [row,
      { ...row, agentSessionId: 'other', group: 'working', state: 'working', stateMark: 'working', recap: { text: String(unrelated++), source: 'native-hook' } }] } }))
    function Reader() {
      const state = useMobileAttentionCatalog(f.client, true, false)
      useLayoutEffect(() => { commits++ })
      return <output>{state.items.length}</output>
    }
    const view = await mount(<Reader />)
    expect(view.element.textContent).toBe('1')
    const before = commits
    await timer.tick(15_000); await timer.tick(15_000)
    expect(f.client.forwardRpc).toHaveBeenCalledTimes(3)
    expect(commits).toBe(before)
  })

  it('retains the last membership as unconfirmed on failure and disconnect, then uses the same read-only recovery', async () => {
    const f = fixture(), timer = intervals(); let fails = false, state!: ReturnType<typeof useMobileAttentionCatalog>
    f.client.forwardRpc = vi.fn().mockImplementation(async () => { if (fails) throw Error('original attention read failed'); return { catalog: catalog() } })
    function Reader({ active = true }: { active?: boolean }) {
      state = useMobileAttentionCatalog(f.client, active, false)
      return <output data-unconfirmed={state.unconfirmed}>{state.items.map(item => item.agentSessionId).join(',')}</output>
    }
    const view = await mount(<Reader />)
    expect(state.unconfirmed).toBe(false)
    fails = true
    await timer.tick(15_000)
    expect(state.items).toEqual([{ agentSessionId: 'peer', reason: 'waiting' }])
    expect(state.unconfirmed).toBe(true); expect(state.issue).toBe('original attention read failed')
    fails = false
    await act(async () => state.refresh())
    expect(state.unconfirmed).toBe(false); expect(state.issue).toBeNull()
    await view.render(<Reader active={false} />)
    expect(state.unconfirmed).toBe(true); expect(view.element.textContent).toBe('peer')
    const reads = vi.mocked(f.client.forwardRpc!).mock.calls.length
    await timer.tick(15_000)
    expect(f.client.forwardRpc).toHaveBeenCalledTimes(reads)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
})

describe('actual MobileApp attention consumers', () => {
  it.each(['mote', 'space'] as const)('uses just the visible %s directory reader for the root catalog', async home => {
    const f = fixture(), timer = intervals()
    const read = vi.fn()
    f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
      if (method === 'space.ls') { if (JSON.stringify(params.target) === '{}') read(); return { catalog: catalog() } }
      if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
      return { goals: [], categories: [], topics: [], unavailable: [] }
    })
    saveMobileHome(home)
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, home === 'mote' ? 'Mote' : 'Space')
    await waitForElement(view.element, '.mobile-spatial-panel')
    const before = read.mock.calls.length
    await timer.tick(10_000); await timer.tick(15_000)
    expect(read).toHaveBeenCalledTimes(before + 1)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('marks the actual Focus and back badges unconfirmed and preserves the exact failure behind a retry', async () => {
    const f = fixture(), timer = intervals(); let fails = false
    f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'space.ls') { if (fails) throw Error('original attention source lost'); return { catalog: catalog() } }
      if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
      return { goals: [], categories: [], topics: [], unavailable: [] }
    })
    saveMobileHome('focus')
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, 'Focus')
    const ticket = await waitForElement<HTMLButtonElement>(view.element, '.mobile-needs-you-ticket')
    fails = true
    // The visible Focus directory owns the root catalog read here and pauses the shell reader.
    await timer.tick(10_000)
    const focus = view.element.querySelector<HTMLButtonElement>('[data-workface="focus"]')!
    expect(focus.getAttribute('aria-description')).toContain('数量尚未确认')
    expect(focus.querySelector('.mobile-tab-badge')?.textContent).toBe('?')
    expect(focus.querySelector('.mobile-tab-badge')?.hasAttribute('data-count')).toBe(false)
    // The unconfirmed list keeps its last membership, so the original ticket still opens its Session.
    await click(ticket)
    await waitForElement(view.element, '.mobile-session-origin')
    expect(view.element.querySelector('[data-workface="focus"]')).toBeNull()
    expect(view.element.querySelector('.mobile-session-origin')?.getAttribute('aria-description')).toContain('尚未确认')
    expect(view.element.querySelector('.mobile-back-badge')?.textContent).toBe('?')
    const originalEditor = view.element.querySelector('[contenteditable="true"]')
    expect(view.element.textContent).not.toContain('original attention source lost')
    await click(button(view.element, '需要你列表尚未确认，查看原因和恢复操作'))
    expect(document.querySelector('.mobile-attention-details')?.textContent).toContain('original attention source lost')
    await click(button(document.body, '关闭需要你列表信息'))
    expect(view.element.querySelector('[contenteditable="true"]')).toBe(originalEditor)
    await click(button(view.element, '需要你列表尚未确认，查看原因和恢复操作'))
    fails = false
    await click(button(document.body, '重新读取需要你列表'))
    expect(document.querySelector('.mobile-attention-details')).toBeNull()
    // The open Session is the only one waiting, so back carries no count; the root tab counts it again.
    expect(view.element.querySelector('.mobile-back-badge')).toBeNull()
    await click(button(view.element, '返回 Focus'))
    expect(view.element.querySelector('[data-workface="focus"] .mobile-tab-badge')?.textContent).toBe('1')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
})
