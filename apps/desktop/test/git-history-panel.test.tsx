const { fixturePath: _hygiene_fixturePath, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import type { GitHistoryCommit, GitHistoryResult, GitHistorySnapshot } from '../src/shared/git-contracts.js'

const fixture = vi.hoisted(() => ({
  state: { localHome: _hygiene_fixturePath("Users/private"), config: { copyPathsAsAbsolute: false, hosts: [{ id: 'local', kind: 'local' }] }, openGitWorkbench: vi.fn() }
}))
vi.mock('../src/renderer/src/store.js', () => ({ useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state) }))
import { GitHistoryPanel } from '../src/renderer/src/components/GitHistoryPanel.js'
import { useGitHistory } from '../src/renderer/src/hooks/useGitHistory.js'
import { speakerColorHue } from '../src/renderer/src/lib/conversation-avatar-color.js'

const oid = (digit: string) => digit.repeat(40)
const a = oid('a'), b = oid('b'), c = oid('c'), d = oid('d'), e = oid('e')
const workspace: WorkspaceRecord = { id: 'repo', hostId: 'local', path: _hygiene_fixturePath("Users/private/project"), name: 'Project', kind: 'folder' }
const snapshot: GitHistorySnapshot = { hostId: 'local', repoPath: workspace.path, selectedRef: null, roots: [a], checkedAt: 1,
  refs: [{ name: 'refs/heads/main', kind: 'local', oid: a }, { name: 'refs/remotes/origin/topic', kind: 'remote', oid: b }, { name: 'HEAD', kind: 'head', oid: a }] }
