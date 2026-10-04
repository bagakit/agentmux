const { fixturePath: _hygiene_fixturePath, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ComputePositionReturn } from '@floating-ui/dom'
const positioning = vi.hoisted(() => ({ pending: null as Promise<ComputePositionReturn> | null }))
vi.mock('@floating-ui/dom', async importOriginal => {
  const original = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...original, computePosition: (...args: Parameters<typeof original.computePosition>) => positioning.pending ?? original.computePosition(...args) }
})
import type { GitHistoryCommit, GitHistoryResult, GitHistorySnapshot } from '../src/shared/git-contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/hooks/useWorkspaceBranches', () => ({ useWorkspaceBranches: () => ({ snapshot: null, loading: false, error: null, refresh: async () => true }) }))
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, loading: false, error: null, refresh: async () => true }) }))
vi.mock('../src/renderer/src/hooks/useGitAheadBehind', () => ({ useGitAheadBehind: () => ({ facts: null }) }))
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workspace = { id: 'one', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' as const }
const oid = (n: number) => n.toString(16).padStart(40, '0')
const refs = [
  { name: 'refs/heads/feature/readable-history-with-a-long-name', kind: 'local' as const, oid: oid(1) },
  { name: 'refs/remotes/origin/review', kind: 'remote' as const, oid: oid(1) },
  { name: 'HEAD', kind: 'head' as const, oid: oid(1) },
  { name: 'refs/tags/preview', kind: 'tag' as const, oid: oid(1) }
]
const snapshot: GitHistorySnapshot = { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), selectedRef: null, roots: [oid(1)], refs, checkedAt: 1 }
const commit = (n: number): GitHistoryCommit => ({ oid: oid(n), subject: `Keep the full title readable for commit ${n}`, author: 'History author',
  authoredAt: _hygiene_fixtureTime(-67225600000), parents: n === 1 ? [oid(2), oid(3)] : [oid(n + 1)], refs: refs.filter(ref => ref.oid === oid(n)) })
const page = (values: number[], next: number | null, scope = snapshot): GitHistoryResult => ({ kind: 'ready', snapshot: scope,
  commits: values.map(commit), nextCursor: next === null ? null : { snapshot: scope, offset: next } })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let history: ReturnType<typeof vi.fn>, sheet: HTMLStyleElement
const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('[data-history-oid]')]
const scroll = () => dom.container.querySelector<HTMLElement>('.git-history-scroll')!
const details = () => document.querySelector<HTMLElement>('[role="dialog"][data-history-detail-oid]')
const wait = async (ms = 250) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const enter = async (node: Element) => act(async () => { node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
const leave = async (node: Element, relatedTarget: EventTarget | null = null) => act(async () => { node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget })) })
const select = async (value: string) => act(async () => { const picker = dom.container.querySelector('select')!; picker.value = value; picker.dispatchEvent(new Event('change', { bubbles: true })) })
const scrollTo = async (top: number) => act(async () => { const host = scroll(); expect(host).not.toBeNull(); host.scrollTop = top; host.dispatchEvent(new Event('scroll', { bubbles: true })) })
const hideDocument = async (hidden: boolean) => act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
async function render(visible = true, value = workspace) { await dom.render(<SurfaceToolDock workspace={value} visible={visible} />) }
async function open() { await render(); await dom.click('[data-git-view="history"]'); expect(rows().length).toBeGreaterThan(0) }
async function retry() { const button = dom.container.querySelector<HTMLButtonElement>('.git-history-error button') ?? dom.container.querySelector<HTMLButtonElement>('.git-history-footer button'); expect(button).not.toBeNull(); await act(async () => button!.click()) }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  positioning.pending = null
  history = vi.fn(); Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { history } } })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, activeWorkspaceId: workspace.id,
    workspaceTool: 'files-branches', projectRailOpen: true, explorerCollapsed: { one: true }, tabs: {}, layouts: {} })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1500)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(180, 100, 300, 24))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function () { return [this.getBoundingClientRect()] as unknown as DOMRectList })
  sheet = document.createElement('style'); sheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/git-history.css', 'utf8'); document.head.append(sheet)
})
afterEach(() => {
  sheet.remove(); vi.useRealTimers()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: undefined })
  if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
  else Reflect.deleteProperty(document, 'visibilityState')
})

