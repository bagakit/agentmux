import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { actualRelayOwner, held } from '../../../packages/core/test/helpers/relay-carrier-owner'
import { connectRelayHostedClient } from '../../../packages/core/src/relay-hosted'
import { getDeviceWorkface, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { createLocalDrafts } from '../src/conversation/local-drafts'

const ports = vi.hoisted(() => ({ pair: null as { publicKey: Uint8Array; secretKey: Uint8Array } | null,
  roots: [] as Root[], clients: [] as AgentMuxHostedClient[] }))
// Record the original SDK returned to the product; every call still executes
// the actual Relay adapter, encrypted handshake and Hosted constructor.
vi.mock('@agentmux/core/relay-hosted', async original => {
  const module = await original<typeof import('@agentmux/core/relay-hosted')>()
  return { ...module, connectRelayHostedClient: async (...args: Parameters<typeof module.connectRelayHostedClient>) => {
    const client = await module.connectRelayHostedClient(...args); ports.clients.push(client); return client
  } }
})
// Only device-key storage is a controlled leaf. Root, SDK, encrypted Relay,
// authenticated Host, durable Core and the conversation reader stay original.
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => {
  if (!ports.pair) throw Error('Original private device key is missing')
  return ports.pair
}, existingDeviceRelayIdentity: async () => ports.pair }))
vi.mock('react-dom/client', async original => {
  const module = await original<typeof import('react-dom/client')>()
  return { ...module, createRoot: (...args: Parameters<typeof module.createRoot>) => {
    const root = module.createRoot(...args); ports.roots.push(root); return root
  } }
})

const browser = new Window({ url: 'http://127.0.0.1/' })
browser.document.head.innerHTML = '<meta name="agentmux-mobile-build" content="exact-first-read-product">'
// The existing Node socket implementation keeps its event classes separate
// from this DOM realm while retaining actual TCP, WS and encrypted frames.
const NodeWebSocket = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('ws').WebSocket
const names = ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node', 'Text',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']
function installDom() {
  for (const name of names) vi.stubGlobal(name, name === 'window' ? browser : Reflect.get(browser, name))
  vi.stubGlobal('WebSocket', NodeWebSocket)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
}
installDom()
afterAll(() => { browser.close(); vi.unstubAllGlobals() })
beforeEach(async () => {
  installDom(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/')
  document.body.innerHTML = '<div id="root"></div><div id="mobile-overlays"></div>'
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  installDom()
  await act(async () => { for (const root of ports.roots.splice(0)) root.unmount() })
  browser.document.body.replaceChildren(); ports.pair = null; ports.clients.length = 0
})

async function wait(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000, interval: 20 })
}

it('actual main reads its original conversation and editable draft before the complete Host directory', async () => {
  const f = await actualRelayOwner(), entered = held(), release = held()
  f.cleanup(async () => { await act(async () => { for (const root of ports.roots.splice(0)) root.unmount() }) })
  f.cleanup(() => release.resolve())
  ports.pair = f.options.keyPair
  const original = f.host.client.readAgentSessions.bind(f.host.client)
  let recovered = false
  vi.spyOn(f.host.client, 'readAgentSessions').mockImplementation(async () => {
    if (recovered) return await original()
    entered.resolve(); await release.promise
    throw Error('Private complete directory temporarily unavailable')
  })
  const record = { id: 'exact-original-answer', agentSessionId: 'caller', kind: 'assistant_message' as const,
    source: 'native-hook' as const, status: 'complete' as const, title: 'Original answer',
    content: 'The original answer is readable before unrelated directory preparation.', createdAt: 1, updatedAt: 1 }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'caller', item: record })
  const owner = getDeviceWorkface(), key = JSON.stringify(['draft', 'caller'])
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host: { origin: location.origin, hostId: f.options.offer.serverId }, selectedSessionId: 'caller',
    conversation: { version: 1, drafts: [[key, 'Original unsent draft']], attempts: [], responses: [] } })
  const drafts = createLocalDrafts()
  drafts.attempts.set(key, { operationId: 'original-unknown-input', runId: 'run-caller', draft: 'Original unknown input', phase: 'unknown',
    message: 'Original unconfirmed outcome', inputRequested: true })
  await drafts.save()
  const recordId = owner.recordIdentity()
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(f.options.offer))
  try {
    await act(async () => { await import('../src/main') })
    await entered.promise
    await wait(() => expect(document.querySelector('[contenteditable="true"]')?.textContent,
      'The actual original editor must be available while the whole directory is still held').toBe('Original unsent draft'))
    await wait(() => expect(f.requests.some(request => request.frame.method === 'runtime.invoke' &&
      Reflect.get(request.frame.params?.invocation ?? {}, 'method') === 'readAgentSession')).toBe(true))
    await wait(() => expect(document.querySelector('[data-captured-reply-observation="exact-original-answer"]')).not.toBeNull())
    const captured = document.querySelector<HTMLButtonElement>('[data-captured-reply-observation="exact-original-answer"] .conversation-reply-observation__toggle')
    if (captured?.getAttribute('aria-expanded') === 'false') await act(async () => captured.click())
    await wait(() => expect(document.querySelector('[data-captured-reply-observation="exact-original-answer"] .conversation-reply-observation__body')?.textContent).toContain(record.content))
    const editor = document.querySelector('[contenteditable="true"]'), client = ports.clients[0]!
    expect(client.sessionObservation()).toEqual({ state: 'unconfirmed', hasSnapshot: false })
    const keyPair = ports.pair
    // A pending local attempt must retain its original unknown outcome through
    // a directory failure. It is never replayed merely to improve observation.
    const before = owner.snapshot()
    release.resolve()
    await wait(() => expect(client.sessionObservation().state).toBe('unavailable'))
    await wait(() => expect(document.querySelector('.mobile-app')?.getAttribute('data-connection')).toBe('connected'))
    expect(document.querySelector('[contenteditable="true"]')).toBe(editor)
    expect(editor?.textContent).toBe('Original unsent draft')
    expect(document.querySelector('[data-captured-reply-observation="exact-original-answer"] .conversation-reply-observation__body')?.textContent).toContain(record.content)
    expect(owner.recordIdentity()).toBe(recordId); expect(ports.pair).toBe(keyPair)
    expect(owner.snapshot().record.conversation).toEqual(before.record.conversation)
    expect((await client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    recovered = true
    await act(async () => { await client.connect() })
    await wait(() => expect(client.sessionObservation().state).toBe('ready'))
    expect(document.querySelector('.mobile-app')?.getAttribute('data-connection')).toBe('connected')
    expect(document.querySelector('[contenteditable="true"]')).toBe(editor)
    expect(editor?.textContent).toBe('Original unsent draft')
    expect(owner.recordIdentity()).toBe(recordId)
    expect(owner.snapshot().record.conversation.drafts).toContainEqual([key, 'Original unsent draft'])
    expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve() }
})