function commit(id: string, subject: string, parents: string[]): GitHistoryCommit {
  return { oid: id, subject, parents, author: 'History author', authoredAt: _hygiene_fixtureTime(-67225600000), refs: snapshot.refs.filter(ref => ref.oid === id) }
}
function page(commits: GitHistoryCommit[], more = false, scope = snapshot): GitHistoryResult {
  return { kind: 'ready', snapshot: scope, commits, nextCursor: more ? { snapshot: scope, offset: commits.length } : null }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let host: HTMLDivElement, root: Root
let stylesheet: HTMLStyleElement
let history: ReturnType<typeof vi.fn>
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  stylesheet = document.createElement('style')
  stylesheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/git-history.css', 'utf8')
  document.head.append(stylesheet)
  history = vi.fn()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { history } } })
  fixture.state.config.copyPathsAsAbsolute = false
  fixture.state.openGitWorkbench.mockReset()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  stylesheet.remove()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: undefined })
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
})
function HistoryOwner({ workspace, visible }: { workspace: WorkspaceRecord; visible: boolean }) {
  const history = useGitHistory(workspace, visible)
  return createElement(GitHistoryPanel, { workspace, history })
}
async function render(visible = true, value = workspace) { await act(async () => { root.render(createElement(HistoryOwner, { workspace: value, visible })) }) }
async function click(label: string) {
  const target = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)
  expect(target).toBeDefined(); await act(async () => target!.click())
}
async function select(value: string) {
  const element = host.querySelector('select')!; expect(element).not.toBeNull()
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
function rows() { return [...host.querySelectorAll('[data-history-oid]')].map(row => row.getAttribute('data-history-oid')) }

describe('mounted GitHistoryPanel with production hook and bridge', () => {
  it('keeps an unread hidden history pending until Git confirms repository status', async () => {
    history.mockResolvedValueOnce({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
    await render(false)
    expect(history).not.toHaveBeenCalled()
    expect(host.textContent).toContain('History will load when visible')
    expect(host.textContent).not.toContain('Not a Git repository')
    await render(true)
    expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: null })
    expect(host.textContent).toContain('Not a Git repository')
  })

  it('opens the exact fixed commit snapshot on row click/Enter while reference labels keep metadata as their action', async () => {
    history.mockResolvedValue(page([commit(a, 'Selected merge', [b, c]), commit(b, 'Root commit', [])]))
    await render()
    const rendered = [...host.querySelectorAll<HTMLElement>('.git-history-commit')]
    expect(rendered[0]!.getAttribute('role')).toBe('button')
    expect(rendered[0]!.hasAttribute('aria-haspopup')).toBe(false)
    expect(rendered[0]!.getAttribute('aria-label')).toContain('Open commit')
    await act(async () => rendered[0]!.querySelector('strong')!.click())
    expect(fixture.state.openGitWorkbench).toHaveBeenCalledExactlyOnceWith(workspace.id, {
      hostId: snapshot.hostId, repoPath: snapshot.repoPath, commitOid: a, parentOid: b
    })
    await act(async () => rendered[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(fixture.state.openGitWorkbench).toHaveBeenLastCalledWith(workspace.id, {
      hostId: snapshot.hostId, repoPath: snapshot.repoPath, commitOid: b, parentOid: null
    })
    const ref = rendered[0]!.querySelector<HTMLElement>('.git-history-ref')!
    expect(ref.getAttribute('aria-haspopup')).toBe('dialog')
    await act(async () => { ref.focus(); ref.click(); ref.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(fixture.state.openGitWorkbench).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain(a)
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain('refs/heads/main')
  })

  it('reserves only the tracks crossing each row, keeps wide merges reachable and leaves SVG whitespace transparent to reading', async () => {
    const f = oid('f'), g = oid('1')
    history.mockResolvedValue(page([
      commit(a, 'A simple tip before the wide merge', [b]),
      commit(b, 'A merge with four real parents', [c, d, e, f]),
      commit(c, 'First route', [g]), commit(d, 'Second route', [g]),
      commit(e, 'Third route', [g]), commit(f, 'Final route', [g]),
      commit(g, 'Shared root after all lanes have closed', [])
    ]))
    await render()
    const rendered = [...host.querySelectorAll<HTMLElement>('.git-history-commit')]
    expect(rendered.map(row => row.style.getPropertyValue('--history-graph-width'))).toEqual(['20px', '62px', '62px', '62px', '48px', '34px', '20px'])
    expect(host.querySelector('svg[aria-label="Loaded commit graph"]')?.getAttribute('width')).toBe('62')
    expect([...host.querySelectorAll(`[data-child-oid="${b}"]`)].map(edge => edge.getAttribute('data-parent-oid'))).toEqual([c, d, e, f])
    expect(host.querySelector(`[data-child-oid="${b}"][data-parent-oid="${f}"]`)?.getAttribute('d')).toBe('M 10 36 C 10 42, 52 42, 52 48')
    expect(getComputedStyle(host.querySelector('.git-history-window')!).position).toBe('relative')
    const graphStyle = getComputedStyle(host.querySelector('.git-history-graph')!)
    expect(graphStyle.position).toBe('absolute')
    expect(graphStyle.zIndex).toBe('1')
    expect(graphStyle.pointerEvents).toBe('none')
    expect(getComputedStyle(host.querySelector('.git-history-node')!).pointerEvents).toBe('auto')
    expect(getComputedStyle(host.querySelector('.git-history-scroll')!).overflow).toBe('auto')
    // Wider relationships can scroll with their row instead of clipping a fixed graph slot.
    expect(getComputedStyle(rendered[1]!).minWidth).toBe('calc(62px + 120px)')
    expect(getComputedStyle(rendered[0]!).paddingLeft).toBe('calc(20px + var(--sp-2))')
    expect(getComputedStyle(rendered[1]!).containerType).toBe('inline-size')
  })

  it('lets one ref use its available label width while multiple refs shrink without covering the commit title', async () => {
    const single = { name: 'refs/heads/feature/a-long-single-branch-name', kind: 'local' as const, oid: a }
    const second = { name: 'refs/remotes/origin/another-long-name', kind: 'remote' as const, oid: b }
    history.mockResolvedValue(page([{ ...commit(a, 'One reference', [b]), refs: [single] },
      { ...commit(b, 'Two references', []), refs: [{ ...single, oid: b }, second] }]))
    await render()
    const rendered = [...host.querySelectorAll<HTMLElement>('.git-history-commit')]
    expect(rendered.map(row => row.querySelectorAll('.git-history-ref').length)).toEqual([1, 2])
    for (const ref of host.querySelectorAll<HTMLElement>('.git-history-ref')) {
      const style = getComputedStyle(ref)
      expect(style.maxWidth).toBe('100%')
      expect(style.flexShrink).toBe('1')
      expect(style.textOverflow).toBe('ellipsis')
    }
    expect(Number.parseFloat(getComputedStyle(rendered[0]!.querySelector('strong')!).minWidth)).toBe(0)
    await act(async () => rendered[0]!.querySelector<HTMLElement>('.git-history-ref')!.focus())
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain(single.name)
  })

  it('keeps long messages, refs and hashes on one row and exposes complete metadata on hover', async () => {
    const subject = 'Keep a long commit title readable without wrapping or adding another metadata line'
    const first = commit(a, subject, [b])
    const refs = Array.from({ length: 3 }, (_, index) => ({ name: `refs/heads/long-branch-name-${index}`, kind: 'local' as const, oid: a }))
    history.mockResolvedValue(page([{ ...first, refs }, { ...commit(b, '', []), refs: [], authoredAt: null }]))
    await render()
    const rendered = [...host.querySelectorAll<HTMLElement>('.git-history-commit')]
    expect(rendered).toHaveLength(2)
    expect(stylesheet.sheet!.cssRules.length).toBeGreaterThan(0)
    for (const row of rendered) {
      const style = getComputedStyle(row)
      expect(style.display).toBe('flex')
      expect(style.flexDirection).toBe('row')
      expect(style.whiteSpace).toBe('nowrap')
      expect(style.alignItems).toBe('center')
      expect(row.style.height).toBe('24px')
      expect(row.querySelector(':scope > strong')).not.toBeNull()
      expect(row.querySelector(':scope > .git-history-hash')).not.toBeNull()
      expect(row.textContent).not.toContain(first.author)
      expect(row.getAttribute('aria-label')).toContain(row.dataset.historyOid!.slice(0, 7))
      await act(async () => row.focus())
      const detail = document.querySelector('[data-history-detail-oid]')!
      expect(detail).not.toBeNull()
      expect(detail.textContent).toContain(row.dataset.historyOid)
      expect(detail.textContent).toContain(first.author)
      // Disclosure is one accessible reading surface, not competing native titles.
      expect(row.querySelector('strong')?.hasAttribute('title')).toBe(false)
    }
    expect(rendered.map(row => row.children.length)).toEqual([3, 2])
    expect(rendered[0]!.querySelector(':scope > .git-history-refs')?.textContent).toContain('+1')
    await act(async () => rendered[0]!.focus())
    const full = document.querySelector('[data-history-detail-oid]')!
    expect(full.textContent).toContain(subject)
    expect(full.textContent).toContain(new Date(first.authoredAt!).toLocaleString())
    expect([...full.querySelectorAll('.git-history-details__ref')].map(ref => ref.querySelector('code')?.textContent)).toEqual(refs.map(ref => ref.name))
    await act(async () => rendered[1]!.focus())
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain('(No commit message)')
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain('Time unknown')
    expect([...host.querySelectorAll('.git-history-parent')].map(path => path.getAttribute('d'))).toEqual(['M 10 12 C 10 18, 10 18, 10 24'])
    expect([...host.querySelectorAll('.git-history-node')].map(node => Number(node.getAttribute('cy')))).toEqual([12, 36])
  })

  it('draws every actual merge parent and boundary, keeps 219 refs in their picker and formats the exact host path', async () => {
    const refs = Array.from({ length: 219 }, (_, i) => ({ name: `refs/heads/branch-${i}`, kind: 'local' as const, oid: a }))
    const many: GitHistorySnapshot = { ...snapshot, refs: [...refs, ...snapshot.refs] }
    const merge = { ...commit(a, 'Merge both topics', [b, c]), refs }
    history.mockResolvedValue(page([merge, commit(b, 'Topic B', [d]), commit(c, 'Topic C', [d]), commit(e, 'Disconnected root', [])], true, many))
    await render()
    expect(history).toHaveBeenCalledExactlyOnceWith('repo', { ref: null })
    expect(rows()).toEqual([a, b, c, e])
    expect([...host.querySelectorAll(`[data-child-oid="${a}"]`)].map(edge => edge.getAttribute('data-parent-oid'))).toEqual([b, c])
    expect(host.querySelectorAll('[data-commit-oid]')).toHaveLength(4)
    expect(host.querySelector('svg > g:last-of-type')?.querySelectorAll('path')).toHaveLength(1)
    const rootNode = host.querySelector<SVGElement>(`[data-commit-oid="${e}"]`)!
    await act(async () => rootNode.focus())
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain('Root commit')
    expect(host.querySelector(`[data-commit-oid="${e}"]`)?.hasAttribute('data-branch-ref')).toBe(false)
    expect([...host.querySelectorAll('[data-unloaded-parent]')].map(edge => edge.getAttribute('data-unloaded-parent'))).toEqual([d])
    expect(host.querySelectorAll('select option')).toHaveLength(223)
    expect(host.querySelector('select')?.title).toBe('~/project')
    expect(host.querySelector('.git-history-refs')?.textContent).toBe('branch-0branch-1+217')
    await act(async () => host.querySelector<HTMLElement>('.git-history-ref-count')!.focus())
    expect(document.querySelector('[data-history-detail-oid]')?.textContent).toContain(refs[218]!.name)
    expect(host.textContent).toContain('4 commits · 1 parent beyond view')
    fixture.state.config.copyPathsAsAbsolute = true; await render()
    expect(host.querySelector('select')?.title).toBe(_hygiene_fixturePath("Users/private/project"))
  })

  it('appends one explicit page, preserves it across tab hiding, and refresh creates a new snapshot', async () => {
    const first = page([commit(a, 'Merge', [b, c])], true)
    history.mockResolvedValueOnce(first).mockResolvedValueOnce(page([commit(b, 'Topic B', []), commit(c, 'Topic C', [])]))
      .mockResolvedValueOnce(page([commit(e, 'New snapshot', [])], false, { ...snapshot, roots: [e], checkedAt: 2 }))
    await render(); await click('Load more')
    expect(rows()).toEqual([a, b, c]); expect(history.mock.calls[1]).toEqual(['repo', { ref: null, cursor: first.kind === 'ready' ? first.nextCursor : null }])
    await render(false); await render(true)
    expect(rows()).toEqual([a, b, c]); expect(history).toHaveBeenCalledTimes(2)
    await click('Refresh history')
    expect(rows()).toEqual([e]); expect(history).toHaveBeenCalledTimes(3)
  })

  it('keeps real branch guides across pages, shifting lanes and ref order, including both coloured merge routes', async () => {
    const f = oid('f')
    const main = { name: 'refs/heads/main', kind: 'local' as const, oid: a }
    const topic = { name: 'refs/remotes/origin/topic', kind: 'remote' as const, oid: b }
    const sibling = { name: 'refs/heads/z-main', kind: 'local' as const, oid: a }
    const head = { name: 'HEAD', kind: 'head' as const, oid: a }
    const tag = { name: 'refs/tags/release', kind: 'tag' as const, oid: f }
    const side = { name: 'refs/heads/side', kind: 'local' as const, oid: e }
    const scope: GitHistorySnapshot = { ...snapshot, roots: [a, b, e], refs: [sibling, head, topic, main, tag, side] }
    const merge = { ...commit(a, 'Merge topic into main', [c, b]), refs: [main, head, sibling] }
    const sideTip = { ...commit(e, 'Independent side', [f]), refs: [side] }
    const sideRoot = { ...commit(f, 'Side root with a tag', []), refs: [tag] }
    const mainWork = { ...commit(c, 'Main work', [d]), refs: [] }
    const topicWork = { ...commit(b, 'Topic work', [d]), refs: [topic] }
    const shared = { ...commit(d, 'Shared ancestor', []), refs: [] }
    history.mockResolvedValueOnce(page([sideTip, merge, sideRoot], true, scope))
      .mockResolvedValueOnce(page([mainWork, topicWork, shared], false, scope))
      .mockResolvedValueOnce(page([merge, topicWork, mainWork, shared, sideTip, sideRoot], false,
        { ...scope, checkedAt: 2, refs: [...scope.refs].reverse() }))
    const hue = (element: Element | null) => {
      expect(element).not.toBeNull()
      return (element as HTMLElement).style.getPropertyValue('--history-branch-hue')
    }
    const node = (id: string) => host.querySelector(`[data-commit-oid="${id}"]`)
    const edge = (child: string, parent: string) => host.querySelector(`[data-child-oid="${child}"][data-parent-oid="${parent}"]`)
    await render()
    expect(rows()).toEqual([e, a, f])
    const mainHue = String(speakerColorHue(main.name)), topicHue = String(speakerColorHue(topic.name))
    expect(mainHue).not.toBe(topicHue)
    expect(node(a)?.getAttribute('data-branch-ref')).toBe(main.name)
    expect(hue(node(a))).toBe(mainHue)
    expect(node(a)?.getAttribute('cx')).toBe('24')
    expect(hue(edge(a, c))).toBe(mainHue)
    expect(hue(edge(a, b))).toBe(topicHue)
    expect([...host.querySelectorAll('[data-unloaded-parent]')].map(path => path.getAttribute('data-unloaded-parent'))).toEqual([c, b])
    expect(hue(host.querySelector(`[data-unloaded-parent="${c}"]`))).toBe(mainHue)
    expect(hue(host.querySelector(`[data-unloaded-parent="${b}"]`))).toBe(topicHue)
    // The unrelated side root closes a lane: both still-pending branch tracks move left with
    // vertical tangents at each row boundary, rather than kinked diagonal segments.
    const shifted = [...host.querySelectorAll('svg > g:nth-of-type(3) .git-history-track')]
    expect(shifted).toHaveLength(3) // two passing branches and the root's incoming track
    const routes = shifted.filter(path => path.getAttribute('d')?.includes(' C '))
    expect(routes).toHaveLength(2)
    expect(routes.map(path => path.getAttribute('d'))).toEqual(['M 24 48 C 24 60, 10 60, 10 72', 'M 38 48 C 38 60, 24 60, 24 72'])
    expect(routes.map(path => hue(path))).toEqual([mainHue, topicHue])
    await click('Load more')
    expect(rows()).toEqual([e, a, f, c, b, d])
    expect(hue(node(a))).toBe(mainHue)
    expect(hue(node(c))).toBe(mainHue)
    expect(hue(node(b))).toBe(topicHue)
    expect(hue(edge(b, d))).toBe(topicHue)
    expect(hue(edge(c, d))).toBe(mainHue)
    expect(hue(node(d))).toBe(mainHue)
    const refs = [...host.querySelectorAll('.git-history-ref')]
    const labelName = (ref: Element) => / reference (.*)\. Commit /u.exec(ref.getAttribute('aria-label') ?? '')?.[1]
    expect(refs.map(labelName)).toEqual([side.name, main.name, head.name, tag.name, topic.name])
    expect(hue(refs.find(ref => labelName(ref) === main.name) ?? null)).toBe(mainHue)
    expect(hue(refs.find(ref => labelName(ref) === head.name) ?? null)).toBe(mainHue)
    expect(hue(refs.find(ref => labelName(ref) === topic.name) ?? null)).toBe(topicHue)
    expect(refs.find(ref => labelName(ref) === tag.name)?.hasAttribute('data-branch-ref')).toBe(false)
    expect(host.querySelectorAll('.git-history-refs')).toHaveLength(4)
    const rendered = [...host.querySelectorAll<HTMLElement>('.git-history-commit')]
    expect(rendered.map(row => row.style.height)).toEqual(['24px', '24px', '24px', '24px', '24px', '24px'])
    expect(rendered.map(row => row.children.length)).toEqual([3, 3, 3, 2, 3, 2])
    expect(rendered[3]!.querySelector('.git-history-refs')).toBeNull()
    expect(rendered[1]!.querySelector(':scope > .git-history-refs')).not.toBeNull()
    expect([...host.querySelectorAll('.git-history-node')].map(circle => Number(circle.getAttribute('cy')))).toEqual([12, 36, 60, 84, 108, 132])
    expect(host.querySelector('svg[aria-label="Loaded commit graph"]')?.getAttribute('height')).toBe('144')
    await click('Refresh history')
    expect(rows()).toEqual([a, b, c, d, e, f])
    expect(node(a)?.getAttribute('cx')).toBe('10')
    expect(hue(node(a))).toBe(mainHue)
    expect(hue(node(b))).toBe(topicHue)
    expect(hue(node(d))).toBe(mainHue)
    expect(hue(edge(a, b))).toBe(topicHue)
  })

  it('discards old workspace and old selected-reference responses instead of crossing scopes', async () => {
    const old = deferred<GitHistoryResult>(), remote = deferred<GitHistoryResult>()
    history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([commit(e, 'New workspace', [])]))
      .mockReturnValueOnce(remote.promise).mockResolvedValueOnce(page([commit(d, 'Selected local', [])], false, { ...snapshot, selectedRef: 'refs/heads/main', roots: [a] }))
    await render(); await render(true, { ...workspace, id: 'other' })
    expect(rows()).toEqual([e])
    await act(async () => old.resolve(page([commit(a, 'Late old workspace', [])])))
    expect(rows()).toEqual([e]); expect(host.textContent).not.toContain('Late old workspace')
    await select('refs/remotes/origin/topic'); await select('refs/heads/main')
    expect(rows()).toEqual([d])
    await act(async () => remote.resolve(page([commit(b, 'Late remote', [])], false, { ...snapshot, selectedRef: 'refs/remotes/origin/topic', roots: [b] })))
    expect(rows()).toEqual([d]); expect(host.textContent).not.toContain('Late remote')
    expect(history.mock.calls.map(call => call[0])).toEqual(['repo', 'other', 'other', 'other'])
    await select(''); expect(history.mock.calls.at(-1)?.[1]).toEqual({ ref: null })
  })

  it('invalidates pending pages while a tab or document is hidden, retains completed pages and allows a bounded retry', async () => {
    const late = deferred<GitHistoryResult>(), background = deferred<GitHistoryResult>()
    history.mockResolvedValueOnce(page([commit(a, 'Loaded merge', [b, c])], true)).mockReturnValueOnce(late.promise)
      .mockReturnValueOnce(background.promise).mockResolvedValueOnce(page([commit(b, 'Visible page', [])]))
    await render(); await click('Load more'); await render(false)
    await act(async () => late.resolve(page([commit(b, 'Late hidden page', [])])))
    await render(true); expect(rows()).toEqual([a]); expect(history).toHaveBeenCalledTimes(2)
    await click('Load more')
    await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => background.resolve(page([commit(c, 'Late background page', [])])))
    expect(rows()).toEqual([a])
    await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
    expect(history).toHaveBeenCalledTimes(3)
    await click('Load more'); expect(rows()).toEqual([a, b]); expect(history).toHaveBeenCalledTimes(4)
  })

  it('invalidates a rebound path or host even when the Workspace id stays the same', async () => {
    const old = deferred<GitHistoryResult>()
    const rebound = { ...workspace, path: _hygiene_fixturePath("Users/private/rebound"), hostId: 'remote' }
    history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([commit(e, 'Rebound repository', [])], false,
      { ...snapshot, hostId: 'remote', repoPath: rebound.path, roots: [e] }))
    await render(); await render(true, rebound)
    expect(rows()).toEqual([e]); expect(history.mock.calls.map(call => call[0])).toEqual(['repo', 'repo'])
    await act(async () => old.resolve(page([commit(a, 'Late previous path', [])])))
    expect(rows()).toEqual([e]); expect(host.textContent).not.toContain('Late previous path')
    expect(host.querySelector('select')?.title).toBe(_hygiene_fixturePath("Users/private/rebound"))
  })

  it('shows loading, successful empty, nonrepository, unavailable and errors without creating a root or dropping completed pages', async () => {
    const pending = deferred<GitHistoryResult>()
    history.mockReturnValueOnce(pending.promise)
    await render(); expect(host.textContent).toContain('Reading history…'); expect(rows()).toEqual([])
    await act(async () => pending.resolve(page([])))
    expect(host.textContent).toContain('No commits yet'); expect(host.querySelector('svg[role="img"]')).toBeNull()
    history.mockResolvedValueOnce({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
    await click('Refresh history'); expect(host.textContent).toContain('Not a Git repository')
    history.mockRejectedValueOnce(new Error('History objects unreadable'))
    await click('Refresh history'); expect(host.querySelector('[role="alert"] > span')?.textContent).toBe('History objects unreadable')
    history.mockResolvedValueOnce(page([commit(a, 'Keep loaded commit', [b])], true)).mockRejectedValueOnce(new Error('Page failed'))
    await click('Refresh history'); await click('Load more'); expect(rows()).toEqual([a]); expect(host.textContent).toContain('Page failed')
    Object.defineProperty(window, 'agentmux', { configurable: true, value: undefined })
    await click('Refresh history'); expect(rows()).toEqual([a]); expect(host.textContent).toContain('Git is unavailable in this build.')
  })

  it('does not start reads before visible, restarts a canceled initial read, and reports repeated page data without duplicating commits', async () => {
    const canceled = deferred<GitHistoryResult>()
    history.mockReturnValueOnce(canceled.promise).mockResolvedValueOnce(page([commit(a, 'Visible commit', [b])], true))
      .mockResolvedValueOnce(page([commit(a, 'Invalid duplicate', [b])]))
    await render(false); expect(history).not.toHaveBeenCalled()
    await render(true); await render(false)
    await act(async () => canceled.resolve(page([commit(e, 'Canceled initial', [])])))
    await render(true); expect(rows()).toEqual([a]); expect(history).toHaveBeenCalledTimes(2)
    await click('Load more'); expect(rows()).toEqual([a]); expect(host.textContent).toContain('repeated an already loaded commit')
  })
})
