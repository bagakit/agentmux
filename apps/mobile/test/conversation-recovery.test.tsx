import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, editor, fixture, history, mount, mounted, paste } from './conversation-fixture'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'
import type { AgentSessionHistoryResourceReadResult } from '@agentmux/core'
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

  it('keeps native resource demand visible and rejects a late original image after changing Session without replacing either draft', async () => {
    const f = fixture(), hidden = deferred<AgentSessionHistoryResourceReadResult>(), pending = deferred<AgentSessionHistoryResourceReadResult>()
    const original = history(), reference = 'original-native-image'
    f.setPage({ ...original, items: [{ id: 'original-image', kind: 'assistant-message',
      contentParts: [{ kind: 'resource', resourceType: 'image', reference }] }] })
    const read = vi.fn(() => pending.promise).mockReturnValueOnce(hidden.promise)
    Object.assign(f.client, { sessionHistoryResource: read })
    const surface = (id: string, visible: boolean) => <MobileConversationSurface client={f.client} agentSessionId={id}
      connection={connected} visible={visible} platform={createBrowserPlatform()} />
    const view = await mount(surface('session-original', false))
    expect(read).not.toHaveBeenCalled()
    await view.render(surface('session-original', true))
    await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith('session-original', {
      source: original.source, recordId: 'original-image', partIndex: 0, expectedReference: reference }))
    await paste(view.element, 'Original draft remains')
    await view.render(surface('session-original', false))
    const result = { agentSessionId: 'session-original', source: original.source, recordId: 'original-image', partIndex: 0, reference,
      result: { status: 'read' as const, mimeType: 'image/png' as const, dataBase64: 'eA==', byteLength: 1 } }
    await act(async () => hidden.resolve(result))
    expect(view.element.querySelector('.conversation-native-thread img')).toBeNull()
    await view.render(surface('session-original', true))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    f.setPage(history('other'))
    await view.render(surface('other', true))
    await vi.waitFor(() => expect(view.element.querySelector('[data-native-record-id="native-answer"]')).not.toBeNull())
    await paste(view.element, 'New Session draft')
    await act(async () => pending.resolve(result))
    expect(view.element.querySelector('.conversation-native-thread img')).toBeNull()
    expect(editor(view.element).textContent).toContain('New Session draft')
    expect(read).toHaveBeenCalledTimes(2)
    await view.render(surface('session-original', true))
    expect(editor(view.element).textContent).toContain('Original draft remains')
    expect(f.respond).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  })

})
// @vitest-environment happy-dom
import './device-locks'


it('retains an image page at its original Host when another client reuses the Session and native record IDs', async () => {
  const a = fixture(), b = fixture(), pending = deferred<ReturnType<typeof history>>()
  const page = { ...history(), items: [{ id: 'same-record', kind: 'assistant-message' as const,
    contentParts: [{ kind: 'resource' as const, resourceType: 'image' as const, reference: 'same-native-reference' }] }] }
  a.setPage(page); b.readHistory.mockReturnValueOnce(pending.promise)
  b.sessions.set('session-original', { ...b.sessions.get('session-original')!, hostId: 'host-other', workspacePath: 'other-workspace' })
  const result = { agentSessionId: 'session-original', source: page.source, recordId: 'same-record', partIndex: 0, reference: 'same-native-reference',
    result: { status: 'read' as const, mimeType: 'image/png' as const, dataBase64: 'eA==', byteLength: 1 } }
  const readA = vi.fn(async () => result), readB = vi.fn(async () => result)
  Object.assign(a.client, { sessionHistoryResource: readA }); Object.assign(b.client, { sessionHistoryResource: readB })
  const surface = (client: typeof a.client) => <MobileConversationSurface client={client} agentSessionId="session-original" connection={connected} platform={createBrowserPlatform()} />
  const view = await mount(surface(a.client))
  await vi.waitFor(() => expect(view.element.querySelector('.conversation-native-thread img')).not.toBeNull())
  expect(readA).toHaveBeenCalledOnce()
  await view.render(surface(b.client))
  await vi.waitFor(() => expect(b.readHistory).toHaveBeenCalled())
  expect(readB).not.toHaveBeenCalled()
  const retained = view.element.querySelector('[data-native-record-id="same-record"] [data-message-id]')!
  expect(retained.getAttribute('data-message-id')).toContain('host-original')
  await paste(view.element, 'The new draft remains editable')
  await act(async () => pending.resolve(page))
  await vi.waitFor(() => expect(readB).toHaveBeenCalledOnce())
  expect(view.element.querySelector('[data-native-record-id="same-record"] [data-message-id]')!.getAttribute('data-message-id')).toContain('host-other')
  expect(editor(view.element).textContent).toContain('The new draft remains editable')
  expect(a.submit).not.toHaveBeenCalled(); expect(b.submit).not.toHaveBeenCalled()
})
