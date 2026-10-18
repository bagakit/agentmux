// @vitest-environment happy-dom
import '../../../apps/mobile/test/device-locks'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { ConversationView } from '../src/components/ConversationView'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { projectConversationReading } from '../src/lib/conversation-records'
import type { ConversationPresentationController } from '../src/lib/use-conversation-record-layout'
import { ActivityView } from '../../../apps/desktop/src/renderer/src/components/ActivityView'
import { createClientUiRoot } from '../../../apps/desktop/test/helpers/client-ui-render'
import { activityReadingProps } from '../../../apps/desktop/test/helpers/activity-reading-props'
import { api } from '../../../apps/desktop/src/renderer/src/lib/api'
import { MobileConversationSurface } from '../../../apps/mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../../apps/mobile/src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../../../apps/mobile/src/recovery/device-workface'
import { fixture, session } from '../../../apps/mobile/test/conversation-fixture'
import { installConversationReading } from '../../../apps/mobile/test/conversation-reading-fixture'

const source = { providerId: 'codex', nativeSessionId: 'native-session-original' }
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const item = (id: string) => ({ id, kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: id }] })
const page = (...items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage => ({ agentSessionId: 'session-original', sourceHostId: 'local', source, nextCursor: null, items })
function frame(page: AgentSessionHistoryPage) {
  const reading = projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: page })
  return { page, records: reading.records, originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }
}
const closes: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mounted(desktop = false) {
  const host = document.createElement('div'); document.body.append(host)
  const root: Root = desktop ? createClientUiRoot(host) : createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, root }
}
function readingGeometry(viewport: HTMLElement, visible: HTMLElement) {
  viewport.setAttribute('data-workbench-reading-scroll', '')
  Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  viewport.scrollTop = 600
  const viewportRect = vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 300))
  const visibleRect = vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 30, 600, 120))
  return { viewportRect, visibleRect }
}
async function shared() {
  const view = mounted(), controller = { current: null as ConversationPresentationController | null }, pinToBottom = vi.fn()
  let following = true
  const geometry = { viewport: () => view.host, following: () => following, pinToBottom }
  const draw = (value: ReturnType<typeof frame>, intent = 0) => act(async () => view.root.render(
    <ClientUiProvider platform={platform}><ConversationView {...value} sessionId="session-original" executionHostId="local"
      readingGeometry={geometry} presentation={{ controller, pending: false, intent, onRelease() {} }} /></ClientUiProvider>))
  await draw(frame(page(item('visible-head'), item('retained-tail'))))
  const visible = view.host.querySelector<HTMLElement>('[data-native-record-id="visible-head"]')!
  const measured = readingGeometry(view.host, visible)
  return { ...view, ...measured, controller, pinToBottom, visible, draw, follow: (value: boolean) => { following = value } }
}

it('following admits and presents a replacement that removes the visible anchor without measuring or capturing it', async () => {
  const x = await shared(), next = frame(page(item('retained-tail'), item('new-original')))
  expect(x.controller.current!.canPresent(next)).toBe(true)
  await x.draw(next)
  expect(x.visible.isConnected, 'Following must not retain a stale render frame after admission').toBe(false)
  expect(x.host.querySelector('[data-native-record-id="new-original"]')).not.toBeNull()
  expect(x.viewportRect).not.toHaveBeenCalled(); expect(x.visibleRect).not.toHaveBeenCalled()
})

it('admission reads the current host following fact rather than an earlier rendered copy', async () => {
  const x = await shared(), next = frame(page(item('retained-tail')))
  x.follow(false)
  expect(x.controller.current!.canPresent(next)).toBe(false)
  x.follow(true)
  expect(x.controller.current!.canPresent(next, { preserveAnchor: true })).toBe(true)
})

