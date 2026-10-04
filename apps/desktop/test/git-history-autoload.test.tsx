const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitHistoryResult, GitHistorySnapshot } from '../src/shared/git-contracts'
import type { WorkspaceRecord } from '../src/shared/contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ config: {}, openGitWorkbench: vi.fn() }) }))
import { useGitHistory } from '../src/renderer/src/hooks/useGitHistory'
import { GitHistoryPanel } from '../src/renderer/src/components/GitHistoryPanel'

const workspace: WorkspaceRecord = { id: 'autoload', hostId: 'local', path: _hygiene_fixturePath("repo"), name: 'Private history', kind: 'folder' }
const oid = (n: number) => n.toString(16).padStart(40, '0')
const snapshot: GitHistorySnapshot = { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), roots: [oid(1)], checkedAt: 1, selectedRef: null,
  refs: [{ kind: 'local', name: 'refs/heads/main', oid: oid(1) }, { kind: 'remote', name: 'refs/remotes/origin/topic', oid: oid(2) }] }
function page(values: number[], next: number | null, scope = snapshot): GitHistoryResult {
  return { kind: 'ready', snapshot: scope, commits: values.map(n => ({ oid: oid(n), subject: `Commit ${n}`, author: 'Private author', authoredAt: 1,
    parents: [oid(n + 1)], refs: scope.refs.filter(ref => ref.oid === oid(n)) })), nextCursor: next === null ? null : { snapshot: scope, offset: next } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { resolve, promise } }

// Browser geometry is supplied explicitly; the production observer callbacks, scroll handler,
// hook, generation, cursor and Desktop bridge run unchanged. Native layout is checked in T005.
class IntersectionProbe {
  static all: IntersectionProbe[] = []
  targets = new Set<Element>()
  disconnected = false
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) { IntersectionProbe.all.push(this) }
  observe(target: Element) { this.targets.add(target) }
  disconnect() { this.disconnected = true }
  fire(intersecting = true) { this.callback([...this.targets].map(target => ({ target, isIntersecting: intersecting } as IntersectionObserverEntry)), this as unknown as IntersectionObserver) }
}
class ResizeProbe {
  static all: ResizeProbe[] = []
  targets = new Set<Element>()
  disconnected = false
  constructor(readonly callback: ResizeObserverCallback) { ResizeProbe.all.push(this) }
  observe(target: Element) { this.targets.add(target) }
  disconnect() { this.disconnected = true }
  fire() { this.callback([], this as unknown as ResizeObserver) }
}
let root: Root, element: HTMLDivElement
let bridge: ReturnType<typeof vi.fn>
let controls: ReturnType<typeof useGitHistory>
let viewport: number, contentHeight: number | null
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
function Owner({ visible, target }: { visible: boolean; target: WorkspaceRecord }) {
  controls = useGitHistory(target, visible)
  return <GitHistoryPanel workspace={target} history={controls} />
}
async function render(visible = true, target = workspace) { await act(async () => root.render(<Owner visible={visible} target={target} />)) }
function rows() { return [...element.querySelectorAll<HTMLElement>('[data-history-oid]')].map(row => row.dataset.historyOid) }
function view() { return element.querySelector<HTMLDivElement>('.git-history-scroll')! }
function observer() {
  const value = [...IntersectionProbe.all].reverse().find(item => !item.disconnected && [...item.targets].some(target => target.classList.contains('git-history-footer')))
  expect(value, 'Production next-page observer is present').toBeDefined()
  return value!
}
async function enterAhead() { await act(async () => observer().fire()) }
async function scroll(top: number) { await act(async () => { view().scrollTop = top; view().dispatchEvent(new Event('scroll', { bubbles: true })) }) }
async function visibility(hidden: boolean) {
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
}
async function select(value: string) { await act(async () => { const picker = element.querySelector<HTMLSelectElement>('select')!; picker.value = value; picker.dispatchEvent(new Event('change', { bubbles: true })) }) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  viewport = 300; contentHeight = 1500
  IntersectionProbe.all = []; ResizeProbe.all = []
  vi.stubGlobal('IntersectionObserver', IntersectionProbe); vi.stubGlobal('ResizeObserver', ResizeProbe)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight ?? rows().length * 24 + 20)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  bridge = vi.fn(); Object.assign(window, { agentmux: { git: { history: bridge } } })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  Object.assign(window, { agentmux: undefined })
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
})

