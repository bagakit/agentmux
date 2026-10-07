import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryObservation, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

// Paint outside this reading surface is isolated. Global, Store, Row, Hover,
// the shared reader, Markdown renderer and Core prefix parser remain real.
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const initial = useAppStore.getState()
const recipient = 'reading-recipient', declared = 'reading-declared', writer = 'reading-writer'
const originalReply = 'Original **reply** and `src/original.ts`.\n\nThe second paragraph stays.'
let root: Root | undefined
let container: HTMLDivElement | undefined
let editable: HTMLInputElement | undefined
let notify: ((observation: AgentSessionHistoryObservation) => void) | undefined

function card(): HTMLButtonElement {
  const node = container?.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${recipient}"]`)
  expect(node).not.toBeNull()
  expect(node).toBeDefined()
  return node!
}
function panel(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.focus-context-hover')
  expect(node).not.toBeNull()
  return node!
}
function recap(): HTMLElement {
  const node = panel().querySelector<HTMLElement>('.focus-context-hover__recap')
  expect(node).not.toBeNull()
  return node!
}
function inputRows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-hover-input-id]')]
}
function native(id: string, text: string, at?: number): AgentSessionHistoryPage['items'][number] {
  return { id, kind: 'user-message', contentParts: [{ kind: 'text', text }], ...(at === undefined ? {} : { startedAt: at }) }
}
function page(items: AgentSessionHistoryPage['items'] = []): AgentSessionHistoryPage {
  return { agentSessionId: recipient, source: { providerId: 'claude', nativeSessionId: `reading-${recipient}` }, items, nextCursor: null }
}
function captured(id: string, content: string, time: number, author: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id, agentSessionId: recipient, kind: 'user_message', title: 'Input', status: 'complete', source: 'user',
    content, createdAt: time, updatedAt: time, ...author }
}
function reply(content: string): AgentTimelineItem {
  return { id: 'original-reply', agentSessionId: recipient, kind: 'assistant_message', title: 'Reply', source: 'native-hook',
    status: 'complete', content, createdAt: 50, updatedAt: 50 }
}
async function setTimeline(content: string, inputs: AgentTimelineItem[] = [], tail: AgentTimelineItem[] = []): Promise<void> {
  await act(async () => useAppStore.setState({ timelines: {
    [recipient]: { agentSessionId: recipient, revision: inputs.length + tail.length + 1, items: [...inputs, reply(content), ...tail] }
  } }))
}
async function open(): Promise<void> {
  await act(async () => card().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 200)))
  await act(async () => vi.waitFor(() => expect(document.querySelector('.focus-context-hover')).not.toBeNull()))
}
function originalContent(): string | undefined {
  return useAppStore.getState().timelines[recipient]?.items.find(item => item.id === 'original-reply')?.content
}
function accessibleSource(node: Element): string {
  return [node, ...node.querySelectorAll('*')].map(element => [element.textContent, element.getAttribute('title'),
    element.getAttribute('aria-label')].filter(Boolean).join('\n')).join('\n')
}
function noReadingActions(node: Element): void {
  expect(node.querySelectorAll('a[href],button,input,select,textarea,img[src],iframe,[contenteditable="true"]')).toHaveLength(0)
  expect([...node.querySelectorAll<HTMLElement>('[tabindex]')].filter(element => element.tabIndex >= 0)).toHaveLength(0)
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const base = snapshot.sessions.find(session => session.kind === 'agent')
  expect(base).toBeDefined()
  if (!base) throw new Error('Actual Agent fixture is required')
  const sessions = [recipient, declared, writer].map(id => ({ ...base, id, hostId: 'local', workspacePath: _hygiene_fixturePath("reading/repo"),
    status: { state: 'running' as const, source: 'run-process' as const, observedAt: Date.now() },
    control: { ...base.control, hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` } } }))
  useAppStore.setState({ ...initial, loading: false,
    config: { ...config, workspaces: [{ id: 'reading-project', hostId: 'local', kind: 'folder', path: _hygiene_fixturePath("reading/repo"), name: 'Reading project' }] },
    sessions, agentNames: { [recipient]: 'Recipient', [declared]: 'Same declared name', [writer]: 'Recorded writer' },
    scratchTopicSnapshots: {}, tabs: {}, layouts: {}, mainSurface: 'agents',
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [recipient]: 'Original composer draft' }, timelines: {}
  }, true)
  notify = undefined
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (control, observer) => {
    notify = observer
    return { agentSessionId: control.agentSessionId, source: { providerId: 'claude', nativeSessionId: `reading-${control.agentSessionId}` }, dispose: vi.fn() }
  })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page())
  container = document.createElement('div'); editable = document.createElement('input')
  editable.value = 'Original editable input'; document.body.append(container, editable)
  root = createClientUiRoot(container)
  await setTimeline(originalReply)
  await act(async () => root!.render(<GlobalFocusSurface />))
  editable.focus(); editable.setSelectionRange(2, 8)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
  root = undefined; container?.remove(); editable?.remove(); container = undefined; editable = undefined
  document.getElementById('agentmux-window-overlay-host')?.remove()
  window.getSelection()?.removeAllRanges()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('reads the original selected reply as strong/code, separate paragraphs and a list without selecting a later prompt or tool', async () => {
  const text = '第一段 **关键结论** 和 `src/scroll-anchor.ts`。\n\n第二段保留分段。\n\n- 保留草稿\n- 保留原工作面'
  const later = captured('later-prompt', '下一步检查输入', 60, { authorHuman: true })
  const tool: AgentTimelineItem = { id: 'later-tool', agentSessionId: recipient, kind: 'tool_call', title: 'Bash', source: 'native-hook',
    status: 'complete', content: 'pnpm test', createdAt: 70, updatedAt: 70 }
  await setTimeline(text, [], [later, tool])
  const before = useAppStore.getState()
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await open()
  await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(1)))
  expect(panel().querySelector('.focus-context-hover__inputs h4')?.textContent).toBe('Recent inputs')
  expect(panel().querySelector('.focus-context-hover__coverage')).toBeNull()
  expect(panel().querySelector('.focus-context-hover__source')).toBeNull()
  const inputTime = inputRows()[0]!.querySelector('time')!
  expect(inputTime.title).toContain('Submission record · Current reading window')
  expect(inputTime.getAttribute('aria-label')).toContain(inputTime.textContent)
  expect(inputTime.title).toContain(later.content)
  const location = panel().querySelector('footer')!
  expect(location.textContent).toContain('Reading project')
  expect(location.textContent).not.toContain(recipient)
  expect(location.title).toContain(_hygiene_fixturePath("reading/repo"))
  expect(location.title).toContain(recipient)
  expect(location.getAttribute('aria-label')).toBe(location.title)
  expect(recap().querySelector('strong')?.textContent).toBe('关键结论')
  expect(recap().querySelector('code.md-code')?.textContent).toBe('src/scroll-anchor.ts')
  const paragraphs = [...recap().querySelectorAll('.md-paragraph')]
  expect(paragraphs.length).toBeGreaterThanOrEqual(2)
  expect(paragraphs[0]!.textContent).toBe('第一段 关键结论 和 src/scroll-anchor.ts。')
  expect(paragraphs[1]!.textContent).toBe('第二段保留分段。')
  expect([...recap().querySelectorAll('ul.md-list > li')].map(node => node.textContent)).toEqual(['保留草稿', '保留原工作面'])
  expect(recap().textContent).not.toContain(later.content)
  expect(recap().textContent).not.toContain(tool.content)
  expect(accessibleSource(recap())).toContain('Last assistant message'); expect(accessibleSource(recap())).toContain('timeline')
  expect(recap().querySelector('[data-reading-format]')?.getAttribute('data-reading-format')).toBe('markdown')
  expect(originalContent()).toBe(text)
  expect(card().getAttribute('aria-label')).toContain('**关键结论**')
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(before.sessions[0]!.control, { limit: 30 })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(document.activeElement).toBe(editable)
})

it('reads complete Agent wrappers as body while declarations cannot authenticate the author or replace the recorded time', async () => {
  const body = '**正文** 与 `原文件`。\n\n第二段。'
  const wrapped = ("[Message from Agent " + (declared) + ("]\n<bagakit-msg type=\"result\" name=\"Declared only\" time=\"" + _hygiene_fixtureIso(1097125800000, "zone-second", 480) + "\">") + (body) + "</bagakit-msg>")
  const malformed = '[Message from Agent reading-declared]\n<bagakit-msg type="result">unfinished packet'
  const recordedAt = Date.parse(_hygiene_fixtureIso(24124200000, "zone-second", 480))
  const known = captured('verified-capture', wrapped, recordedAt + 1, { authorAgentSessionId: writer })
  await setTimeline(wrapped, [known])
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page([native('declaration-only', wrapped, recordedAt), native('malformed', malformed, recordedAt + 2)]))
  await open(); await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(3)))
  expect(recap().querySelector('strong')?.textContent).toBe('正文')
  expect(recap().querySelector('code.md-code')?.textContent).toBe('原文件')
  expect(recap().querySelector('.md')?.textContent).not.toContain('<bagakit-msg')
  const unknown = inputRows().find(row => row.dataset.hoverInputId === `native:claude:reading-${recipient}:declaration-only`)!
  const verified = inputRows().find(row => row.dataset.hoverInputId === 'captured:verified-capture')!
  const invalid = inputRows().find(row => row.dataset.hoverInputId === `native:claude:reading-${recipient}:malformed`)!
  expect(unknown).toBeDefined(); expect(verified).toBeDefined(); expect(invalid).toBeDefined()
  expect(unknown.dataset.inputAuthor).toBe('unknown'); expect(verified.dataset.inputAuthor).toBe('agent')
  expect(verified.textContent).toContain('Recorded writer')
  expect(unknown.querySelector('.md strong')?.textContent).toBe('正文')
  expect(accessibleSource(unknown)).toContain(wrapped)
  expect(unknown.querySelector('time')?.getAttribute('datetime')).toBe(new Date(recordedAt).toISOString())
  expect(unknown.querySelector('time')?.getAttribute('title')).toContain('Native record · Current reading window')
  expect(verified.querySelector('time')?.getAttribute('title')).toContain('Submission record · Current reading window')
  expect(panel().querySelector('.focus-context-hover__source')).toBeNull()
  expect(panel().querySelector('.focus-context-hover__inputs > .focus-context-hover__coverage')).toBeNull()
  expect(unknown.querySelector('time')?.textContent).not.toContain('2060')
  expect(invalid.textContent).toContain(malformed)
  expect(originalContent()).toBe(wrapped)
  expect(useAppStore.getState().timelines[recipient]!.items[0]).toBe(known)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

it('disambiguates records on different dates and preserves source order when a record has no timestamp', async () => {
  const later = Date.parse(_hygiene_fixtureIso(24124200000, "zone-second", 480)), earlier = Date.parse(_hygiene_fixtureIso(24037800000, "zone-second", 480))
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page([
    native('later-day', 'Later recorded day', later), native('unknown-time', 'Unknown record time'), native('earlier-day', 'Earlier recorded day', earlier)
  ]))
  await open(); await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(3)))
  expect(inputRows().map(row => row.dataset.hoverInputId)).toEqual(['later-day', 'unknown-time', 'earlier-day'].map(id => `native:claude:reading-${recipient}:${id}`))
  const times = inputRows().map(row => row.querySelector('time')!)
  expect(times.every(Boolean)).toBe(true)
  expect(times[0]!.getAttribute('datetime')).toBe(new Date(later).toISOString())
  expect(times[2]!.getAttribute('datetime')).toBe(new Date(earlier).toISOString())
  expect(times[0]!.textContent).toContain('2026'); expect(times[2]!.textContent).toContain('2026')
  expect(times[0]!.textContent).not.toBe(times[2]!.textContent)
  expect(times[1]!.textContent).toBe('Time unknown'); expect(times[1]!.hasAttribute('datetime')).toBe(false)
  expect(panel().textContent).toContain('Order unavailable')
  expect(inputRows().every(row => row.dataset.inputAuthor === 'unknown')).toBe(true)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

it('labels bounded reply and input literals as Excerpts without rendering cut Markdown or reading an earlier page', async () => {
  const longReply = '**literal reply**\n\n' + 'r'.repeat(820) + 'UNSEEN-REPLY-TAIL'
  const inputBody = '**literal input**\n\n' + 'i'.repeat(400) + 'UNSEEN-INPUT-TAIL'
  const longInput = ("[Message from Agent " + (declared) + ("]\n<bagakit-msg type=\"result\" name=\"Declared long\" time=\"" + _hygiene_fixtureIso(1097125800000, "zone-second", 480) + "\">") + (inputBody) + "</bagakit-msg>")
  await setTimeline(longReply)
  const nativePage = { ...page([native('long-input', longInput, 20)]), nextCursor: 'opaque-real-earlier-cursor' }
  vi.mocked(api.sessions.historyPage).mockResolvedValue(nativePage)
  await open(); await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(1)))
  const replyLiteral = recap().querySelector('p')!, inputLiteral = inputRows()[0]!.querySelector('p')!
  expect(replyLiteral).not.toBeNull(); expect(inputLiteral).not.toBeNull()
  expect(recap().textContent).toContain('Excerpt'); expect(inputRows()[0]!.textContent).toContain('Excerpt')
  expect(recap().querySelector('[data-reading-format]')?.getAttribute('data-reading-format')).toBe('excerpt')
  expect(inputRows()[0]!.querySelector('[data-reading-format]')?.getAttribute('data-reading-format')).toBe('excerpt')
  expect(replyLiteral.textContent!.length).toBeLessThanOrEqual(800)
  expect(replyLiteral.textContent).toMatch(/^\*\*literal reply\*\*\n\n/)
  expect(replyLiteral.textContent).toMatch(/…$/)
  expect(inputLiteral.textContent!.length).toBeLessThanOrEqual(360)
  expect(inputLiteral.textContent).toMatch(/^\*\*literal input\*\*\n\n/)
  expect(inputLiteral.textContent).toMatch(/…$/)
  expect(replyLiteral.querySelector('strong,code')).toBeNull(); expect(inputLiteral.querySelector('strong,code')).toBeNull()
  expect(replyLiteral.textContent).not.toContain('UNSEEN-REPLY-TAIL'); expect(inputLiteral.textContent).not.toContain('UNSEEN-INPUT-TAIL')
  expect(originalContent()).toBe(longReply)
  expect(nativePage.items[0]!.contentParts[0]).toEqual({ kind: 'text', text: longInput })
  expect(inputRows()[0]!.dataset.inputAuthor).toBe('unknown')
  expect(accessibleSource(inputRows()[0]!)).toContain(`[Message from Agent ${declared}]`)
  expect(accessibleSource(inputRows()[0]!)).toContain('Declared long')
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(useAppStore.getState().sessions[0]!.control, { limit: 30 })
})

it('keeps HTTP, file, image, code, anchor and footnote references selectable with no resource reads or focusable no-op controls', async () => {
  const text = ("[网页](https://example.invalid/docs) 与 [文件](src/original.ts)。\n\n![图像](https://example.invalid/image.png)\n\n`@" + _hygiene_fixturePath("private/.agentmux/pasted/original.png") + "`\n\n```sh\ncurl https://example.invalid/private\n```\n\n[段落](#section) 与注释[^one]。\n\n[^one]: 原注释内容")
  await setTimeline(text)
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page([native('references', text, 20)]))
  const openExternal = vi.spyOn(api.ui, 'openExternal'), readImage = vi.spyOn(api.ui, 'readPastedImage')
  const readFile = vi.spyOn(api.files, 'read'), readPreview = vi.spyOn(api.files, 'readPreview')
  const openFile = vi.fn(), createBrowser = vi.fn(), stop = vi.spyOn(api.sessions, 'stop')
  const actual = useAppStore.getState()
  useAppStore.setState({ openFile, createBrowser })
  const before = useAppStore.getState()
  try {
    await open(); await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(1)))
    const bodies = [recap(), inputRows()[0]!]
    for (const body of bodies) {
      expect(body.textContent).toContain('网页'); expect(body.textContent).toContain('文件'); expect(body.textContent).toContain('图像')
      expect(body.querySelector('pre.md-block-code code')?.textContent).toBe('curl https://example.invalid/private')
      expect(body.textContent).toContain(("@" + _hygiene_fixturePath("private/.agentmux/pasted/original.png")))
      expect(body.textContent).toContain('原注释内容'); noReadingActions(body)
      const leaves = [...body.querySelectorAll<HTMLElement>('p,span,code,sup')].filter(node => !node.children.length)
      expect(leaves.length).toBeGreaterThan(3)
      for (const leaf of leaves) await act(async () => leaf.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    expect(openExternal).not.toHaveBeenCalled(); expect(readImage).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled(); expect(readPreview).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled(); expect(createBrowser).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(document.activeElement).toBe(editable); expect(originalContent()).toBe(text)

    // The explicit observation mode must leave ordinary document actions intact.
    // This second real Markdown mount uses default readOnly=false and no IO.
    const originalPanel = panel(), documentContainer = document.createElement('div')
    document.body.append(documentContainer)
    const documentRoot = createClientUiRoot(documentContainer)
    const hostHttp = vi.fn(), hostFile = vi.fn()
    try {
      await act(async () => documentRoot.render(<AgentMarkdown
        content={'# Section\n\n[网页](https://example.invalid/docs) 与 [文件](src/original.ts)。\n\n[段落](#section) 与注释[^one]。\n\n[^one]: 原注释内容'}
        documentMode workspaceRoot={_hygiene_fixturePath("reading/repo")} openHttpLink={hostHttp} openWorkspaceFile={hostFile}
      />))
      const http = documentContainer.querySelector<HTMLButtonElement>('button[title="https://example.invalid/docs"]')
      const file = documentContainer.querySelector<HTMLButtonElement>('button.md-link--file')
      const anchor = documentContainer.querySelector<HTMLButtonElement>('button[title="#section"]')
      const footnote = documentContainer.querySelector<HTMLButtonElement>('.md-footnote-reference button')
      const backlink = documentContainer.querySelector<HTMLButtonElement>('button[aria-label^="Return to footnote"]')
      for (const control of [http, file, anchor, footnote, backlink]) {
        expect(control).not.toBeNull(); expect(control!.disabled).toBe(false)
      }
      await act(async () => http!.click())
      expect(hostHttp).toHaveBeenCalledExactlyOnceWith('https://example.invalid/docs', expect.objectContaining({ metaKey: false, ctrlKey: false }))
      await act(async () => file!.click())
      expect(hostFile).toHaveBeenCalledExactlyOnceWith('src/original.ts', undefined, expect.objectContaining({ type: 'click', metaKey: false, ctrlKey: false }))
      await act(async () => footnote!.click())
      expect(document.activeElement).toBe(documentContainer.querySelector('[data-md-footnote="1"]'))
      await act(async () => backlink!.click())
      expect(document.activeElement).toBe(documentContainer.querySelector('[data-md-footnote-reference="1:1"]'))
      await act(async () => anchor!.click())
      expect(document.activeElement).toBe(documentContainer.querySelector('[data-md-anchor="section"]'))
      expect(panel()).toBe(originalPanel); expect(originalContent()).toBe(text)
      expect(openExternal).not.toHaveBeenCalled(); expect(readImage).not.toHaveBeenCalled()
      expect(openFile).not.toHaveBeenCalled(); expect(createBrowser).not.toHaveBeenCalled()
      expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    } finally {
      await act(async () => documentRoot.unmount()); documentContainer.remove(); editable!.focus()
    }
  } finally { useAppStore.setState({ openFile: actual.openFile, createBrowser: actual.createBrowser }) }
})

it('retains rich reply nodes and the original Range, input selection and draft through actual reader invalidation and unrelated output', async () => {
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page([native('held-native', 'Original terminal input', 10)]))
  const before = useAppStore.getState(), row = card()
  await open(); await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(1)))
  const replyRoot = recap().querySelector('.md')!, paragraph = replyRoot.querySelector('.md-paragraph')!
  const strong = paragraph.querySelector('strong')!, code = paragraph.querySelector('code')!
  expect(replyRoot).not.toBeNull(); expect(paragraph).not.toBeNull(); expect(strong).not.toBeNull(); expect(code).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(strong)
  const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range)
  const start = range.startContainer, end = range.endContainer, selectionText = selected.toString()
  expect(selectionText).toBe('reply')
  const readCount = vi.mocked(api.sessions.historyPage).mock.calls.length
  for (let index = 0; index < 20; index++) await act(async () => useAppStore.setState(state => ({
    sessions: state.sessions.map(session => session.id === writer ? { ...session, latestOutputBytes: session.latestOutputBytes + 1,
      status: { ...session.status, observedAt: session.status.observedAt + 1 } } : session)
  })))
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(readCount)
  expect(api.sessions.observeHistory).toHaveBeenCalledTimes(1)
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page([native('held-native', 'Original terminal input', 10), native('new-native', 'New terminal input', 20)]))
  expect(notify).toBeTypeOf('function')
  await act(async () => notify!({ kind: 'invalidated', agentSessionId: recipient, source: { providerId: 'claude', nativeSessionId: `reading-${recipient}` } }))
  await act(async () => vi.waitFor(() => expect(inputRows()).toHaveLength(2)))
  expect(inputRows().map(item => item.dataset.hoverInputId)).toEqual(['held-native', 'new-native'].map(id => `native:claude:reading-${recipient}:${id}`))
  expect(card()).toBe(row); expect(recap().querySelector('.md')).toBe(replyRoot)
  expect(replyRoot.querySelector('.md-paragraph')).toBe(paragraph)
  expect(paragraph.querySelector('strong')).toBe(strong); expect(paragraph.querySelector('code')).toBe(code)
  expect(selected.rangeCount).toBe(1); expect(selected.getRangeAt(0).startContainer).toBe(start)
  expect(selected.getRangeAt(0).endContainer).toBe(end); expect(selected.toString()).toBe(selectionText)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(readCount + 1)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().sessions[0]!.control).toBe(before.sessions[0]!.control)
  expect(document.activeElement).toBe(editable); expect([editable!.selectionStart, editable!.selectionEnd]).toEqual([2, 8])
  expect(originalContent()).toBe(originalReply)
})
