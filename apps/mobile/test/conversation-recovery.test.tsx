import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, editor, fixture, history, mount, mounted, paste } from './conversation-fixture'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
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

  it('keeps the original older window through a weak connection and hidden surface, while a changed source cannot replace its text', async () => {
    const f = fixture(), old = { ...history(), nextCursor: null, items: [{ id: 'old-reading', kind: 'assistant-message' as const,
      contentParts: [{ kind: 'text' as const, text: 'Original older reading stays' }] }] }
    f.readHistory.mockImplementation(async (_id, options) => options?.cursor ? old : history())
    const surface = (state: 'connected' | 'disconnected', visible = true) => <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state, message: state }} visible={visible} platform={createBrowserPlatform()} />
    const view = await mount(surface('connected'))
    await click(button(view.element, '更早消息'))
    const row = view.element.querySelector('[data-native-record-id="old-reading"]')
    expect(row).not.toBeNull()
    const olderReads = () => f.readHistory.mock.calls.filter(([, options]) => options?.cursor === 'older-opaque').length
    const before = olderReads()
    await paste(view.element, 'Original unsent draft')
    await view.render(surface('disconnected')); await paste(view.element, ' with offline edits')
    await view.render(surface('connected', false)); await view.render(surface('connected'))
    expect(view.element.querySelector('[data-native-record-id="old-reading"]')).toBe(row)
    expect(olderReads()).toBeGreaterThan(before)
    const foreign = { ...old, source: { ...old.source, nativeSessionId: 'foreign-source' }, items: [{ ...old.items[0]!, id: 'foreign-reading',
      contentParts: [{ kind: 'text' as const, text: 'A different native source' }] }] }
    f.readHistory.mockResolvedValue(foreign)
    const current = { ...f.sessions.get('session-original')!, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'foreign-source' } }
    f.sessions.set('session-original', current)
    await act(async () => f.emit({ type: 'agent-session', session: current }))
    expect(view.element.textContent).toContain('original reading and drafts are retained')
    expect(view.element.querySelector('[data-native-record-id="old-reading"]')).toBe(row)
    expect(view.element.querySelector('[data-native-record-id="foreign-reading"]')).toBeNull()
    expect(editor(view.element).textContent).toContain('with offline edits')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('retains an old phase-only interaction intent as unknown without rebuilding it from the current pending request', async () => {
    const f = fixture(), local = createLocalDrafts(), value = f.sessions.get('session-original')!
    const key = JSON.stringify(['session-original', 'run-original', 'phase-only-request'])
    local.responses.set(key, { phase: 'sending', message: 'Interrupted original answer' }); await local.save()
    f.sessions.set(value.agentSessionId, { ...value, pendingInteraction: { request: { kind: 'permission', id: 'phase-only-request',
      agentSessionId: value.agentSessionId, title: 'Current request is not the lost original operation',
      evidence: { source: 'native-hook', observedAt: _historyTailFixtureEpoch(0, 0, 1), run: value.run }, options: [{ id: 'allow', kind: 'allow-once', label: 'Allow' }] } } })
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={value.agentSessionId} connection={connected} platform={createBrowserPlatform()} />)
    expect(view.element.textContent).toContain('重启后的原请求答复回执未知')
    expect(view.element.querySelector('[data-original-response]')).toBeNull()
    expect(createLocalDrafts().responses.get(key)).toMatchObject({ phase: 'unknown' })
    expect(createLocalDrafts().responses.get(key)?.original).toBeUndefined()
    await paste(view.element, 'Healthy ordinary composer remains editable')
    expect(editor(view.element).textContent).toContain('Healthy ordinary composer')
    expect(f.respond).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  })

})
// @vitest-environment happy-dom
import './device-locks'