describe('Git History reading through the production SurfaceToolDock and hook', () => {
  it('loads exactly the next pinned page on a real downward scroll, retains position, and serializes repeated scrolls', async () => {
    const pending = deferred<GitHistoryResult>()
    history.mockResolvedValueOnce(page([1, 2, 3], 3)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([6, 7], null))
    await open(); await wait(); expect(history).toHaveBeenCalledExactlyOnceWith('one', { ref: null })
    await scrollTo(300); expect(history).toHaveBeenCalledTimes(1)
    await scrollTo(1150); expect(history).toHaveBeenCalledTimes(2)
    expect(history.mock.calls[1]![1]).toEqual({ ref: null, cursor: { snapshot, offset: 3 } })
    await scrollTo(1170); await scrollTo(1190); expect(history).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve(page([4, 5], 5)))
    expect(rows().map(row => row.dataset.historyOid)).toEqual([1, 2, 3, 4, 5].map(oid))
    expect(scroll().scrollTop).toBe(1190); await wait(); expect(history).toHaveBeenCalledTimes(2)
    await scrollTo(1180); expect(history).toHaveBeenCalledTimes(2)
    await scrollTo(1200); expect(history).toHaveBeenCalledTimes(3)
    expect(history.mock.calls[2]![1]).toEqual({ ref: null, cursor: { snapshot, offset: 5 } })
    expect(rows().map(row => row.dataset.historyOid)).toEqual([1, 2, 3, 4, 5, 6, 7].map(oid))
    await scrollTo(1201); expect(history).toHaveBeenCalledTimes(3)
    expect(rows().map(row => row.style.height)).toEqual(Array(7).fill('24px'))
    expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
  })

  it('stops automatic retries after failure, keeps loaded rows and retries the exact cursor only on explicit action', async () => {
    history.mockResolvedValueOnce(page([1, 2], 2)).mockRejectedValueOnce(new Error('Older history is unreadable'))
      .mockResolvedValueOnce(page([3, 4], 4)).mockResolvedValueOnce(page([5], null))
    await open(); await scrollTo(1150)
    expect(rows().map(row => row.dataset.historyOid)).toEqual([oid(1), oid(2)])
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Older history is unreadable')
    await scrollTo(1170); await wait(); expect(history).toHaveBeenCalledTimes(2)
    await retry(); expect(history).toHaveBeenCalledTimes(3)
    expect(history.mock.calls[2]).toEqual(history.mock.calls[1])
    expect(rows().map(row => row.dataset.historyOid)).toEqual([1, 2, 3, 4].map(oid))
    await scrollTo(1200); expect(history).toHaveBeenCalledTimes(4)
    expect(rows().map(row => row.dataset.historyOid)).toEqual([1, 2, 3, 4, 5].map(oid))
  })

  it('uses the existing hidden/background/scope owner for automatic reads and rejects their late pages', async () => {
    const hidden = deferred<GitHistoryResult>(), oldRef = deferred<GitHistoryResult>()
    history.mockResolvedValueOnce(page([1, 2], 2)).mockReturnValueOnce(hidden.promise).mockReturnValueOnce(oldRef.promise)
      .mockResolvedValueOnce(page([9], null, { ...snapshot, selectedRef: refs[1]!.name, roots: [oid(9)] }))
    await open(); await scrollTo(1150); await render(false)
    await act(async () => hidden.resolve(page([3], null)))
    await scrollTo(1170); expect(history).toHaveBeenCalledTimes(2); expect(rows().map(row => row.dataset.historyOid)).toEqual([oid(1), oid(2)])
    await render(); await hideDocument(true); await scrollTo(1190); expect(history).toHaveBeenCalledTimes(2)
    await hideDocument(false); await scrollTo(1200); expect(history).toHaveBeenCalledTimes(3)
    await select(refs[1]!.name); expect(rows().map(row => row.dataset.historyOid)).toEqual([oid(9)])
    await act(async () => oldRef.resolve(page([3], null)))
    expect(rows().map(row => row.dataset.historyOid)).toEqual([oid(9)])
    expect(history.mock.calls[3]![1]).toEqual({ ref: refs[1]!.name })
  })

  it('discloses complete real metadata, accepts pointer entry and selection, and leaves the original row single-line', async () => {
    const ready = page([1, 2], null); history.mockResolvedValue(ready)
    await open(); const row = rows()[0]!; await enter(row); expect(details()).toBeNull(); await wait()
    const surface = details()!; expect(surface).not.toBeNull(); expect(document.querySelectorAll('[role="dialog"][data-history-detail-oid]')).toHaveLength(1)
    const first = commit(1)
    for (const value of [first.subject, first.oid, first.author, ...first.parents, ...refs.flatMap(ref => [ref.name, ref.oid])]) expect(surface.textContent).toContain(value)
    expect(surface.textContent).toMatch(/Local/iu); expect(surface.textContent).toMatch(/Remote/iu); expect(surface.textContent).toMatch(/Tag/iu); expect(surface.textContent).toContain('HEAD')
    expect(surface.textContent).toContain(new Date(first.authoredAt!).toLocaleString())
    expect(surface.textContent).not.toMatch(/belongs to|only branch|contained in/iu)
    expect(row.getAttribute('aria-controls')).toBe(surface.id)
    expect(getComputedStyle(surface).userSelect).toBe('text')
    await leave(row, surface); await enter(surface); await wait(400); expect(details()).toBe(surface)
    const range = document.createRange(); range.selectNodeContents(surface); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    expect(document.getSelection()!.toString()).toContain(first.oid)
    await act(async () => surface.dispatchEvent(new Event('scroll', { bubbles: true }))); expect(details()).toBe(surface)
    expect(history).toHaveBeenCalledTimes(1); expect(rows().map(row => row.style.height)).toEqual(['24px', '24px'])
    await leave(surface); await wait(400); expect(details()).toBeNull()
    await act(async () => row.focus()); expect(details()).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(details()).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('opens the correct node/reference facts, reports unknown time, and invalidates old details on scroll, snapshot or hidden state', async () => {
    const initial = page([1, 2], null) as Extract<GitHistoryResult, { kind: 'ready' }>; initial.commits[0]!.authoredAt = null
    history.mockResolvedValueOnce(initial).mockResolvedValueOnce(page([1, 2], null, { ...snapshot, checkedAt: 2 }))
    await open(); const node = dom.container.querySelector(`[data-commit-oid="${oid(1)}"]`)!
    await enter(node); await wait(); expect(details()).not.toBeNull(); expect(details()!.textContent).toContain(oid(1)); expect(details()!.textContent).toMatch(/unknown/iu)
    await scrollTo(100); expect(details()).toBeNull()
    await enter(rows()[0]!.querySelector('.git-history-ref')!); await wait(); expect(details()!.textContent).toContain(refs[0]!.name)
    await dom.click('[aria-label="Refresh history"]'); expect(details()).toBeNull()
    await act(async () => rows()[0]!.focus()); expect(details()).not.toBeNull()
    await hideDocument(true); expect(details()).toBeNull()
    await enter(rows()[0]!); await wait(); expect(details()).toBeNull()
    await hideDocument(false); await act(async () => rows()[1]!.focus()); expect(details()).not.toBeNull()
    await render(false); expect(details()).toBeNull()
  })

  it('cancels a delayed hover and ignores async positioning after its surface is dismissed', async () => {
    history.mockResolvedValue(page([1, 2], null)); await open()
    await enter(rows()[0]!); await render(false); await wait(); expect(details()).toBeNull()
    await render(); const position = deferred<ComputePositionReturn>()
    positioning.pending = position.promise
    await enter(rows()[0]!); await wait(); const old = details()!; expect(old).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(details()).toBeNull()
    const before = old.style.cssText
    await act(async () => position.resolve({ x: 1, y: 1, strategy: 'fixed', placement: 'right', middlewareData: {} }))
    expect(old.style.cssText).toBe(before); expect(details()).toBeNull(); expect(history).toHaveBeenCalledTimes(1)
  })
})
