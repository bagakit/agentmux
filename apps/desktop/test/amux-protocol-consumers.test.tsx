// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'

let host: HTMLDivElement, root: Root
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})
const wires = ['<amux:continue />', '<amux:reaction ok />', '<amux:new-type key="original">Original body.</amux:new-type>']
async function source() {
  const fixture = await nativeHistoryFixture('claude', jsonl(wires.map((text, index) => ({ sessionId: 'native-main', uuid: 'original-' + index,
    type: 'user', message: { role: 'user', content: text } }))), { agentSessionId: 'reader' })
  cleanup.push(fixture.close); return fixture
}
async function render(value: ReactNode) { await act(async () => root.render(value)) }
async function assertCards(fixture: Awaited<ReturnType<typeof source>>) {
  await vi.waitFor(() => expect(host.querySelectorAll('.conversation-protocol')).toHaveLength(3))
  expect([...host.querySelectorAll('.conversation-protocol')].map(card => card.getAttribute('data-protocol-kind'))).toEqual(['continue', 'reaction', 'generic'])
  expect(fixture.controls.map(control => control.mock.calls.length)).toEqual(fixture.controls.map(() => 0))
  expect((await fixture.bytes()).native).toEqual(fixture.before.native)
}

it('the actual Desktop consumes protocol cards through the public Core conversation reader', async () => {
  const fixture = await source()
  const read = vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation((...args) => fixture.client.readAgentConversation(...args))
  vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation((...args) => fixture.client.readConversationChanges(...args))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation((...args) => fixture.client.observeConversation(...args))
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation((...args) => fixture.client.releaseConversationView(...args))
  await render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: 'reader' } })} />)
  await assertCards(fixture); expect(read).toHaveBeenCalled()
})

it('the actual Mobile consumes the same original records without sending input or changing native authorship', async () => {
  const fixture = await source()
  const client = new Proxy(fixture.client, { get(target, key) {
    if (key === 'runtimeOwnerIdentity') return () => null
    if (key === 'agentSession') return () => fixture.session
    if (key === 'agentSessions') return () => [fixture.session]
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } }) as unknown as AgentMuxHostedClient
  const read = vi.spyOn(fixture.client, 'readAgentConversation')
  await render(<MobileConversationSurface client={client} agentSessionId="reader" connection={{ state: 'connected', message: 'Private read-only Core' }} platform={createBrowserPlatform()} />)
  await assertCards(fixture); expect(read).toHaveBeenCalled()
  const page = await fixture.client.sessionHistoryPage('reader')
  expect(page.items.map(item => item.contentParts?.[0])).toEqual(wires.map(text => ({ kind: 'text', text, contentEligibility: 'unconfirmed' })))
})
