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
const click = async (text: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === text || node.textContent === text)!.click()) }

it('keeps the card header to the page title and quiet named icon tools, with the mode in details', async () => {
  mode = 'injected'
  await render(`[Icon candidates](${first})`)
  const header = container.querySelector('.conversation-capsule__header')!
  expect(header.querySelector('.conversation-capsule__identity')?.textContent).toBe('Icon candidates')
  expect(header.textContent).not.toMatch(/Injected|Isolated/u)
  const tools = [...header.querySelectorAll<HTMLButtonElement>('.conversation-capsule__actions button')]
  expect(tools.map(tool => tool.getAttribute('aria-label'))).toEqual(['Hide page', 'Expand page', 'Open in Browser'])
  for (const tool of tools) { expect(tool.title).toBe(tool.getAttribute('aria-label')); expect(tool.textContent?.trim()).toBe('') }
  expect(container.querySelector('.conversation-capsule__source')?.textContent).toContain('Injected')
})

it('ordinary Markdown acquires the exact Capsule through the actual conversation and Desktop adapter while code stays literal', async () => {
  await render(`\`![literal](${first})\`\n\n\`\`\`md\n[example](${first})\n\`\`\``)
  expect(create).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  await render(`已重做成[Original page](${first})，可以直接看。`)
  expect(inspect).toHaveBeenCalledWith('capsule.inspect', { capsuleId: '123456789ABC' })
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]!.slice(1)).toEqual(['http://127.0.0.1:41823/', null, undefined, 'normal', 'responsive', '123456789ABC'])
  await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector('.conversation-capsule video'), container.textContent ?? '').not.toBeNull() })
  expect(register.mock.calls[0]![0].occurrence.location).toEqual({ kind: 'inline' })
  expect(api.browser.activatePresentation).not.toHaveBeenCalled()
  await click('Open in Browser'); expect(open).toHaveBeenCalledWith(first)
})

it('ordinary bare references retain their prose and share one original page within the same block', async () => {
  await render(`Read ${first} and ${first}`)
  expect(container.querySelectorAll('[data-object-link]')).toHaveLength(2)
  expect(container.querySelectorAll('.conversation-capsule')).toHaveLength(1)
  expect(inspect).toHaveBeenCalledWith('capsule.inspect', { capsuleId: '123456789ABC' })
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]![6]).toBe('123456789ABC')
  expect(api.browser.activatePresentation).not.toHaveBeenCalled()
})

it('retains original native identity through hide, unknown release and return, without Close or input focus', async () => {
  await render(`![Original page](${first})`)
  const id = create.mock.calls[0]![0]
  await click('Hide page')
  expect(container.querySelector('video')).toBeNull()
  expect(release).toHaveBeenCalledWith(id, 'original-navigation'); expect(close).not.toHaveBeenCalled()
  await click('Show page'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(create.mock.calls.at(-1)![0]).toBe(id)
  expect(api.browser.activatePresentation).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  await act(async () => root.render(null))
  await render(`![Original page](${first})`)
  expect(create.mock.calls.at(-1)![0]).toBe(id)
  await render(`![Original page](${first}) ![Another position](${first})`)
  expect(new Set(create.mock.calls.map(call => call[0])).size).toBe(1)
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

it('owns its page layout: the card declares the layout host for its own page', async () => {
  await render(`![Original page](${first})`)
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
  const input = register.mock.calls[0]![0] as { occurrence: { layoutHost?: true; location: unknown } }
  expect(input.occurrence.layoutHost).toBe(true)
  expect(input.occurrence.location).toEqual({ kind: 'inline' })
  expect(container.querySelector('.conversation-capsule video')?.getAttribute('style')).toContain('object-fit: contain')
})

it('releases only after a late native lease has actually been removed', async () => {
  let finish!: (value: { leaseId: string }) => void
  register.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const order: string[] = []
  vi.mocked(api.browser.removePresentation).mockImplementation(async () => { order.push('lease removed') })
  release.mockImplementation(async (browserId, navigationId) => { order.push('native release'); return { browserId, navigationId, status: 'retained', reasons: ['document-used'] } })
  await render(`![Original page](${first})`)
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
  await click('Hide page')
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
  await click('Hide page'); expect(release).not.toHaveBeenCalled()
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

it('preserves the trusted question editor node and unsaved bytes through Hide and reading visibility handoffs', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  inspect.mockImplementation((async (method: string, params: any) => method === 'capsule.interaction.ls' ? {
    interactions: [{ capsuleId: params.capsuleId, interactionId: 'original-hidden-question', question: 'Original hidden question?', draft: 'Saved draft', revision: 0, status: 'pending' }], issues: []
  } : originalRead(method, params)) as never)
  await render(`![Connected result](${first})`)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.click())
  const before = container.querySelector<HTMLTextAreaElement>('textarea')!
  expect(before).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(before, 'Unsaved trusted answer')
    before.dispatchEvent(new Event('input', { bubbles: true })); before.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('Hide page')
  expect(before.isConnected, 'Hide must keep the original trusted form mounted').toBe(true)
  expect(before.closest('[hidden][inert]')).not.toBeNull()
  await click('Show page'); expect(container.querySelector('textarea')).toBe(before); expect(before.value).toBe('Unsaved trusted answer')
  await render(`![Connected result](${first})`, false)
  expect(before.isConnected, 'A reading visibility handoff must retain the same trusted editor').toBe(true)
  await render(`![Connected result](${first})`, true)
  expect(container.querySelector('textarea')).toBe(before); expect(before.value).toBe('Unsaved trusted answer')
  expect(inspect.mock.calls.filter(([method]) => method === 'capsule.interaction.draft')).toHaveLength(0)
})

it('marks a page that waits for the person and never reports an unreadable list as nothing pending', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  let list: 'pending' | 'failed' = 'pending'
  inspect.mockImplementation((async (method: string, params: any) => {
    if (method !== 'capsule.interaction.ls') return originalRead(method, params)
    if (list === 'failed') throw new Error('Questions are unreadable right now')
    return { interactions: [{ capsuleId: params.capsuleId, interactionId: 'waiting', question: 'Which icon?', draft: '', revision: 1, status: 'pending', target: { hostId: 'local', agentSessionId: 'creator' } }], issues: [] }
  }) as never)
  await render(`![Icon candidates](${first})`)
  const chip = () => container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!
  await vi.waitFor(() => expect(chip().dataset.attention).toBe('pending'))
  expect(chip().textContent).toContain('Needs your answer')
  list = 'failed'
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click())
  // A failed read keeps the questions already read; it does not invent an empty list.
  expect(chip().dataset.attention).toBe('pending')
  await act(async () => root.render(null))
  await render(`![Icon candidates](${first})`)
  await vi.waitFor(() => expect(chip().dataset.attention).toBe('unconfirmed'))
  expect(chip().textContent).not.toContain('Needs your answer')
  expect(chip().title).toContain('Unconfirmed')
})

it('repeats the pending answer in the card header and opens the trusted answer from there', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  inspect.mockImplementation((async (method: string, params: any) => method === 'capsule.interaction.ls'
    ? { interactions: [{ capsuleId: params.capsuleId, interactionId: 'waiting', question: 'Which icon?', draft: '', revision: 1, status: 'pending', target: { hostId: 'local', agentSessionId: 'creator' } }], issues: [] }
    : originalRead(method, params)) as never)
  const scrolled = vi.fn(); HTMLElement.prototype.scrollIntoView = scrolled
  await render(`![Icon candidates](${first})`)
  const marker = () => container.querySelector<HTMLButtonElement>('.conversation-capsule__header [aria-label="Needs your answer"]')
  await vi.waitFor(() => expect(marker()).not.toBeNull())
  expect(marker()!.title).toBe('Needs your answer')
  expect(container.querySelector<HTMLElement>('.capsule-chrome')!.hidden).toBe(true)
  await act(async () => marker()!.click())
  expect(container.querySelector<HTMLElement>('.capsule-chrome')!.hidden).toBe(false)
  expect(scrolled).toHaveBeenCalled()
  // A hidden page that still waits for the person keeps its marker; the marker brings the page back with the answer open.
  await click('Hide page')
  expect(marker()).not.toBeNull()
  await act(async () => marker()!.click())
  expect(container.querySelector('[aria-label="Hide page"]')).not.toBeNull()
  expect(container.querySelector<HTMLElement>('.capsule-chrome')!.hidden).toBe(false)
})

