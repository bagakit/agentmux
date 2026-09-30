// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const positioning = vi.hoisted(() => ({ held: false, release: [] as Array<() => void>, referenceUpdates: new Set<() => void>() }))
vi.mock('@floating-ui/dom', async importOriginal => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...actual, computePosition: (...args: Parameters<typeof actual.computePosition>) => actual.computePosition(...args).then(result =>
    positioning.held ? new Promise<typeof result>(resolve => positioning.release.push(() => resolve(result))) : result),
  autoUpdate: (...args: Parameters<typeof actual.autoUpdate>) => {
    positioning.referenceUpdates.add(args[2])
    const stop = actual.autoUpdate(...args)
    return () => { positioning.referenceUpdates.delete(args[2]); stop() }
  } }
})

// Actual Store, native input projection, SessionPane, Activity, History and shared
// message; only transport and unrelated process/chrome leaves are controlled.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({ sessionId }: { sessionId: string }) => <div data-leaf="composer" data-session={sessionId} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) => <header>{onHistory ? <button onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const TEXT = 'First repeated phrase, then repeated phrase.\n\nA second paragraph with **real emphasis**.'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: { codex: { label: 'Fixture', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [{ id: 'ws', name: 'Fixture', hostId: 'local', path: '/fixture', kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> { return { id, kind: 'agent', hostId: 'local', workspacePath: '/fixture', label: id, providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } } }
function page(id: string): AgentSessionHistoryPage { return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, items: [{ id: 'native-text-original', kind: 'user-message', contentParts: [{ kind: 'text', text: TEXT }] }], nextCursor: null } }
function timeline(id: string): AgentTimelineSnapshot { return { agentSessionId: id, revision: 1, items: [{ id: 'live-original-id', agentSessionId: id, kind: 'assistant_message', status: 'complete', source: 'native-hook', title: 'Private message', createdAt: 1, updatedAt: 1, content: TEXT }] } }
function pane(id = 'a', readOnly = false, visible = true) { return <SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible={visible} readOnly={readOnly} linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} /> }
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root, writers: MockInstance[], read: MockInstance<typeof api.sessions.historyPage>
let rectTop = 100
async function flush() { await act(async () => { for (let n = 0; n < 15; n++) await Promise.resolve() }) }
async function render(node: ReactNode) { await act(async () => root.render(node)); await flush() }
function button(label: string, scope: ParentNode = document) { const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === label); expect(found, label).toBeDefined(); return found! }
async function click(el: HTMLButtonElement) { await act(async () => { el.focus(); el.click() }); await flush() }
function body(scope: ParentNode = host) { const found = scope.querySelector<HTMLElement>('.log-turn__body'); expect(found).not.toBeNull(); return found! }
async function select(el: HTMLElement, start = 28, end = 43) {
  const node = el.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString()).toBe('repeated phrase')
  await act(async () => el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush()
  return { node, range }
}
async function typeNote(value = 'Keep this exact target') {
  const textarea = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')
  expect(textarea).not.toBeNull()
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; setter.call(textarea, value); textarea!.dispatchEvent(new Event('input', { bubbles: true })) }); await flush()
}
async function scrollTo(top: number) {
  rectTop = top
  await act(async () => host.querySelector('.activity-feed')!.dispatchEvent(new Event('scroll')))
  await flush()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); rectTop = 100; positioning.held = false; positioning.release = []; positioning.referenceUpdates.clear(); localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useAppStore.setState({ config, sessions: [agent('a')], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: { a: 'activity' }, timelines: { a: timeline('a') }, agentNames: {}, agentComposerDrafts: { a: 'Existing draft\n' }, agentSteerQueues: {} })
  read = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ ...page(control.agentSessionId), items: [] }))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  writers = [vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'recover'), vi.spyOn(api.sessions, 'stop')]
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () { return new DOMRect(0, 0, 380, 600) })
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => {
    const items = [new DOMRect(240, rectTop, 120, 18), new DOMRect(20, rectTop + 22, 80, 18)]
    return { 0: items[0]!, 1: items[1]!, length: items.length, item: index => items[index] ?? null, [Symbol.iterator]: () => items[Symbol.iterator]() }
  })
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, rectTop, 340, 40))
})
afterEach(async () => {
  for (const write of writers) expect(write).toHaveBeenCalledTimes(0)
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})
describe('Actual conversation Range -> following note -> original reply draft', () => {
  it('expands the complete selected passage without retargeting its Range or replacing the note input', async () => {
    await render(pane()); const text = body(); const start = text.querySelector('p')!.firstChild!; const end = text.querySelector('strong')!.firstChild!
    const range = document.createRange(); range.setStart(start, 28); range.setEnd(end, end.textContent!.length)
    const quote = range.toString(); expect(quote).toContain('real emphasis')
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    await act(async () => text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush(); await typeNote('Keep the whole passage')
    const passage = document.querySelector<HTMLDetailsElement>('.conversation-annotation-note__passage')!
    const textarea = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    expect(passage).not.toBeNull(); expect(passage.open).toBe(false)
    expect(passage.querySelector('summary')!.getAttribute('aria-label')).toBe('Selected passage')
    expect(passage.querySelector('summary')!.textContent).toContain('repeated phrase')
    await act(async () => passage.querySelector('summary')!.click()); await flush()
    expect(passage.open).toBe(true)
    expect(passage.querySelector('.log-turn__annotation-quote')!.textContent).toBe(quote)
    expect(document.querySelector('.log-turn__annotation textarea')).toBe(textarea); expect(textarea.value).toBe('Keep the whole passage')
    expect(body()).toBe(text); expect(text.querySelector('p')!.firstChild).toBe(start); expect(text.querySelector('strong')!.firstChild).toBe(end)
    expect(range.toString()).toBe(quote); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
    await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toContain(`> ${quote.replace(/\n/gu, '\n> ')}\n\nNote: Keep the whole passage`)
  })
  it('discards only this note and its underline, including an empty note, without clearing the existing reply draft', async () => {
    await render(pane()); const originalBody = body(); await select(originalBody)
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    expect(button('Discard note').disabled).toBe(false); expect(button('Add to reply draft').disabled).toBe(true)
    await click(button('Discard note'))
    expect(document.querySelector('.log-turn__annotation')).toBeNull(); expect(document.querySelector('.conversation-annotation-recovery')).toBeNull()
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    expect(body()).toBe(originalBody); expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
    await select(originalBody); await typeNote('Discard this local note'); await click(button('Close note')); await click(button('Resume note'))
    expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Discard this local note')
    await click(button('Discard note'))
    expect(document.querySelector('.conversation-annotation-recovery')).toBeNull(); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
  it('uses the second actual occurrence, paints every nonempty Range rect and keeps the original nodes', async () => {
    await render(pane()); const text = body(); const selected = await select(text)
    const lines = [...document.querySelectorAll<HTMLElement>('.conversation-annotation-underline')]
    expect(lines).toHaveLength(2); expect(lines.map(line => [line.style.left, line.style.top, line.style.width])).toEqual([['240px', '117px', '120px'], ['20px', '139px', '80px']])
    expect(body()).toBe(text); expect(text.querySelector('p')!.firstChild).toBe(selected.node)
  })
  it('keeps a multi-node Markdown Range intact and quotes its actual rendered text', async () => {
    await render(pane()); const text = body(); const start = text.querySelector('p')!.firstChild!; const end = text.querySelector('strong')!.firstChild!
    const range = document.createRange(); range.setStart(start, 28); range.setEnd(end, end.textContent!.length)
    const quoted = range.toString(); expect(quoted).toContain('repeated phrase'); expect(quoted).toContain('real emphasis')
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    await act(async () => text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush(); await typeNote('Rendered range')
    expect(text.querySelector('p')!.firstChild).toBe(start); expect(text.querySelector('strong')!.firstChild).toBe(end)
    await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toContain(`> ${quoted.replace(/\n/gu, '\n> ')}\n\nNote: Rendered range`)
  })
  it('mounts and closes the real floating branch without errors or late autofocus on position recovery', async () => {
    // Controlled wide Pane geometry; the popover never reserves a text gutter.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.log-turn__body')) return new DOMRect(0, 0, 800, 600)
      if (this.matches('.log-turn__annotation')) return new DOMRect(0, 0, 300, 160)
      return new DOMRect(0, 0, 800, 600)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.log-turn__annotation') ? 300 : 800 })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.log-turn__annotation') ? 160 : 600 })
    const errors = vi.spyOn(console, 'error')
    await render(pane()); const selected = await select(body()); await typeNote()
    const editor = document.querySelector<HTMLElement>('.log-turn__annotation')!
    expect(editor.dataset.anchorState).toBe('range'); expect(editor.style.visibility).toBe('visible')
    expect(editor.style.position).toBe('fixed')
    expect(editor.closest('.window-overlay-host')).not.toBeNull()
    expect(host.querySelector('.agent-surface')!.hasAttribute('data-conversation-note')).toBe(false)
    expect(body().getBoundingClientRect().width).toBe(800)
    const other = document.createElement('input'); document.body.append(other); other.focus()
    await scrollTo(900); await scrollTo(130)
    expect(document.activeElement).toBe(other); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    await click(button('Close note')); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(document.activeElement).toBe(selected.node.parentElement!.closest('.log-turn__text'))
    await scrollTo(170); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    await click(button('Resume note'))
    const reopened = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    expect(document.querySelector<HTMLElement>('.log-turn__annotation')!.dataset.anchorState).toBe('range')
    expect(reopened.value).toBe('Keep this exact target'); expect(document.activeElement).toBe(reopened)
    expect(errors).toHaveBeenCalledTimes(0); other.remove()
  })
  it('does not steal another control focus when the first real position computation resolves late', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.log-turn__body')) return new DOMRect(0, 0, 800, 600)
      if (this.matches('.log-turn__annotation')) return new DOMRect(0, 0, 300, 160)
      return new DOMRect(0, 0, 800, 600)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.log-turn__annotation') ? 300 : 800 })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.log-turn__annotation') ? 160 : 600 })
    await render(pane()); positioning.held = true; await select(body())
    expect(positioning.release.length).toBeGreaterThan(0)
    expect(document.querySelector<HTMLElement>('.log-turn__annotation')!.style.visibility).toBe('hidden')
    const other = document.createElement('input'); document.body.append(other); other.focus()
    positioning.held = false; await act(async () => { for (const release of positioning.release.splice(0)) release() }); await flush()
    expect(document.querySelector<HTMLElement>('.log-turn__annotation')!.style.visibility).toBe('visible')
    expect(document.activeElement).toBe(other); other.remove()
  })
  it('keeps ID, selected text, note and existing draft at the real consumer without sending', async () => {
    await render(pane()); await select(body()); await typeNote(); await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n\n\nRegarding message "live-original-id":\n> repeated phrase\n\nNote: Keep this exact target')
    expect(useAppStore.getState().sessions.map(one => [one.id, one.control, one.processState])).toEqual([['a', agent('a').control, 'running']])
  })
  it('reaches native text in the actual History through the same draft consumer', async () => {
    await render(pane()); read.mockImplementation(async control => page(control.agentSessionId)); await click(button('History', host)); const history = host.querySelector('.session-history')!
    expect(history.querySelectorAll('[data-history-item-id]')).toHaveLength(1)
    await select(body(history)); await typeNote('Native passage'); await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toContain('Regarding message "native-text-original":\n> repeated phrase\n\nNote: Native passage')
  })
  it('reaches actual native user text parts in Activity without changing their source ID', async () => {
    read.mockImplementation(async control => page(control.agentSessionId))
    await render(pane())
    const record = [...host.querySelectorAll<HTMLElement>('.log-turn')].find(node => node.dataset.messageId !== 'live-original-id')
    expect(record).toBeDefined(); expect(record!.querySelectorAll('.log-turn__text')).toHaveLength(1)
    const id = record!.dataset.messageId!; expect(id).toContain('native-text-original')
    await select(body(record!)); await typeNote('Native Activity'); await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toContain(`Regarding message ${JSON.stringify(id)}:\n> repeated phrase\n\nNote: Native Activity`)
  })
  it('follows actual Range rect changes, clips to the viewport and does not steal later focus', async () => {
    await render(pane()); const selected = await select(body()); await typeNote()
    const search = document.createElement('input'); document.body.append(search); search.focus()
    await scrollTo(210)
    expect([...document.querySelectorAll<HTMLElement>('.conversation-annotation-underline')].map(line => line.style.top)).toEqual(['227px', '249px'])
    expect(document.activeElement).toBe(search)
    await scrollTo(900); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    await scrollTo(-5)
    const lines = [...document.querySelectorAll<HTMLElement>('.conversation-annotation-underline')]
    expect(lines).toHaveLength(2); expect(lines[0]!.style.top).toBe('12px')
    expect(document.activeElement).toBe(search); expect(body().querySelector('p')!.firstChild).toBe(selected.node)
    expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Keep this exact target')
    search.remove()
  })
  it('follows a narrow reference layout shift without a viewport resize and cleans up after closing', async () => {
    await render(pane()); const selected = await select(body()); await typeNote()
    const editor = document.querySelector<HTMLElement>('.log-turn__annotation')!
    expect(editor.dataset.anchorState).toBe('range')
    expect(editor.style.position).toBe('fixed')
    expect(editor.closest('.window-overlay-host')).not.toBeNull()
    expect(positioning.referenceUpdates.size).toBeGreaterThan(0)
    const other = document.createElement('input'); document.body.append(other); other.focus()
    // Controlled library notification for a moved reference. The accompanying
    // Chromium qualification expands an actual preceding disclosure with no
    // viewport resize and uses unmodified DOM geometry.
    rectTop = 210
    await act(async () => { for (const refresh of positioning.referenceUpdates) refresh() }); await flush()
    const lines = [...document.querySelectorAll<HTMLElement>('.conversation-annotation-underline')]
    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.style.top)).toEqual(['227px', '249px'])
    expect(document.activeElement).toBe(other)
    expect(body().querySelector('p')!.firstChild).toBe(selected.node)
    await click(button('Close note')); expect(positioning.referenceUpdates.size).toBe(0)
    expect(document.querySelector('.log-turn__annotation')).toBeNull(); other.remove()
  })
  it('does not silently retarget a written note to the other repeated occurrence or another row', async () => {
    const next = timeline('a'); next.items.push({ ...next.items[0]!, id: 'second-record-id', createdAt: 2, updatedAt: 2 })
    useAppStore.setState({ timelines: { a: next } }); await render(pane())
    const records = host.querySelectorAll<HTMLElement>('.log-turn'); expect(records).toHaveLength(2)
    await select(body(records[0]!)); await typeNote('Owned by the first record')
    await select(body(records[0]!), 6, 21)
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Finish or discard')
    await select(body(records[1]!))
    await click(button('Add to reply draft'))
    const draft = useAppStore.getState().agentComposerDrafts.a!
    expect(draft).toContain('Regarding message "live-original-id":'); expect(draft).not.toContain('second-record-id')
    expect(draft).toContain('Note: Owned by the first record')
  })
  it('soft-closes with real focus return, resumes the same note and does not retain a closed floating listener', async () => {
    await render(pane()); const selected = await select(body()); await typeNote()
    const context = selected.node.parentElement!.closest<HTMLElement>('.log-turn__text')!
    expect(context.tabIndex).toBe(-1)
    await click(button('Close note'))
    expect(document.activeElement).toBe(context)
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    await scrollTo(150); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    await click(button('Resume note'))
    const textarea = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    expect(textarea.value).toBe('Keep this exact target'); expect(document.activeElement).toBe(textarea)
  })
  it('keeps the original note when the Pane hides or History covers its Range', async () => {
    await render(pane()); const selected = await select(body()); await typeNote()
    await render(pane('a', false, false))
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    await render(pane()); expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Keep this exact target')
    await click(button('History', host)); expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    await click(button('Activity', host))
    expect(body().querySelector('p')!.firstChild).toBe(selected.node)
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Keep this exact target')
  })
  it('keeps reading focus and releases an untouched selection when switching to Terminal', async () => {
    await render(pane())
    const text = body().querySelector<HTMLElement>('.log-turn__text')!
    text.focus()
    const selected = await select(body())
    expect(document.activeElement).toBe(text)
    expect(window.getSelection()!.toString()).toBe('repeated phrase')
    expect(document.querySelector('.log-turn__annotation')!.closest('.window-overlay-host')).not.toBeNull()
    expect(body().querySelector('p')!.firstChild).toBe(selected.node)
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
    await act(async () => useAppStore.getState().setViewMode('a', 'terminal')); await flush()
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(window.getSelection()!.rangeCount).toBe(0)
    expect(positioning.referenceUpdates.size).toBe(0)
    await act(async () => useAppStore.getState().setViewMode('a', 'activity')); await flush()
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
  it('stops hidden Range geometry while preserving an edited note for the same Session', async () => {
    await render(pane()); await select(body()); await typeNote('Keep this hidden draft')
    const geometry = vi.spyOn(Range.prototype, 'getClientRects')
    await act(async () => useAppStore.getState().setViewMode('a', 'terminal')); await flush()
    geometry.mockClear()
    await act(async () => { host.querySelector('.activity-feed')?.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')) }); await flush()
    expect(geometry).toHaveBeenCalledTimes(0)
    expect(positioning.referenceUpdates.size).toBe(0)
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    await act(async () => useAppStore.getState().setViewMode('a', 'activity')); await flush()
    const editor = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    expect(editor).not.toBeNull(); expect(editor.value).toBe('Keep this hidden draft')
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(2)
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
  it('retains a detached Range honestly without matching its quote to replacement text', async () => {
    await render(pane()); await select(body()); await typeNote()
    await act(async () => useAppStore.setState({ timelines: { a: { ...timeline('a'), items: [{ ...timeline('a').items[0]!, id: 'replacement-id' }] } } })); await flush()
    expect(host.querySelector('.log-turn')!.getAttribute('data-message-id')).toBe('replacement-id')
    expect(document.querySelectorAll('.conversation-annotation-underline')).toHaveLength(0)
    expect(document.querySelector('.log-turn__annotation')!.getAttribute('data-anchor-state')).toBe('unavailable')
    expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Keep this exact target')
    await click(button('Add to reply draft')); expect(useAppStore.getState().agentComposerDrafts.a).toContain('Regarding message "live-original-id":')
  })
  it('cannot add a retained Session A note to Session B and recovers only for its owner', async () => {
    useAppStore.setState({ sessions: [agent('a'), agent('b')], timelines: { a: timeline('a'), b: timeline('b') }, viewModes: { a: 'activity', b: 'activity' }, agentComposerDrafts: { a: 'Existing draft\n', b: 'B draft' } })
    await render(pane()); await select(body()); await typeNote('Session A note')
    await render(pane('b')); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    await select(body()); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts.b).toBe('B draft')
    await render(pane('a')); expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Session A note')
    await click(button('Add to reply draft')); expect(useAppStore.getState().agentComposerDrafts.a).toContain('Note: Session A note')
    expect(useAppStore.getState().agentComposerDrafts.b).toBe('B draft')
  })
  it('keeps note, target and original draft on a synchronous handoff failure and retries the same action', async () => {
    const original = useAppStore.getState().appendAgentComposerDraft
    const append = vi.fn<typeof original>().mockImplementationOnce(() => { throw new Error('Fixture draft failure') }).mockImplementation(original)
    useAppStore.setState({ appendAgentComposerDraft: append })
    await render(pane()); await select(body()); await typeNote('Retry this note'); await click(button('Add to reply draft'))
    expect(append).toHaveBeenCalledTimes(1); expect(document.querySelector('[role="alert"]')!.textContent).toContain('Fixture draft failure')
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
    expect(document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!.value).toBe('Retry this note')
    await click(button('Add to reply draft')); expect(append).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentComposerDrafts.a).toContain('Note: Retry this note'); expect(document.querySelector('.log-turn__annotation')).toBeNull()
  })
  it('does not submit on Enter/IME, soft-closes on Escape, and preserves the existing pause-for-input side effect', async () => {
    useAppStore.setState({ agentComposerDrafts: { a: '' } })
    await render(pane()); await select(body()); await typeNote()
    const textarea = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    }); await flush()
    expect(document.querySelector('.log-turn__annotation')).not.toBeNull(); expect(useAppStore.getState().agentComposerDrafts.a).toBe('')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await flush()
    expect(document.querySelector('.log-turn__annotation')).toBeNull(); await click(button('Resume note')); await click(button('Add to reply draft'))
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Regarding message "live-original-id":\n> repeated phrase\n\nNote: Keep this exact target')
    expect(api.continuousProgress.pauseForInput).toHaveBeenCalledExactlyOnceWith(agent('a').control)
  })
  it('does not collect selections or alter drafts in readonly projection', async () => {
    await render(pane('a', true)); const collector = vi.spyOn(window, 'getSelection'); collector.mockClear()
    await act(async () => body().dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(collector).toHaveBeenCalledTimes(0); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
  it('keeps readonly History and a no-Composer Activity outside the selection collector', async () => {
    await render(pane('a', true)); read.mockImplementation(async control => page(control.agentSessionId)); await click(button('History', host))
    const collector = vi.spyOn(window, 'getSelection'); collector.mockClear()
    await act(async () => body(host.querySelector('.session-history')!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(collector).toHaveBeenCalledTimes(0); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    await render(<SessionPane sessionId="a" surfaceKind="terminal" interactiveResize={false} visible linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />)
    await click(button('Activity', host)); collector.mockClear()
    await act(async () => body().dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(collector).toHaveBeenCalledTimes(0); expect(document.querySelector('.log-turn__annotation')).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
  it('rejects cross-record and non-body selections rather than citing control labels', async () => {
    const next = timeline('a'); next.items.push({ ...next.items[0]!, id: 'second-record-id', createdAt: 2, updatedAt: 2 })
    useAppStore.setState({ timelines: { a: next } }); await render(pane())
    const records = host.querySelectorAll<HTMLElement>('.log-turn'); expect(records).toHaveLength(2)
    const range = document.createRange(); range.setStart(body(records[0]!).querySelector('p')!.firstChild!, 0); range.setEnd(body(records[1]!).querySelector('p')!.firstChild!, 21)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); expect(selection.toString().length).toBeGreaterThan(0)
    await act(async () => body(records[1]!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush()
    expect(document.querySelector('.log-turn__annotation')).toBeNull()
    const label = records[0]!.querySelector('[title="Copy message"]')!
    range.selectNodeContents(label); selection.removeAllRanges(); selection.addRange(range)
    await act(async () => body(records[0]!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush()
    expect(document.querySelector('.log-turn__annotation')).toBeNull(); expect(useAppStore.getState().agentComposerDrafts.a).toBe('Existing draft\n')
  })
})