it('the original Focus and Composer distinguish a pending directory from a confirmed empty Host without a Session event', async () => {
  const f = await actualRelayOwner({ sessionIds: [] }), entered = held(), release = held()
  await new AgentMuxSpatialStateStore().registerFolder({ id: 'private-empty-project', hostId: 'local', name: 'Empty project', path: f.root })
  f.cleanup(() => release.resolve())
  const original = f.host.client.readAgentSessions.bind(f.host.client)
  vi.spyOn(f.host.client, 'readAgentSessions').mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return await original()
  })
  // An omitted optional presentation projection exercises the real metadata
  // consumer; the complete Core inventory is genuinely empty, not cropped.
  let omitPresentation = true
  f.reply(async (frame, connection, send) => {
    const request = f.requests.find(value => value.connection === connection && value.frame.id === frame.id)
    if (omitPresentation && request?.frame.method === 'space.ls' && frame.result) {
      const result = structuredClone(frame.result) as { catalog: { agentPresentation?: unknown } }
      delete result.catalog.agentPresentation
      await send({ ...frame, result })
    } else await send(frame)
  })
  const signal = new AbortController()
  const client = await connectRelayHostedClient({ ...f.options, name: 'empty directory consumer', signal: signal.signal,
    sessions: 'summary', waitForReady: false })
  f.cleanup(async () => { await client.dispose(); signal.abort() })
  await entered.promise
  const seen: string[] = []; client.onEvent(event => { seen.push(event.type) })
  const { MobileSpatialNavigation } = await import('../src/navigation/MobileSpatialNavigation')
  const { MobileConversationHeaderFixture } = await import('./conversation-header-fixture')
  const { MobileNoticeProvider } = await import('../src/notices/MobileNotice')
  const { createBrowserPlatform } = await import('../src/platform/browser')
  const { createRoot } = await import('react-dom/client')
  const { paste } = await import('./conversation-fixture')
  const element = document.getElementById('root')!, root = createRoot(element)
  let presentations = 0
  f.cleanup(async () => { await act(async () => { for (const owned of ports.roots.splice(0)) owned.unmount() }) })
  await act(async () => root.render(<MobileNoticeProvider>
    <MobileSpatialNavigation home="focus" client={client} connected onPresentation={() => { presentations++ }} openSession={() => { throw Error('No Session was selected') }} />
    <MobileConversationHeaderFixture client={client} agentSessionId="retained-original" connection={{ state: 'connected', message: 'Original private Host' }}
      platform={createBrowserPlatform()} onShowTerminal={() => { throw Error('No terminal was requested') }} />
  </MobileNoticeProvider>))
  try {
    // Finish the independent Space projection and its subscription effects
    // before releasing metadata. Its later render must not mask a missed ready.
    await wait(() => expect(presentations).toBe(1))
    await wait(() => expect(element.querySelector('.mobile-focus-facet')?.textContent).toContain('正在读取会话'))
    await wait(() => expect(element.querySelector('[contenteditable="true"]')).not.toBeNull())
    await paste(element, '@')
    await wait(() => expect(document.querySelector('.composer__suggestion-feedback')?.textContent).toContain('引用目录'))
    const editor = element.querySelector('[contenteditable="true"]')
    release.resolve()
    await wait(() => expect(client.sessionObservation()).toEqual({ state: 'ready', hasSnapshot: true }))
    await wait(() => expect(document.querySelector('.composer__suggestion-feedback')).toBeNull())
    expect(seen).toContain('session-observation-state'); expect(seen).not.toContain('agent-session')
    expect(client.sessionObservationScope()).toBeNull(); expect(client.agentSessions()).toEqual([])
    expect(element.querySelector('.mobile-focus-facet')?.textContent).not.toContain('正在读取会话')
    omitPresentation = false
    const refresh = element.querySelector<HTMLButtonElement>('button[aria-label="刷新空间目录"]')!
    await act(async () => refresh.click())
    await wait(() => expect(element.querySelector('.mobile-focus-facet')?.textContent).toContain('暂无会话'))
    expect(element.querySelector('[contenteditable="true"]')).toBe(editor)
    expect(editor?.textContent).toBe('@')
    expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve() }
})