it('prefetches a full viewport before the bottom, deduplicates observer/scroll requests and preserves reading position', async () => {
  viewport = 400; contentHeight = 2000
  const pending = deferred<GitHistoryResult>()
  bridge.mockResolvedValueOnce(page([1, 2, 3], 3)).mockReturnValueOnce(pending.promise)
  await render(); expect(bridge).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: null })
  const firstObserver = observer()
  expect(firstObserver.options.root).toBe(view()); expect(firstObserver.options.rootMargin).toBe('0px 0px 400px 0px')
  await act(async () => firstObserver.fire(false)); await scroll(1100); expect(bridge).toHaveBeenCalledTimes(1)
  await scroll(1200); expect(bridge).toHaveBeenCalledTimes(2)
  expect(view().scrollHeight - view().clientHeight - view().scrollTop).toBe(400)
  expect(bridge.mock.calls[1]).toEqual([workspace.id, { ref: null, cursor: { snapshot, offset: 3 } }])
  await act(async () => { firstObserver.fire(); firstObserver.fire() }); await scroll(1210)
  expect(bridge).toHaveBeenCalledTimes(2)
  contentHeight = 2500; await act(async () => pending.resolve(page([4, 5], 5)))
  expect(view().scrollTop).toBe(1210); expect(rows()).toEqual([1, 2, 3, 4, 5].map(oid))
  await enterAhead(); expect(bridge).toHaveBeenCalledTimes(2)
})

it('automatically fills short first pages without scrolling or clicking and stops beyond the viewport lead', async () => {
  contentHeight = null
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockResolvedValueOnce(page([3, 4], 4))
    .mockResolvedValueOnce(page(Array.from({ length: 22 }, (_, index) => index + 5), 26))
  await render(); expect(rows()).toHaveLength(2)
  await enterAhead(); expect(rows()).toHaveLength(4); expect(bridge).toHaveBeenCalledTimes(2)
  await enterAhead(); expect(rows()).toHaveLength(26); expect(bridge).toHaveBeenCalledTimes(3)
  expect(view().scrollTop).toBe(0); await enterAhead(); expect(bridge).toHaveBeenCalledTimes(3)
  expect(bridge.mock.calls.slice(1).map(call => call[1].cursor.offset)).toEqual([2, 4])
})

it('serializes simultaneous in-range callbacks for the same cursor and stops at the true end', async () => {
  contentHeight = 400
  const pending = deferred<GitHistoryResult>()
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockReturnValueOnce(pending.promise)
  await render(); const current = observer()
  await act(async () => { current.fire(); current.fire(); view().scrollTop = 1; view().dispatchEvent(new Event('scroll', { bubbles: true })) })
  expect(bridge).toHaveBeenCalledTimes(2)
  await act(async () => pending.resolve(page([3], null)))
  await act(async () => current.fire()); await scroll(2)
  expect(bridge).toHaveBeenCalledTimes(2); expect(rows()).toEqual([1, 2, 3].map(oid)); expect(element.querySelector('.git-history-footer button')).toBeNull()
})

it('keeps a failed page readable without an automatic retry loop, and manual retry uses the exact cursor', async () => {
  contentHeight = 400
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockRejectedValueOnce(new Error('Private page unreadable')).mockResolvedValueOnce(page([3, 4], null))
  await render(); const previous = observer(); view().scrollTop = 42; await enterAhead()
  expect(rows()).toEqual([1, 2].map(oid)); expect(view().scrollTop).toBe(42)
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('Private page unreadable')
  await act(async () => { previous.fire(); previous.fire() }); await scroll(43); await scroll(44)
  expect(bridge).toHaveBeenCalledTimes(2)
  await act(async () => element.querySelector<HTMLButtonElement>('.git-history-error button')!.click())
  expect(bridge.mock.calls[2]).toEqual(bridge.mock.calls[1]); expect(rows()).toEqual([1, 2, 3, 4].map(oid)); expect(view().scrollTop).toBe(44)
})