it('keeps the card header free of an answer marker when nothing can be answered', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  inspect.mockImplementation((async (method: string, params: any) => method === 'capsule.interaction.ls'
    ? { interactions: [{ capsuleId: params.capsuleId, interactionId: 'unbound', question: 'Which icon?', draft: '', revision: 1, status: 'pending' }], issues: [] }
    : originalRead(method, params)) as never)
  await render(`![Icon candidates](${first})`)
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.dataset.attention).toBe('none'))
  expect(container.querySelector('.conversation-capsule__header [aria-label="Needs your answer"]')).toBeNull()
})

it('shows a failed page refresh as a quiet status with its own retry, after the question', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  inspect.mockImplementation((async (method: string, params: any) => {
    if (method === 'capsule.interaction.ls') return { interactions: [{ capsuleId: params.capsuleId, interactionId: 'waiting', question: 'Which icon?', draft: '', revision: 1, status: 'pending', target: { hostId: 'local', agentSessionId: 'creator' } }], issues: [] }
    if (method === 'capsule.inspect' && (inspect.mock.calls.length > 2)) throw new Error('Original page metadata observation is unavailable')
    return originalRead(method, params)
  }) as never)
  await render(`![Icon candidates](${first})`)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!.click())
  const panel = container.querySelector<HTMLElement>('.capsule-chrome')!
  await vi.waitFor(() => expect(panel.querySelector('.capsule-chrome__issue')).not.toBeNull())
  const issue = panel.querySelector<HTMLElement>('.capsule-chrome__issue')!
  expect(issue.getAttribute('role')).toBe('status')
  expect(issue.querySelector('svg')).not.toBeNull()
  expect(issue.querySelector('button')?.textContent).toBe('Retry page details')
  const question = panel.querySelector('.capsule-question')!
  expect(question.compareDocumentPosition(issue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('does not ask the person to answer a question that has no recipient Agent', async () => {
  mode = 'injected'
  const originalRead = inspect.getMockImplementation()!
  inspect.mockImplementation((async (method: string, params: any) => method === 'capsule.interaction.ls'
    ? { interactions: [{ capsuleId: params.capsuleId, interactionId: 'unbound', question: 'Which icon?', draft: '', revision: 1, status: 'pending' }], issues: [] }
    : originalRead(method, params)) as never)
  await render(`![Icon candidates](${first})`)
  const chip = () => container.querySelector<HTMLButtonElement>('[aria-label="Page questions"]')!
  await vi.waitFor(() => expect(chip().dataset.attention).toBe('none'))
  expect(chip().textContent).not.toContain('Needs your answer')
})
