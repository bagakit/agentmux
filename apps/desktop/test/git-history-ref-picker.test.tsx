// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath, fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useState } from 'react'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import type { GitHistoryRef, GitHistoryResult, GitHistorySnapshot } from '../src/shared/git-contracts'
import { GitService } from '../src/main/git-service'
import { GitHistoryRefPicker } from '../src/renderer/src/features/git/history/GitHistoryRefPicker'
import { GitHistoryPanel } from '../src/renderer/src/features/git/history/GitHistoryPanel'
import { useGitHistory } from '../src/renderer/src/features/git/history/useGitHistory'
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { selectHistoryReference } from './helpers/git-history-reference'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ config: {} }) }))

const oid = (index: number) => index.toString(16).padStart(40, '0')
const refs: GitHistoryRef[] = [
  ...Array.from({ length: 500 }, (_, index) => ({ name: `refs/heads/topic-${String(index).padStart(3, '0')}`, kind: 'local' as const, oid: oid(index + 1) })),
  { name: 'refs/heads/origin/main', kind: 'local', oid: oid(1) },
  { name: 'refs/remotes/origin/main', kind: 'remote', oid: oid(1) },
  { name: 'HEAD', kind: 'head', oid: oid(1) },
  { name: 'refs/tags/release-only', kind: 'tag', oid: oid(1) }
]
let host: HTMLDivElement, root: Root
const roots: string[] = []
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="History reference"]')!
const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!
const popup = () => document.querySelector<HTMLElement>('[aria-label="History references"]')
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"][data-value]')]
async function key(key: string, extra: KeyboardEventInit = {}) {
  const input = search()
  expect(input, 'The reference search must remain open until an explicit unmodified confirmation').not.toBeNull()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })))
}
async function query(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), value)
    search().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open() { await act(async () => trigger().click()) }
