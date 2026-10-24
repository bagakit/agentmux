// @vitest-environment happy-dom
import { fixtureEpoch as _privacyFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../../../packages/client-ui/src/components/AgentMarkdown'
import { ConversationMessage } from '../../../packages/client-ui/src/components/ConversationMessage'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../src/renderer/src/lib/api'
import { WorkbenchPresentationContext, type WorkbenchPresentation } from '../src/renderer/src/lib/workbench-presentation'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { previewFrame, previewMedia } from './helpers/browser-preview-media'
import type { CapsulePort } from '@agentmux/core/capsule'

let root: Root, container: HTMLDivElement
const first = 'amux://capsule/123456789ABC', second = 'amux://capsule/ABCDEFGHJKLM'
let mode: 'isolated' | 'injected', available: boolean
let inspect: ReturnType<typeof vi.spyOn>, create: ReturnType<typeof vi.spyOn>, close: ReturnType<typeof vi.spyOn>, release: ReturnType<typeof vi.spyOn>, register: ReturnType<typeof vi.spyOn>, open: ReturnType<typeof vi.spyOn>
let mediaRestore: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: target.getBoundingClientRect() } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    unobserve() {} disconnect() {}
  })
  mode = 'isolated'; available = true
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 20, left: 0, top: 20, right: 640, bottom: 320, width: 640, height: 300, toJSON: () => ({}) })
  const { stream } = previewMedia()
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn(async () => stream) } })
  mediaRestore = () => { if (previous) Object.defineProperty(navigator, 'mediaDevices', previous); else delete (navigator as unknown as Record<string, unknown>).mediaDevices }
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { previewFrame(this as HTMLVideoElement); return Promise.resolve() })
  inspect = vi.spyOn(api.capsules, 'call').mockImplementation((async (method, params: any) => method === 'capsule.interaction.ls' ? { interactions: [], issues: [] }
    : { record: { capsuleId: params.capsuleId, title: 'Original saved result', mode, contentRoot: (new URL('file:///').pathname + "fixture/page") },
      endpoint: available ? { status: 'available', url: 'http://127.0.0.1:41823/' } : { status: 'unavailable', issue: { message: 'Original service is stopped.' } } }) as CapsulePort['call'])
  create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url, _workspace, _profile, _mode, _viewport, capsuleId) => ({
    id, url, navigationId: 'original-navigation', capsuleId, capsuleActive: true, loading: false
  }) as never)
  vi.spyOn(api.browser, 'restore').mockRejectedValue(new Error('No original native owner exists'))
  close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  release = vi.spyOn(api.browser, 'release').mockImplementation(async (browserId, navigationId) => ({ browserId, navigationId, status: 'unknown', reasons: ['close-unconfirmed'] }))
  register = vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId: 'original-lease' })
  vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'original-capture', browserId: 'fixture-browser' })
  vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mediaRestore(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(content: string, visible = true) {
  await act(async () => root.render(<WorkbenchDocumentContext.Provider value={{ document, window: { windowId: 'original-window', documentGeneration: 'original-document' } }}><DesktopClientUiProvider><ConversationMessage messageId="original-message" conversationSessionId="original-session" executionHostId="local" speaker={{ role: 'agent', id: 'original-agent' }} content={content} active={visible} /></DesktopClientUiProvider></WorkbenchDocumentContext.Provider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}
const click = async (text: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!.click()) }

it('only explicit block image intent acquires the exact Capsule through the actual conversation and Desktop adapter', async () => {
  await render(`Read ${first} or [open](${first}).\n\n\`![literal](${first})\`\n\n\`\`\`md\n![example](${first})\n\`\`\``)
  expect(create).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  await render(`![Original page](${first})`)
  expect(inspect).toHaveBeenCalledWith('capsule.inspect', { capsuleId: '123456789ABC' })
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]!.slice(1)).toEqual(['http://127.0.0.1:41823/', null, undefined, 'normal', 'responsive', '123456789ABC'])
  await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector('.conversation-capsule video'), container.textContent ?? '').not.toBeNull() })
  expect(register.mock.calls[0]![0].occurrence.location).toEqual({ kind: 'inline' })
  expect(api.browser.activatePresentation).not.toHaveBeenCalled()
  await click('Open in Browser'); expect(open).toHaveBeenCalledWith(first)
})