it('historical reading still holds an evicted visible anchor until explicit navigation changes intent', async () => {
  const x = await shared(), next = frame(page(item('retained-tail'), item('new-original')))
  x.follow(false)
  expect(x.controller.current!.canPresent(next)).toBe(false)
  await x.draw(next)
  expect(x.visible.isConnected).toBe(true)
  expect(x.host.scrollTop).toBe(600); expect(x.pinToBottom).not.toHaveBeenCalled()
  expect(x.host.querySelector('[data-native-record-id="new-original"]')).toBeNull()
  expect(x.controller.current!.canPresent(next, { preserveAnchor: false })).toBe(true)
  await x.draw(next, 1)
  expect(x.visible.isConnected).toBe(false)
  expect(x.host.querySelector('[data-native-record-id="new-original"]')).not.toBeNull()
})

it.each(['selection', 'focus'])('following still protects an affected original %s when its record is removed', async protection => {
  const x = await shared(), next = frame(page(item('retained-tail')))
  if (protection === 'selection') {
    const text = x.visible.querySelector('p')!.firstChild!, range = document.createRange()
    range.selectNodeContents(text); getSelection()!.addRange(range)
  } else {
    const button = x.visible.querySelector<HTMLButtonElement>('button')!
    button.focus(); expect(document.activeElement).toBe(button)
  }
  expect(x.controller.current!.canPresent(next, { preserveAnchor: false })).toBe(false)
  await x.draw(next)
  expect(x.visible.isConnected).toBe(true)
  if (protection === 'selection') expect(getSelection()!.toString()).toBe('visible-head')
  else expect(x.visible.contains(document.activeElement)).toBe(true)
})

/** Native pages and invalidations are controlled public SDK ports. Both production
 * hosts, their original Reader hooks and the common presentation transaction run.
 * This does not claim a naturally occurring 1200-record eviction or native GUI proof. */
it.each(['Desktop', 'Mobile'])('%s follows an original accepted replacement through its real Reader and common presentation', async kind => {
  const f = fixture()
  f.sessions.set('session-original', { ...session(), hostId: 'local' })
  f.setPage(page(item('visible-head'), item('retained-tail')))
  installConversationReading(f)
  let notify: Parameters<typeof f.client.observeConversation>[1] | undefined
  const observe = f.client.observeConversation.bind(f.client)
  vi.spyOn(f.client, 'observeConversation').mockImplementation(async (...args) => { notify = args[1]; return observe(...args) })
  const changes = vi.spyOn(f.client, 'readConversationChanges')
  if (kind === 'Desktop') {
    vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation(f.client.readAgentConversation)
    vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation(f.client.readConversationChanges)
    vi.spyOn(api.conversation, 'observeConversation').mockImplementation(f.client.observeConversation)
    vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation(f.client.releaseConversationView)
  }
  const x = mounted(kind === 'Desktop')
  const content = kind === 'Desktop'
    ? <ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: 'session-original', run: { runId: 'run-original' } } })} />
    : <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />
  await act(async () => x.root.render(content))
  const settle = (assertion: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); assertion()
  }, { timeout: 3000, interval: 10 })
  await settle(() => { expect(x.host.querySelector('[data-native-record-id="visible-head"]')).not.toBeNull(); expect(changes).toHaveBeenCalled(); expect(notify).toBeTypeOf('function') })
  const viewport = x.host.querySelector<HTMLElement>(kind === 'Desktop' ? '.activity-feed' : '.mobile-conversation__reading')!
  const visible = x.host.querySelector<HTMLElement>('[data-native-record-id="visible-head"]')!
  readingGeometry(viewport, visible)
  f.setPage(page(item('retained-tail'), item('new-original')))
  await act(async () => { notify!({ hostId: 'local', agentSessionId: 'session-original', sourceHostId: 'local', kind: 'invalidated', source: { kind: 'native', ...source } }) })
  await settle(() => {
    expect(x.host.querySelector('[data-native-record-id="new-original"]'), 'The original host must render the accepted current frame').not.toBeNull()
    expect(visible.isConnected).toBe(false)
  })
  expect(changes.mock.calls.every(([input]) => input.hostId === 'local' && input.agentSessionId === 'session-original')).toBe(true)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