async function mount({ reference = null, targetRefs = refs, enabled = true, scope = 'original' }: {
  reference?: string | null; targetRefs?: GitHistoryRef[]; enabled?: boolean; scope?: string
} = {}) {
  const changed = vi.fn(), submitted = vi.fn()
  function Owner() {
    const [value, setValue] = useState(reference)
    return <form onSubmit={event => { event.preventDefault(); submitted() }}>
      <GitHistoryRefPicker refs={targetRefs} reference={value} enabled={enabled} scope={scope} onSelect={value => { changed(value); setValue(value) }} />
    </form>
  }
  await act(async () => root.render(<Owner />))
  return { changed, submitted }
}
beforeEach(() => {
  installGitHistoryViewport()
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.classList.contains('git-history-ref-picker__results') ? 264 : this.classList.contains('git-history-scroll') ? 300 : 44
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.classList.contains('git-history-ref-picker__results') ? 264 : 300
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    return Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? '') || 0
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  Object.assign(window, { agentmux: undefined })
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

it('searches the complete observed ref set with a bounded viewport, full counts and no hidden tag roots', async () => {
  const { changed } = await mount()
  await open()
  expect(popup()!.closest('[data-overlay-host]')).not.toBeNull()
  expect(document.activeElement).toBe(search())
  expect(popup()!.textContent).toContain('503 / 503 snapshot references')
  expect(choices().length).toBeGreaterThan(1)
  expect(choices().length).toBeLessThan(25)
  expect(choices()[0]!.dataset.value).toBe('')
  expect(choices().at(-1)!.getAttribute('aria-setsize')).toBe('504')
  await query('  TOPIC-499  ')
  expect(popup()!.textContent).toContain('1 / 503 snapshot references')
  expect(choices().map(option => option.dataset.value)).toEqual(['refs/heads/topic-499'])
  await query('origin/main')
  expect(choices().map(option => option.dataset.value)).toEqual(['refs/heads/origin/main', 'refs/remotes/origin/main'])
  expect(choices().map(option => option.querySelector('.git-history-ref-picker__kind')!.textContent)).toEqual(['Local', 'Remote'])
  expect(choices().map(option => option.title)).toEqual(['refs/heads/origin/main', 'refs/remotes/origin/main'])
  await query('HEAD')
  await key('ArrowDown'); await key('End')
  expect(choices().some(option => option.dataset.value === 'HEAD' && option.textContent!.includes('HEAD'))).toBe(true)
  await query('release-only')
  expect(choices()).toHaveLength(0)
  expect(popup()!.textContent).toContain('0 / 503 snapshot references')
  expect(popup()!.textContent).toContain('No matching references.')
  expect(popup()!.textContent).not.toContain('No commits')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear reference search"]')!.click())
  expect(search().value).toBe(''); expect(document.activeElement).toBe(search())
  expect(popup()!.textContent).toContain('503 / 503 snapshot references')
  expect(changed).not.toHaveBeenCalled()
  await key('Escape')
  expect(popup()).toBeNull(); expect(document.activeElement).toBe(trigger()); expect(trigger().dataset.value).toBe('')
})

it('reaches the final unfiltered ref by keyboard without truncating the result set or submitting its form', async () => {
  const { changed, submitted } = await mount()
  await open(); await key('Enter')
  expect(changed).not.toHaveBeenCalled()
  await key('ArrowDown'); await key('End')
  expect(choices().some(option => option.dataset.value === 'HEAD')).toBe(true)
  expect(choices().length).toBeLessThan(25)
  expect(document.getElementById(search().getAttribute('aria-activedescendant')!)?.dataset.value).toBe('HEAD')
  await key('Enter')
  expect(changed).toHaveBeenCalledExactlyOnceWith('HEAD')
  expect(submitted).not.toHaveBeenCalled(); expect(popup()).toBeNull(); expect(document.activeElement).toBe(trigger())
})

it('scrolls to the last refs and confirms their exact original full identity with pointer input', async () => {
  const { changed } = await mount()
  await open()
  await act(async () => {
    const view = document.querySelector<HTMLElement>('.git-history-ref-picker__results')!
    view.scrollTop = 504 * 44 - 264; view.dispatchEvent(new Event('scroll'))
  })
  const last = choices().find(option => option.dataset.value === 'refs/remotes/origin/main')!
  expect(last).toBeDefined(); expect(choices().length).toBeLessThan(25)
  await act(async () => last.click())
  expect(changed).toHaveBeenCalledExactlyOnceWith('refs/remotes/origin/main')
  expect(trigger().textContent).toContain('Remote'); expect(popup()).toBeNull()
})

it('does not let IME, modified keys or modified clicks choose a reference', async () => {
  const { changed, submitted } = await mount()
  await open(); await query('topic-499'); await key('ArrowDown')
  await act(async () => search().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await key('Enter'); await key('Escape')
  expect(popup()).not.toBeNull(); expect(changed).not.toHaveBeenCalled()
  await act(async () => search().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await key('Enter', { isComposing: true }); await key('Enter', { keyCode: 229 })
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    await key('Enter', { [modifier]: true })
    await act(async () => choices()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, [modifier]: true })))
  }
  expect(changed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled()
  await key('Enter')
  expect(changed).toHaveBeenCalledExactlyOnceWith('refs/heads/topic-499')
})

it('focuses search after its floating surface becomes visible rather than focusing a hidden input', async () => {
  const nativeFocus = HTMLElement.prototype.focus
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (options) {
    if (this.closest<HTMLElement>('.git-history-ref-picker__popover')?.style.visibility === 'hidden') return
    nativeFocus.call(this, options)
  })
  await mount()
  await act(async () => trigger().focus())
  await open()
  await vi.waitFor(() => expect(document.activeElement).toBe(search()))
  expect(popup()?.style.visibility).toBe('visible')
})