it('retains original native identity through hide, unknown release and return, without Close or input focus', async () => {
  await render(`![Original page](${first})`)
  const id = create.mock.calls[0]![0]
  await click('Hide')
  expect(container.querySelector('video')).toBeNull()
  expect(release).toHaveBeenCalledWith(id, 'original-navigation'); expect(close).not.toHaveBeenCalled()
  await click('Show page'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(create.mock.calls.at(-1)![0]).toBe(id)
  expect(api.browser.activatePresentation).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  await act(async () => root.render(null))
  await render(`![Original page](${first})`)
  expect(create.mock.calls.at(-1)![0]).toBe(id)
  await render(`![Original page](${first}) ![Another position](${first})`)
  expect(new Set(create.mock.calls.map(call => call[0])).size).toBe(2)
})

it('keeps same-URI packet occurrences separate and preserves each original identity on remount', async () => {
  const packet = `<bagakit-msg type="result" name="Page author" time="${new Date(_privacyFixtureEpoch(20751, 43200)).toISOString().replace('.000Z', 'Z')}">![Text page](${first})<cite from="User" ref="original-citation">![Cited page](${first})</cite></bagakit-msg>`
  await render(packet)
  expect(container.querySelectorAll('.conversation-capsule')).toHaveLength(2)
  const ids = create.mock.calls.map(call => call[0])
  expect(new Set(ids).size).toBe(2)
  await act(async () => root.render(null))
  await render(packet)
  expect(create.mock.calls.slice(-2).map(call => call[0])).toEqual(ids)
})

it('keeps one original document when its exact Region moves to a different physical host', async () => {
  const draw = async (owner: WorkbenchPresentation) => {
    await act(async () => root.render(<WorkbenchPresentationContext.Provider value={owner}><DesktopClientUiProvider><ConversationMessage
      messageId="original-message" conversationSessionId="original-session" executionHostId="local" speaker={{ role: 'agent', id: 'original-agent' }}
      content={`![Original page](${first})`} active /></DesktopClientUiProvider></WorkbenchPresentationContext.Provider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  const reference = { displayWorkspaceId: 'display', groupId: 'group-a', tabId: 'original-tab', regionId: 'original-region' }
  await draw({ active: true, retainedRegionId: null, surface: 'space', reference, tabHostId: 'physical-host-a' })
  const id = create.mock.calls[0]![0]
  await draw({ active: true, retainedRegionId: null, surface: 'space', reference: { ...reference, groupId: 'group-b' }, tabHostId: 'physical-host-b' })
  expect(create.mock.calls.every(call => call[0] === id)).toBe(true)
  expect(container.querySelectorAll('.conversation-capsule')).toHaveLength(1)
  expect(release).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})

it('keeps stopped and hidden pages inert, shows exact recovery, and creates each requested source independently', async () => {
  await render(`![Original page](${first})`, false)
  expect(inspect).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  available = false
  await render(`![Original page](${first})`)
  expect(container.textContent).toContain('Original service is stopped.'); expect(create).not.toHaveBeenCalled()
  expect(inspect.mock.calls.every(call => call[0] === 'capsule.inspect')).toBe(true)
  available = true
  await click('Retry original page'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(create).toHaveBeenCalledTimes(1)
  await render(`![Original page](${first}) ![Other page](${second})`)
  expect(container.querySelectorAll('.conversation-capsule')).toHaveLength(2)
  expect(new Set(create.mock.calls.map(call => call[6]))).toEqual(new Set(['123456789ABC', 'ABCDEFGHJKLM']))
})

it('keeps readOnly, document and absent-adapter references readable with no page work', async () => {
  const content = `![Original page](${first})`
  for (const props of [{ readOnly: true }, { documentMode: true }, {}]) {
    await act(async () => root.render(<AgentMarkdown {...props} content={content} />))
    expect(container.textContent).toContain(first); expect(container.querySelector('iframe')).toBeNull()
  }
  expect(create).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
})

it('keeps an unscoped Desktop reader as the original reference rather than sharing an anonymous native identity', async () => {
  await act(async () => root.render(<DesktopClientUiProvider><ConversationMessage messageId="original-message" conversationSessionId="original-session"
    executionHostId="local" speaker={{ role: 'agent', id: 'original-session' }} content={`![Original page](${first})`} active /></DesktopClientUiProvider>))
  expect(container.textContent).toContain(first)
  expect(api.browser.restore).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
})

it('mounts trusted questions only for the original injected page and preserves unavailable raw references', async () => {
  mode = 'injected'
  await render(`![Original page](${first})`)
  expect(container.querySelector('[aria-label="Page questions"]')).not.toBeNull()
  expect(inspect).toHaveBeenCalledWith('capsule.interaction.ls', { capsuleId: '123456789ABC' })
  await render(`![invalid](${first}?reply=yes)`)
  expect(container.querySelector('.conversation-capsule')).toBeNull()
  expect(close).not.toHaveBeenCalled()
})

it('releases only after a late native lease has actually been removed', async () => {
  let finish!: (value: { leaseId: string }) => void
  register.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const order: string[] = []
  vi.mocked(api.browser.removePresentation).mockImplementation(async () => { order.push('lease removed') })
  release.mockImplementation(async (browserId, navigationId) => { order.push('native release'); return { browserId, navigationId, status: 'retained', reasons: ['document-used'] } })
  await render(`![Original page](${first})`)
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
  await click('Hide')
  expect(release).not.toHaveBeenCalled()
  await act(async () => finish({ leaseId: 'late-original-lease' }))
  expect(order).toEqual(['lease removed', 'native release'])
  expect(close).not.toHaveBeenCalled()
})

it('retains a loaded original document when a later service read fails', async () => {
  await render(`![Original page](${first})`)
  await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector('video')).not.toBeNull() })
  const video = container.querySelector('video')
  const callbacks: Array<(event: any) => void> = []
  // The actual retry button appears for an exact native observation failure, not from service prose parsing.
  const onEvent = vi.spyOn(api.browser, 'onEvent').mockImplementation(callback => { callbacks.push(callback); return () => {} })
  await render(`![Original page](${second})`)
  await vi.waitFor(() => expect(callbacks).toHaveLength(1))
  await act(async () => callbacks[0]!({ type: 'unavailable', id: create.mock.calls.at(-1)![0], error: 'Current service observation is unavailable.' }))
  available = false
  await click('Retry original page')
  expect(container.textContent).toContain('Original service is stopped.')
  expect(container.querySelector('video')).not.toBeNull()
  expect(close).not.toHaveBeenCalled(); expect(video).not.toBeNull(); onEvent.mockRestore()
})

it('retains the native release receipt when pending registration rejects after hiding', async () => {
  let reject!: (error: Error) => void
  register.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await render(`![Original page](${first})`)
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
  await click('Hide'); expect(release).not.toHaveBeenCalled()
  await act(async () => reject(new Error('Original registration receipt is unavailable')))
  expect(release).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
})

it('requests safe release on actual unmount before the native registration timer runs', async () => {
  vi.useFakeTimers()
  try {
    await act(async () => root.render(<WorkbenchDocumentContext.Provider value={{ document, window: { windowId: 'original-window', documentGeneration: 'original-document' } }}><DesktopClientUiProvider><ConversationMessage messageId="original-message" conversationSessionId="original-session"
      executionHostId="local" speaker={{ role: 'agent', id: 'original-agent' }} content={`![Original page](${first})`} active /></DesktopClientUiProvider></WorkbenchDocumentContext.Provider>))
    expect(create).toHaveBeenCalledTimes(1); expect(register).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(release).toHaveBeenCalledWith(create.mock.calls[0]![0], 'original-navigation')
    expect(close).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('reconnects its original retained document before failed service observation after a complete message remount', async () => {
  await render(`![Original page](${first})`)
  const original = await create.mock.results[0]!.value
  await act(async () => root.render(null))
  create.mockClear()
  vi.mocked(api.browser.restore).mockResolvedValue(original)
  inspect.mockRejectedValue(new Error('The original service observation is unavailable'))
  await render(`![Original page](${first})`)
  await vi.waitFor(() => expect(container.querySelector('video')).not.toBeNull())
  expect(container.textContent).toContain('The original service observation is unavailable')
  expect(container.querySelector('[aria-label="Page questions"]')).not.toBeNull()
  expect(api.browser.restore).toHaveBeenLastCalledWith(original.id, { workspaceId: null, profileId: null, mode: 'normal', viewport: 'responsive' })
  expect(create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})
