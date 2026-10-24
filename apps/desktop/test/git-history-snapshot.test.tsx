// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import type { GitCommitDetailsInput, GitCommitDiffDescriptor, GitHistoryInput, GitHistoryResult } from '../src/shared/git-contracts'
import type { GitDiffViewState } from '../src/renderer/src/features/git/diff/GitDiffCanvas'
import { GitService } from '../src/main/git-service'
import { createClientUiRoot } from './helpers/client-ui-render'
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { selectHistoryReference } from './helpers/git-history-reference'
import { useAppStore } from '../src/renderer/src/store'
import { GitHistoryProvider, useSharedGitHistory } from '../src/renderer/src/features/git/history/GitHistoryContext'
import { GitWorkbenchPane } from '../src/renderer/src/features/git/GitWorkbenchPane'
import { WorkspaceGitTool } from '../src/renderer/src/components/WorkspaceGitTool'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/BranchesPanel', () => ({ BranchesPanel: () => null }))
vi.mock('../src/renderer/src/components/ChangesPanel', () => ({ ChangesPanel: () => null }))
// Monaco is the outer rendering boundary. Original Git details, selection, diff loading and
// blob reads remain active; the visible text below comes from the real Git owner.
vi.mock('../src/renderer/src/features/git/diff/GitDiffCanvas', () => ({ GitDiffCanvas: ({ diff }: { diff: GitDiffViewState }) =>
  <pre data-loaded-diff>{JSON.stringify(diff?.diff ?? null)}</pre> }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
type DeliveryGate = { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; beforeRead: boolean }
type HistoryCall = { input: GitHistoryInput; result?: GitHistoryResult }
const initial = useAppStore.getState()
const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
let path: string, execution: LocalExecutionHost, service: GitService, config: AppConfig, workspace: WorkspaceRecord
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
let reader: NonNullable<ReturnType<typeof useSharedGitHistory>>
let originalOid: string, topicOid: string
let historyCalls: HistoryCall[], pending: Set<Promise<unknown>>, delayed: Set<Promise<unknown>>, gates: DeliveryGate[]
let nextCheck: DeliveryGate | undefined, nextPage: DeliveryGate | undefined

async function git(...args: string[]) {
  const result = await execution.run('git', ['-C', path, ...args], options)
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
function hold(kind: 'check' | 'page', beforeRead = false) {
  const gate = { arrived: deferred(), release: deferred(), beforeRead }
  gates.push(gate)
  if (kind === 'check') nextCheck = gate
  else nextPage = gate
  return gate
}
function track<T>(request: Promise<T>, held = false) {
  pending.add(request)
  if (held) delayed.add(request)
  const done = () => { pending.delete(request); delayed.delete(request) }
  void request.then(done, done)
  return request
}
function routeHistory(workspaceId: string, input: GitHistoryInput = {}) {
  const call: HistoryCall = { input }; historyCalls.push(call)
  const gate = input.limit === 1 ? nextCheck : input.cursor ? nextPage : undefined
  if (input.limit === 1) nextCheck = undefined
  else if (input.cursor) nextPage = undefined
  const request = (async () => {
    if (gate?.beforeRead) { gate.arrived.resolve(); await gate.release.promise }
    const result = await service.history(workspaceId, input, config)
    call.result = result
    // Delay delivery of an unmodified real result to exercise completion order.
    if (gate && !gate.beforeRead) { gate.arrived.resolve(); await gate.release.promise }
    return result
  })()
  return track(request, Boolean(gate))
}
function Review() {
  const tabs = useAppStore(state => state.tabs)
  return <main>{Object.values(tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'git')
    .map(surface => <GitWorkbenchPane key={surface.regionId} surface={surface} />)}</main>
}
function InspectReader() {
  reader = useSharedGitHistory(workspace)!
  return null
}
async function render(visible = true) {
  await act(async () => root.render(<GitHistoryProvider workspace={workspace}>
    <aside><WorkspaceGitTool workspace={workspace} visible={visible} /></aside><Review /><InspectReader />
  </GitHistoryProvider>))
}
async function until(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.allSettled([...pending].filter(request => !delayed.has(request)))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    assertion()
  }, { timeout: 1500, interval: 10 })
}
function ready() {
  const value = reader.history.result
  expect(value?.kind).toBe('ready')
  if (value?.kind !== 'ready') throw new Error('The mounted production reader has no ready snapshot')
  return value
}
function button(label: string, container: ParentNode = host) {
  const value = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)
  expect(value, `Action ${label} is reachable`).toBeDefined()
  return value!
}
async function click(label: string, container: ParentNode = host) { await act(async () => button(label, container).click()) }
async function mount() { await render(); await until(() => expect(ready().commits).toHaveLength(50)) }
async function check() {
  await click('Check references')
  await until(() => expect(reader.history.referenceCheck?.checking).toBe(false))
}
async function selectOriginalDiff() {
  const row = host.querySelector<HTMLElement>(`[data-history-oid="${originalOid}"]`)
  expect(row).not.toBeNull()
  await act(async () => row!.click())
  await until(() => expect(button('Open diff for story.txt')).toBeDefined())
  await click('Open diff for story.txt')
  await until(() => expect(host.querySelector('[data-loaded-diff]')?.textContent).toContain('Version 119'))
  const surface = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(region => region.kind === 'git')!
  if (surface.kind !== 'git') throw new Error('The production selection did not open a Git Region')
  return { surface, diff: useAppStore.getState().editorRegionDiffs[surface.regionId], visibleDiff: host.querySelector('[data-loaded-diff]')!.textContent }
}
async function amend() {
  await git('config', 'user.name', 'History Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await git('commit', '--amend', '--no-gpg-sign', '-m', 'Rewritten tip')
  const oid = await git('rev-parse', 'HEAD')
  expect(oid).not.toBe(originalOid)
  return oid
}
async function loadWindow() {
  await click('Load more')
  await until(() => expect(ready().commits).toHaveLength(100))
  await act(async () => { const scroller = host.querySelector<HTMLElement>('.git-history-scroll')!; scroller.scrollTop = 1600; scroller.dispatchEvent(new Event('scroll')) })
}

beforeEach(async () => {
  installGitHistoryViewport()
  localStorage.clear()
  path = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-history-snapshot-')))
  execution = new LocalExecutionHost()
  await git('init', '-b', 'main')
  // One real import creates enough history for a refresh to cross a page boundary.
  let stream = ''
  for (let index = 0; index < 120; index += 1) {
    const content = `Version ${index}\n`, subject = `Change ${index}`, instant = Math.floor(fixtureEpoch(1, index) / 1000)
    stream += `blob\nmark :${2 * index + 1}\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\nmark :${2 * index + 2}\ncommitter History Fixture <fixture@example.invalid> ${instant} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n`
    if (index) stream += `from :${2 * index}\n`
    stream += `M 100644 :${2 * index + 1} story.txt\n\n`
  }
  const imported = await execution.run('git', ['-C', path, 'fast-import', '--quiet'], { ...options, input: stream })
  expect(imported.exitCode, imported.stderr).toBe(0)
  await git('reset', '--hard', 'main')
  originalOid = await git('rev-parse', 'HEAD'); topicOid = await git('rev-parse', 'HEAD~90')
  await git('branch', 'topic', topicOid)
  workspace = { id: 'repository', hostId: 'local', path, name: 'History repository', kind: 'folder' }
  config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  service = new GitService(() => execution)
  historyCalls = []; pending = new Set(); delayed = new Set(); gates = []; nextCheck = undefined; nextPage = undefined
  Object.assign(window, { agentmux: { git: {
    history: routeHistory,
    commitDetails: (id: string, input: GitCommitDetailsInput) => track(service.commitDetails(id, input, config)),
    commitDiff: (id: string, input: GitCommitDiffDescriptor) => track(service.commitDiff(id, input, config))
  } } })
  useAppStore.setState({ config, tabs: {}, layouts: { repository: createWorkspaceLayout('group', []) }, activeWorkspaceId: workspace.id,
    workspaceTool: 'git', workspaceGitView: 'history', toolsOpen: true, mainSurface: 'workbench', editorRegionDiffs: {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
}, 20_000)
afterEach(async () => {
  gates?.forEach(gate => gate.release.resolve())
  await act(async () => { await Promise.allSettled([...pending]); root?.unmount() })
  host?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks()
  Object.assign(window, { agentmux: undefined })
  if (path) await rm(path, { recursive: true, force: true })
})

it('observes real ref movement and amend without replacing the selected snapshot, commit or loaded Diff', async () => {
  await mount(); const selected = await selectOriginalDiff(), before = ready()
  const originalDiff = host.querySelector('[data-loaded-diff]')
  const changedOid = await amend()
  const commands = vi.spyOn(execution, 'run')
  await check()
  expect(host.textContent).toContain('References have changed.')
  expect(ready()).toBe(before)
  expect(ready().snapshot.refs.find(ref => ref.name === 'refs/heads/main')?.oid).toBe(originalOid)
  expect(ready().commits.some(commit => commit.oid === changedOid)).toBe(false)
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions))
    .find(region => region.regionId === selected.surface.regionId)).toBe(selected.surface)
  expect(useAppStore.getState().editorRegionDiffs[selected.surface.regionId]).toBe(selected.diff)
  expect(host.querySelector('[data-loaded-diff]')).toBe(originalDiff)
  expect(originalDiff?.textContent).toBe(selected.visibleDiff)
  expect(host.querySelector('.git-workbench__target')?.textContent).toContain('Fixed commit')
  expect(host.querySelector('time')?.getAttribute('title')).toContain('Author time')
  expect(historyCalls.at(-1)?.input).toEqual({ ref: null, limit: 1 })
  expect(commands.mock.calls.filter(([, args]) => args.includes('for-each-ref'))).toHaveLength(1)
  expect(commands.mock.calls.filter(([, args]) => args.includes('log')).map(([, args]) => args.find(value => value.startsWith('--max-count=')))).toEqual(['--max-count=2'])
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(await git('status', '--porcelain')).toBe('')
})

it('refills a changed multi-page snapshot atomically and retains the original selection, Diff and deep viewport', async () => {
  await mount(); const selected = await selectOriginalDiff(); await loadWindow()
  const before = ready(), position = host.querySelector<HTMLElement>('.git-history-scroll')!
  const changedOid = await amend(), gate = hold('page')
  await click('Refresh history'); await gate.arrived.promise
  expect(reader.history.loading).toBe(true); expect(ready()).toBe(before); expect(position.scrollTop).toBe(1600)
  await act(async () => gate.release.resolve())
  await until(() => { expect(reader.history.loading).toBe(false); expect(ready().commits[0]?.oid).toBe(changedOid) })
  expect(ready().commits).toHaveLength(100); expect(ready().nextCursor?.offset).toBe(100)
  expect(position.scrollTop).toBe(1600)
  expect(useAppStore.getState().editorRegionDiffs[selected.surface.regionId]).toBe(selected.diff)
  expect(host.querySelector('[data-loaded-diff]')?.textContent).toBe(selected.visibleDiff)
  expect(host.querySelector('.git-workbench__target code')?.getAttribute('title')).toBe(originalOid)
  expect(historyCalls.map(call => call.input.cursor?.offset ?? 0)).toEqual([0, 50, 0, 50])
})

it('keeps unknown reference checks nonblocking and can retry after the original repository returns', async () => {
  await mount(); const selected = await selectOriginalDiff(), before = ready()
  await rename(join(path, '.git'), join(path, '.git-unavailable'))
  await check()
  expect(host.textContent).toContain('Current references unknown.')
  expect(host.textContent).not.toContain('References have changed.')
  expect(ready()).toBe(before); expect(button('Refresh history').disabled).toBe(false); expect(button('Load more').disabled).toBe(false)
  expect(useAppStore.getState().editorRegionDiffs[selected.surface.regionId]).toBe(selected.diff)
  await rename(join(path, '.git-unavailable'), join(path, '.git'))
  await click('Retry check'); await until(() => expect(reader.history.referenceCheck?.checking).toBe(false))
  expect(host.textContent).not.toContain('Current references unknown.')
  expect(host.textContent).not.toContain('References have changed.')
  expect(ready()).toBe(before)
})

it('does not compare a newly discovered parent repository with the original nested snapshot', async () => {
  const nested = join(path, 'nested')
  await git('clone', '--no-hardlinks', path, nested)
  workspace.path = nested
  await mount(); const before = ready()
  expect(before.snapshot.repoPath).toBe(nested)
  await rename(join(nested, '.git'), join(nested, '.git-unavailable'))
  await check()
  const observed = historyCalls.at(-1)?.result
  expect(observed?.kind).toBe('ready')
  if (observed?.kind !== 'ready') throw new Error('Expected actual discovery of the parent repository')
  expect(observed.snapshot.repoPath).toBe(path)
  expect(reader.history.referenceCheck?.changed).toBeNull()
  expect(host.textContent).toContain('Current references unknown.')
  expect(host.textContent).not.toContain('References have changed.')
  expect(ready()).toBe(before)
  expect(button('Refresh history').disabled).toBe(false)
})

it('coalesces focus and manual checks and rejects a delayed observation after explicit refresh', async () => {
  await mount(); const gate = hold('check'), before = ready()
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
  await gate.arrived.promise
  expect(button('Checking…').disabled).toBe(true)
  expect(historyCalls.filter(call => call.input.limit === 1)).toHaveLength(1)
  const changedOid = await amend()
  await click('Refresh history'); await until(() => expect(ready().commits[0]?.oid).toBe(changedOid))
  const refreshed = ready(); expect(refreshed).not.toBe(before)
  await act(async () => gate.release.resolve())
  expect(ready()).toBe(refreshed); expect(reader.history.referenceCheck).toBeNull()
  expect(host.textContent).not.toContain('References have changed.')
})

it('allows a new scope to check its current references while an obsolete scope receipt is still delayed', async () => {
  await mount(); const gate = hold('check')
  await click('Check references'); await gate.arrived.promise
  await selectHistoryReference(host, 'refs/heads/topic')
  await until(() => expect(ready().snapshot.selectedRef).toBe('refs/heads/topic'))
  const scoped = ready()
  await git('branch', '-f', 'topic', originalOid)
  await click('Check references')
  expect(historyCalls.filter(call => call.input.limit === 1)).toHaveLength(2)
  await until(() => expect(reader.history.referenceCheck?.changed).toBe(true))
  expect(ready()).toBe(scoped)
  await act(async () => gate.release.resolve())
  expect(ready()).toBe(scoped); expect(reader.history.referenceCheck?.changed).toBe(true)
})

it('retries a failed refresh refill as a refresh instead of quietly extending the old snapshot', async () => {
  await mount(); await loadWindow(); const before = ready(), changedOid = await amend()
  const gate = hold('page', true)
  await click('Refresh history'); await gate.arrived.promise
  expect(ready()).toBe(before); expect(reader.history.loading).toBe(true)
  await rename(join(path, '.git'), join(path, '.git-unavailable'))
  await act(async () => gate.release.resolve()); await until(() => expect(reader.history.error).toBeTruthy())
  expect(ready()).toBe(before)
  expect(ready().nextCursor).toBe(before.nextCursor)
  expect(host.querySelector<HTMLElement>('.git-history-scroll')?.scrollTop).toBe(1600)
  await rename(join(path, '.git-unavailable'), join(path, '.git'))
  await click('Retry', host.querySelector('.git-history-error')!)
  await until(() => expect(reader.history.loading).toBe(false))
  expect(ready().commits[0]?.oid).toBe(changedOid)
  expect(ready().commits).toHaveLength(100)
})