it('keeps a missing saved reference without silently selecting another ref and closes when its scope is hidden or rebound', async () => {
  const missing = 'refs/heads/saved-original', changed = vi.fn()
  const render = async (enabled: boolean, scope: string) => act(async () => root.render(
    <GitHistoryRefPicker refs={refs} reference={missing} enabled={enabled} scope={scope} onSelect={changed} />))
  await render(true, 'first'); await open()
  expect(trigger().dataset.value).toBe(missing)
  expect(popup()!.textContent).toContain('Saved reference not in the current observation: ' + missing)
  expect(choices().filter(option => option.getAttribute('aria-selected') === 'true')).toHaveLength(0)
  await key('Enter'); expect(changed).not.toHaveBeenCalled()
  await act(async () => search().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await render(false, 'first'); expect(popup()).toBeNull(); expect(trigger().dataset.value).toBe(missing)
  await render(true, 'first'); await open(); await render(true, 'second')
  expect(popup()).toBeNull(); expect(changed).not.toHaveBeenCalled()
  await open(); await query('topic-499'); await key('ArrowDown'); await key('Enter')
  expect(changed).toHaveBeenCalledExactlyOnceWith('refs/heads/topic-499')
})

it('dismisses outside the floating surface without stealing focus or changing the saved scope', async () => {
  const { changed } = await mount({ reference: 'HEAD' })
  await open()
  const outside = document.createElement('button'); host.append(outside)
  await act(async () => outside.focus())
  expect(popup()).toBeNull(); expect(document.activeElement).toBe(outside)
  expect(trigger().dataset.value).toBe('HEAD'); expect(changed).not.toHaveBeenCalled()
})

it('keeps the original history snapshot, loaded pages and scroll during search, then reads one selected ref without an All cursor', async () => {
  const workspace: WorkspaceRecord = { id: 'picker', hostId: 'local', path: _tailFixturePath("private-history-fixture"), name: 'Private', kind: 'folder' }
  const snapshot: GitHistorySnapshot = { hostId: workspace.hostId, repoPath: workspace.path, selectedRef: null, roots: [oid(1)], refs, checkedAt: _tailFixtureEpoch(0, 0, 1) }
  const first: GitHistoryResult = { kind: 'ready', snapshot, commits: Array.from({ length: 100 }, (_, index) => ({
    oid: oid(index + 1), parents: [oid(index + 2)], subject: 'Loaded commit ' + index, author: 'Private', authoredAt: null, refs: []
  })), nextCursor: { snapshot, offset: 100 } }
  const history = vi.fn().mockResolvedValueOnce(first).mockImplementation(async (_workspace, input) => ({ ...first,
    snapshot: { ...snapshot, selectedRef: input.ref, roots: [oid(500)], checkedAt: _tailFixtureEpoch(0, 0, 2) }, commits: [], nextCursor: null }))
  Object.assign(window, { agentmux: { git: { history } } })
  let current!: ReturnType<typeof useGitHistory>
  function Owner() { current = useGitHistory(workspace, true); return <GitHistoryPanel workspace={workspace} history={current} onSelectCommit={() => {}} /> }
  await act(async () => root.render(<Owner />))
  const view = host.querySelector<HTMLElement>('.git-history-scroll')!
  await act(async () => { view.scrollTop = 240; view.dispatchEvent(new Event('scroll')) })
  const original = current.result
  await open(); await query('topic-499')
  expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: null })
  expect(current.result).toBe(original); expect(view.scrollTop).toBe(240)
  await key('Escape')
  expect(current.result).toBe(original); expect(view.scrollTop).toBe(240)
  await selectHistoryReference(host, 'refs/heads/topic-499')
  expect(history).toHaveBeenCalledTimes(2)
  expect(history).toHaveBeenLastCalledWith(workspace.id, { ref: 'refs/heads/topic-499' })
  expect(current.reference).toBe('refs/heads/topic-499')
  expect(current.result?.kind === 'ready' && current.result.snapshot.selectedRef).toBe('refs/heads/topic-499')
})