it('disconnects hidden/background observers, rejects their late pages and resumes from the original cursor', async () => {
  contentHeight = 400
  const hidden = deferred<GitHistoryResult>(), background = deferred<GitHistoryResult>()
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockReturnValueOnce(hidden.promise).mockReturnValueOnce(background.promise).mockResolvedValueOnce(page([3], null))
  await render(); const first = observer(); await enterAhead(); await render(false)
  await act(async () => { first.fire(); hidden.resolve(page([8], null)) }); await scroll(30)
  expect(bridge).toHaveBeenCalledTimes(2); expect(rows()).toEqual([1, 2].map(oid))
  await render(); await enterAhead(); await visibility(true)
  await act(async () => background.resolve(page([9], null))); await scroll(40)
  expect(bridge).toHaveBeenCalledTimes(3); expect(rows()).toEqual([1, 2].map(oid))
  await visibility(false); await enterAhead(); expect(rows()).toEqual([1, 2, 3].map(oid))
  expect(bridge.mock.calls.slice(1).every(call => JSON.stringify(call[1]) === JSON.stringify({ ref: null, cursor: { snapshot, offset: 2 } }))).toBe(true)
})

it('rejects obsolete workspace/ref pages and retained old read callbacks before they publish loading', async () => {
  contentHeight = 400
  const old = deferred<GitHistoryResult>(), oldRef = deferred<GitHistoryResult>()
  const nextWorkspace = { ...workspace, id: 'new-workspace', path: _hygiene_fixturePath("new-repo") }
  const nextSnapshot = { ...snapshot, repoPath: _hygiene_fixturePath("new-repo"), roots: [oid(50)] }
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([50], 1, nextSnapshot))
    .mockReturnValueOnce(oldRef.promise).mockResolvedValueOnce(page([60], null, { ...nextSnapshot, roots: [oid(60)] }))
  await render(); const staleLoadMore = controls.loadMore, staleRefresh = controls.refresh; const staleObserver = observer(); await enterAhead(); await render(true, nextWorkspace)
  await act(async () => { staleObserver.fire(); old.resolve(page([8], null)); await staleLoadMore(); await staleRefresh() })
  expect(rows()).toEqual([oid(50)]); expect(bridge).toHaveBeenCalledTimes(3); expect(element.querySelector('section[aria-label="Git history"]')!.getAttribute('aria-busy')).toBe('false')
  await select('refs/remotes/origin/topic'); await select(''); await act(async () => oldRef.resolve(page([9], null)))
  expect(rows()).toEqual([oid(60)]); expect(bridge.mock.calls[4]).toEqual([nextWorkspace.id, { ref: null }])
})

it.each([
  ['repeated commit', page([1], 3), 'repeated an already loaded commit'],
  ['nonadvancing cursor', page([3], 2), 'did not advance'],
  ['empty continuation', page([], 3), 'did not advance']
] satisfies Array<[string, GitHistoryResult, string]>)('halts automatic paging on %s while preserving the last good rows', async (_name, invalid, message) => {
  contentHeight = 400
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockResolvedValueOnce(invalid)
  await render(); const first = observer(); await enterAhead()
  expect(rows()).toEqual([1, 2].map(oid)); expect(element.querySelector('[role="alert"]')?.textContent).toContain(message)
  await act(async () => first.fire()); await scroll(20); expect(bridge).toHaveBeenCalledTimes(2)
})

it('updates the lead when its viewport resizes, with a minimum eight-row lead for short panels', async () => {
  viewport = 80; contentHeight = 1000
  bridge.mockResolvedValueOnce(page([1, 2], 2)).mockResolvedValueOnce(page([3], null))
  await render(); expect(observer().options.rootMargin).toBe('0px 0px 192px 0px')
  await enterAhead(); expect(bridge).toHaveBeenCalledTimes(1)
  viewport = 500
  const resize = [...ResizeProbe.all].reverse().find(item => !item.disconnected && item.targets.has(view()))!
  await act(async () => resize.fire()); expect(observer().options.rootMargin).toBe('0px 0px 500px 0px')
  await enterAhead(); expect(bridge).toHaveBeenCalledTimes(2)
})

it('does not mistake nested scrolling for reading down the History viewport', async () => {
  contentHeight = 400
  bridge.mockResolvedValueOnce(page([1, 2], 2))
  await render(); await act(async () => element.querySelector('.git-history-window')!.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(bridge).toHaveBeenCalledTimes(1)
})
