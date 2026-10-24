import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { documentDraft } from '@agentmux/client-ui/components/InlineComposer'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { click, evidence, fixture, mount, mounted, session } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '原 Host' }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const realEditor = (element: HTMLElement) => (element.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
async function change(editor: Editor, value: string) { await act(async () => { editor.commands.setContent(value); editor.commands.focus('end') }) }
function instrument(f: ReturnType<typeof fixture>) {
  const source = f.client.onEvent.bind(f.client), subscriptions = new Set<Parameters<typeof f.client.onEvent>[0]>(), callbacks: Array<Parameters<typeof f.client.onEvent>[0]> = []
  f.client.onEvent = listener => { subscriptions.add(listener); callbacks.push(listener); const stop = source(listener); return () => { subscriptions.delete(listener); stop() } }
  const full = vi.spyOn(f.client, 'agentSessions')
  return { subscriptions, callbacks, full }
}
const platform = createBrowserPlatform()
const surface = (f: ReturnType<typeof fixture>, visible = true) => <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} visible={visible} />

it('reads peer references only while the actual editor requests them; keeps original identity through updates, closing and visibility', async () => {
  const f = fixture(), trace = instrument(f), view = await mount(surface(f)), input = realEditor(view.element)
  trace.full.mockClear()
  await act(async () => { f.emit({ type: 'agent-session', session: { ...session(), updatedAt: 4 } }); f.emit({ type: 'agent-session', session: { ...session('peer'), updatedAt: 4 } }) })
  expect(trace.full).not.toHaveBeenCalled()
  const resting = trace.subscriptions.size
  await change(input, '@')
  await vi.waitFor(() => expect(options().length).toBeGreaterThan(0))
  expect(trace.full).toHaveBeenCalledTimes(1); expect(trace.subscriptions.size).toBe(resting + 1)
  expect(options().some(value => value.textContent?.includes('peer'))).toBe(true)
  const newPeer = { ...session('fresh-peer'), providerId: 'gemini', hostId: 'host-fresh' }
  await act(async () => f.emit({ type: 'agent-session', session: newPeer }))
  expect(options().some(value => value.textContent?.includes('gemini'))).toBe(true)
  await act(async () => f.emit({ type: 'agent-session', session: { ...newPeer, providerId: 'claude', hostId: 'host-changed' } }))
  expect(options().some(value => value.textContent?.includes('claude') && value.textContent?.includes('host-changed'))).toBe(true)
  expect(options().some(value => value.textContent?.includes('gemini'))).toBe(false)
  expect(trace.full).toHaveBeenCalledTimes(1)
  await act(async () => f.emit({ type: 'run-removed', run: { runId: 'run-fresh-peer' }, evidence }))
  await act(async () => f.emit({ type: 'run-removed', agentSessionId: 'fresh-peer', run: { runId: 'older-run' }, evidence }))
  expect(options().some(value => value.textContent?.includes('claude'))).toBe(true)
  await act(async () => { f.sessions.delete('fresh-peer'); f.emit({ type: 'run-removed', agentSessionId: 'fresh-peer', run: { runId: 'run-fresh-peer' }, evidence }) })
  expect(options().some(value => value.textContent?.includes('claude'))).toBe(false)
  await act(async () => f.emit({ type: 'agent-session', session: { ...newPeer, providerId: 'claude', hostId: 'host-changed' } }))
  await change(input, '普通草稿')
  expect(options()).toHaveLength(0); expect(trace.subscriptions.size).toBe(resting)
  await change(input, '@')
  await vi.waitFor(() => expect(options().some(value => value.textContent?.includes('claude'))).toBe(true))
  expect(trace.full).toHaveBeenCalledTimes(2)
  await view.render(surface(f, false)); expect(options()).toHaveLength(0); expect(trace.subscriptions.size).toBe(0)
  await view.render(surface(f)); await vi.waitFor(() => expect(options().some(value => value.textContent?.includes('claude'))).toBe(true))
  const selected = options().find(value => value.textContent?.includes('claude'))!
  await click(selected)
  expect(view.element.querySelector('[aria-label="Agent reference: amux://agent/fresh-peer"]')).not.toBeNull()
  expect(expandSemanticReferences(documentDraft(input.getJSON()))).toContain('amux://agent/fresh-peer')
  expect(f.submit).not.toHaveBeenCalled()
})

it('cleans the original reference subscription and ignores late original events after switching clients', async () => {
  const first = fixture(), second = fixture(), a = instrument(first), b = instrument(second)
  first.sessions.set('first-only', { ...session('first-only'), providerId: 'first-provider' })
  second.sessions.set('second-only', { ...session('second-only'), providerId: 'second-provider' })
  const view = await mount(surface(first)), input = realEditor(view.element)
  await change(input, '@'); await vi.waitFor(() => expect(options().some(value => value.textContent?.includes('first-provider'))).toBe(true))
  const oldCallbacks = [...a.subscriptions]
  await view.render(surface(second)); await vi.waitFor(() => expect(options().some(value => value.textContent?.includes('second-provider'))).toBe(true))
  expect(a.subscriptions.size).toBe(0)
  await act(async () => oldCallbacks.forEach(listener => listener({ type: 'agent-session', session: { ...session('late-old'), providerId: 'old-late' } })))
  expect(options().some(value => value.textContent?.includes('old-late') || value.textContent?.includes('first-provider'))).toBe(false)
  expect(options().some(value => value.textContent?.includes('second-provider'))).toBe(true)
  expect(b.full).toHaveBeenCalledTimes(1)
})