it('directly reads an old main tip from hundreds of actual Git refs through the production picker, hook and Main Git owner', async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-ref-picker-'))); roots.push(path)
  const execution = new LocalExecutionHost()
  const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
  const git = async (...args: string[]) => {
    const result = await execution.run('git', ['-C', path, ...args], options)
    expect(result.exitCode, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Private Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await git('commit', '--allow-empty', '-m', 'Original main')
  const main = await git('rev-parse', 'HEAD'), tree = await git('rev-parse', 'HEAD^{tree}')
  let tip = main
  for (let index = 0; index < 70; index++) tip = await git('commit-tree', tree, '-p', tip, '-m', 'Advanced topic ' + index)
  const updated = await execution.run('git', ['-C', path, 'update-ref', '--stdin'], { ...options,
    input: [...Array.from({ length: 500 }, (_, index) => `create refs/heads/topic-${index} ${tip}`),
      `create refs/remotes/origin/main ${main}`, `create refs/tags/decoration ${main}`].join('\n') + '\n' })
  expect(updated.exitCode, updated.stderr).toBe(0)
  await writeFile(join(path, 'kept-untracked.txt'), 'Original user evidence')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'repo', hostId: 'local', path, name: 'Private', kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const service = new GitService(() => execution)
  const history = vi.fn((workspaceId, input) => service.history(workspaceId, input, config))
  const run = vi.spyOn(execution, 'run')
  Object.assign(window, { agentmux: { git: { history } } })
  let current!: ReturnType<typeof useGitHistory>
  function Owner() { current = useGitHistory(config.workspaces[0]!, true); return <GitHistoryPanel workspace={config.workspaces[0]!} history={current} onSelectCommit={() => {}} /> }
  await act(async () => root.render(<Owner />))
  await act(async () => { await history.mock.results[0]!.value })
  expect(current.result?.kind).toBe('ready')
  expect(current.result?.kind === 'ready' && current.result.commits).toHaveLength(50)
  expect(current.result?.kind === 'ready' && current.result.commits.some(commit => commit.oid === main)).toBe(false)
  await selectHistoryReference(host, 'refs/heads/main')
  await act(async () => { await history.mock.results[1]!.value })
  expect(current.result?.kind === 'ready' && current.result.snapshot.selectedRef).toBe('refs/heads/main')
  expect(history).toHaveBeenCalledTimes(2)
  expect(history).toHaveBeenLastCalledWith('repo', { ref: 'refs/heads/main' })
  expect(current.result?.kind === 'ready' && current.result.commits.map(commit => commit.oid)).toEqual([main])
  expect(run.mock.calls.length).toBeGreaterThan(0)
  expect(run.mock.calls.some(([, args]) => args.some(value => ['fetch', 'checkout', 'switch', 'add', 'commit', 'update-ref'].includes(value)))).toBe(false)
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(await readFile(join(path, 'kept-untracked.txt'), 'utf8')).toBe('Original user evidence')
}, 20_000)


it('themes only the original selected reference mark and retains its portal, row and exact selection action', async () => {
  const release = mountThemeRuntime(window, { themeId: 'graphite', appAppearance: 'light' })
  try {
    const originalRefs = refs.filter(ref => ['refs/heads/origin/main', 'refs/remotes/origin/main', 'HEAD'].includes(ref.name))
    const { changed, submitted } = await mount({ reference: 'refs/heads/origin/main', targetRefs: originalRefs })
    await open()
    const originalPopup = popup()!, originalInput = search(), options = choices()
    expect(options).toHaveLength(4)
    const selected = options.find(option => option.dataset.value === 'refs/heads/origin/main')!, other = options.find(option => option.dataset.value === 'refs/remotes/origin/main')!
    const svg = selected.querySelector<SVGSVGElement>('svg[data-semantic-icon="status.selected"]')!
    expect(svg, 'the original selected reference uses the Selected role').not.toBeNull()
    expect(svg.getAttribute('width')).toBe('12'); expect(svg.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref('status.selected'))
    expect(selected.getAttribute('aria-selected')).toBe('true'); expect(other.getAttribute('aria-selected')).toBe('false')
    expect(options.filter(option => option.querySelector('[data-semantic-icon="status.selected"]'))).toEqual([selected])
    const theme = { ...structuredClone(GRAPHITE_THEME), id: 'custom.history-selection', name: 'Independent reference selection', icons: {
      'status.selected': { kind: 'paths' as const, paths: [{ d: 'M3 12L12 3L21 12L12 21Z' }] },
      'navigation.back': { kind: 'paths' as const, paths: [{ d: 'M4 4H20V20H4Z' }] }
    } }
    await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
    expect(popup()).toBe(originalPopup); expect(search()).toBe(originalInput); expect(choices()).toEqual(options)
    expect(selected.querySelector('svg[data-semantic-icon="status.selected"]')).toBe(svg)
    expect(document.getElementById(semanticIconHref('status.selected').slice(1))!.querySelector('path')!.getAttribute('d')).toBe(theme.icons['status.selected'].paths[0]!.d)
    expect(document.getElementById(semanticIconHref('navigation.back').slice(1))!.querySelector('path')!.getAttribute('d')).toBe(theme.icons['navigation.back'].paths[0]!.d)
    expect(options.filter(option => option.querySelector('[data-semantic-icon="status.selected"]'))).toEqual([selected])
    expect(svg.closest('[data-icon-animation]')).toBeNull(); expect(document.activeElement).toBe(originalInput)
    expect(changed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled()
    await act(async () => other.click())
    expect(changed).toHaveBeenCalledExactlyOnceWith('refs/remotes/origin/main'); expect(submitted).not.toHaveBeenCalled()
    expect(popup()).toBeNull(); expect(document.activeElement).toBe(trigger()); expect(trigger().dataset.value).toBe('refs/remotes/origin/main')
    await open()
    expect(choices().filter(option => option.querySelector('[data-semantic-icon="status.selected"]')).map(option => option.dataset.value)).toEqual(['refs/remotes/origin/main'])
  } finally { release() }
})
