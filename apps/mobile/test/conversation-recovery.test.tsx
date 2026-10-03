import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { deferred, fixture, history, mount, mounted } from './conversation-fixture'
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; vi.useRealTimers() })
const connected = { state: 'connected' as const, message: 'Connected' }
describe('original conversation observation recovery', () => {
  it('recovers the first failed native read and renders Hook replies in original order without resending', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.readHistory.mockRejectedValueOnce(new Error('source not confirmed yet'))
    f.setTimeline({ agentSessionId: 'session-original', revision: 2, items: [
      { id: 'user', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Input', content: '大白话说的话？', authorHuman: true },
      { id: 'answer', agentSessionId: 'session-original', kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: 2, updatedAt: 2, title: 'Reply', content: 'Agent 自己一直能正常干活。' },
      { id: 'next', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: 3, updatedAt: 3, title: 'Input', content: '继续', authorHuman: true }
    ] })
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={createBrowserPlatform()} />)
    expect(view.element.textContent).toContain('Agent 自己一直能正常干活。')
    const text = view.element.querySelector('.mobile-conversation__captured')!.textContent!
    expect(text.indexOf('大白话')).toBeLessThan(text.indexOf('Agent 自己'))
    expect(text.indexOf('Agent 自己')).toBeLessThan(text.indexOf('继续'))
    expect(f.client.observeSessionHistory).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.client.observeSessionHistory).toHaveBeenCalledOnce()
    expect(view.element.querySelector('[data-native-record-id="native-answer"]')).not.toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('disposes late watches after the original locator changes', async () => {
    const f = fixture(), late = deferred<any>(), dispose = vi.fn()
    vi.mocked(f.client.observeSessionHistory).mockReturnValueOnce(late.promise)
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={createBrowserPlatform()} />)
    await act(async () => { f.emit({ type: 'agent-session', session: { ...f.client.agentSession('session-original'), run: { runId: 'next-run' } } }) })
    await act(async () => { late.resolve({ source: history().source, dispose }) })
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.client.observeSessionHistory).toHaveBeenCalledTimes(2)
    expect(f.submit).not.toHaveBeenCalled()
    expect(view.element.querySelector('[contenteditable="true"]')).not.toBeNull()
  })
  it('rejects a history read from a previous locator before admitting its watch', async () => {
    const f = fixture(), old = deferred<ReturnType<typeof history>>(), freshRead = deferred<ReturnType<typeof history>>()
    f.readHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(freshRead.promise)
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={createBrowserPlatform()} />)
    const next = { ...f.client.agentSession('session-original'), run: { runId: 'next-run' } }
    f.sessions.set('session-original', next)
    const fresh = { ...history(), source: { providerId: 'codex', nativeSessionId: 'fresh-source' }, items: [{ id: 'fresh', kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: '新来源回复' }] }] }
    f.setPage(fresh)
    await act(async () => { f.emit({ type: 'agent-session', session: next }); old.resolve(history()) })
    expect(f.client.observeSessionHistory).not.toHaveBeenCalled()
    expect(view.element.querySelector('[data-native-record-id="native-answer"]')).toBeNull()
    await act(async () => { freshRead.resolve(fresh) })
    expect(view.element.textContent).toContain('新来源回复')
    expect(view.element.querySelector('[data-native-record-id="native-answer"]')).toBeNull()
    expect(f.client.observeSessionHistory).toHaveBeenCalledOnce()
    expect(f.submit).not.toHaveBeenCalled()
  })

})
