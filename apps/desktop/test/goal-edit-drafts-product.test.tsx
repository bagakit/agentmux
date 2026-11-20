// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

let store: typeof import('../src/renderer/src/store'), api: typeof import('../src/renderer/src/lib/api')['api']
let Board: typeof import('../src/renderer/src/components/GlobalBoardSurface')['GlobalBoardSurface']
let fixture: Awaited<ReturnType<typeof import('./helpers/host-goal-discussion-fixture')['openHostGoalDiscussionFixture']>>
let root: Root, container: HTMLDivElement, user: WorkbenchUserStateStore, directory: string
let releaseHeld: Array<() => void>
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Host' }],
  workspaces: [{ id: '__scratch__', name: 'Private Mote', path: '.', hostId: 'local', kind: 'scratch' }],
  executors: { private: { label: 'Private Agent', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } },
  appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
beforeEach(async () => {
  releaseHeld = []; fixture = undefined as never
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  api = (await import('../src/renderer/src/lib/api')).api
  directory = await mkdtemp(join(tmpdir(), 'amux-goal-edit-user-'))
  user = new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json'))
  await user.write(JSON.stringify({ state: {}, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  store = await import('../src/renderer/src/store')
  Board = (await import('../src/renderer/src/components/GlobalBoardSurface')).GlobalBoardSurface
  store.useAppStore.setState({ config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board' })
  fixture = await (await import('./helpers/host-goal-discussion-fixture')).openHostGoalDiscussionFixture(config)
  await seedStoredDemand(fixture.host.demands, { id: 'original', title: 'Saved title', description: 'Saved intent', status: 'backlog', sessionIds: [] })
  await store.useAppStore.getState().refreshDemand('original')
  store.useAppStore.setState({ selectedDemandId: 'original', mainSurface: 'board' })
  fixture.host.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await mount()
})
afterEach(async () => {
  for (const release of releaseHeld) release()
  await act(async () => root?.unmount())
  if (fixture) await fixture.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
  container?.remove(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const state = () => store.useAppStore.getState()
async function mount() { await act(async () => root.render(<Board />)) }
function field(label: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); expect(input).not.toBeNull(); return input! }
async function fill(label: string, value: string) {
  const input = field(label)
  await act(async () => { const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(field(label).value).toBe(value)
  return input
}
async function click(label: string) { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label); expect(button).toBeTruthy(); button!.click() }) }
async function properties() { await act(async () => { const node = container.querySelector<HTMLDetailsElement>('.goals-properties')!; node.open = true; node.dispatchEvent(new Event('toggle')) }) }
async function blur(input: HTMLElement) { await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))) }

it('keeps native Goal text and tags through failed saves, owner reads and a remounted surface', async () => {
  const release = fixture.host.failAll('demand.update', new Error('The original save is unavailable'))
  const title = await fill('Goal title', 'My unconfirmed title'); await blur(title)
  await vi.waitFor(() => expect(state().goalEditDrafts.original?.title?.issue).toContain('unavailable'))
  await click('Edit goal description'); await fill('Goal description', 'My original intent\nincluding unsaved words')
  await properties(); await fill('Goal tags', '  raw tag , second ,  ')
  release()
  await act(async () => { await state().updateDemand('original', { priority: 'high' }); await state().refreshDemand('original') })
  expect(field('Goal tags').value).toBe('  raw tag , second ,  ')
  expect(field('Goal description').value).toBe('My original intent\nincluding unsaved words')
  await act(async () => { store.useAppStore.setState({ mainSurface: 'workbench' }); root.render(null) })
  await store.prepareRendererUpdate()
  const saved = JSON.parse((await user.read())!)
  expect(saved.state.goalEditDrafts.original).toMatchObject({ title: { value: 'My unconfirmed title' },
    description: { value: 'My original intent\nincluding unsaved words' }, tags: { value: '  raw tag , second ,  ' } })
  // A remounted consumer reads the same draft owner. The separate Electron proof
  // covers a fresh process reading these bytes without another input or reseed.
  store.useAppStore.setState({ mainSurface: 'board' }); await mount(); await properties()
  expect(field('Goal title').value).toBe('My unconfirmed title')
  expect(field('Goal tags').value).toBe('  raw tag , second ,  ')
  expect(field('Goal description').value).toBe('My original intent\nincluding unsaved words')
  expect((await fixture.host.demands.get('original'))?.description).toBe('Saved intent')
})

it('a late save ACK clears only its submitted Goal field version and a lost receipt retains new text', async () => {
  const held = fixture.host.once('demand.update', { kind: 'hold-receipt' })
  releaseHeld.push(held.release)
  const title = await fill('Goal title', 'First version'); await blur(title); await held.committed
  await fill('Goal title', 'Newer unsent version')
  await act(async () => { held.release(); await fixture.host.settle() })
  await vi.waitFor(() => expect(state().goalEditDrafts.original?.title?.value).toBe('Newer unsent version'))
  expect(field('Goal title').value).toBe('Newer unsent version')
  fixture.host.once('demand.update', { kind: 'lose-receipt', error: new Error('Original write receipt is unknown') })
  await blur(field('Goal title'))
  await vi.waitFor(() => expect(state().goalEditDrafts.original?.title?.issue).toContain('unknown'))
  await act(async () => { await state().refreshDemand('original') })
  expect(field('Goal title').value).toBe('Newer unsent version')
  await click('Retry save')
  await vi.waitFor(() => expect(state().goalEditDrafts.original).toBeUndefined())
  expect((await fixture.host.demands.get('original'))?.title).toBe('Newer unsent version')
})

it('Done focus transfer and click share one original save instead of a late false failure', async () => {
  await click('Edit goal description'); await fill('Goal description', 'An explicitly saved intent')
  const held = fixture.host.once('demand.update', { kind: 'hold-request' })
  releaseHeld.push(held.release)
  await act(async () => {
    field('Goal description').focus()
    const done = [...container.querySelectorAll('button')].find(button => button.textContent === 'Done')!
    done.focus(); done.click()
  })
  await held.reached
  expect(fixture.host.executed('demand.update')).toHaveLength(1)
  await act(async () => { held.release(); await fixture.host.settle() })
  await vi.waitFor(() => expect(state().goalEditDrafts.original).toBeUndefined())
  expect(fixture.host.executed('demand.update')).toHaveLength(1)
  expect(container.textContent).not.toContain('Changes are not saved')
  expect((await fixture.host.demands.get('original'))?.description).toBe('An explicitly saved intent')
})

it('only a matching confirmed deletion clears its original drafts; failure and newer edits survive', async () => {
  const { editGoalDraft } = await import('../src/renderer/src/lib/goal-edit-drafts')
  await act(async () => { editGoalDraft('original', 'title', 'Keep until explicit delete'); editGoalDraft('other', 'tags', 'Other original text') })
  fixture.host.once('demand.delete', { kind: 'reject' })
  await act(async () => { state().deleteDemand('original'); await fixture.host.settle() })
  expect(state().goalEditDrafts.original?.title?.value).toBe('Keep until explicit delete')
  await act(async () => state().refreshDemand('original'))
  const held = fixture.host.once('demand.delete', { kind: 'hold-receipt' })
  releaseHeld.push(held.release)
  await act(async () => state().deleteDemand('original')); await held.committed
  await act(async () => editGoalDraft('original', 'title', 'A later original edit'))
  await act(async () => { held.release(); await fixture.host.settle() })
  expect(state().goalEditDrafts.original?.title?.value).toBe('A later original edit')
  await seedStoredDemand(fixture.host.demands, { id: 'original', title: 'Explicitly recreated original', description: '', status: 'backlog', sessionIds: [] })
  await state().refreshDemand('original')
  fixture.host.once('demand.delete', { kind: 'lose-receipt' })
  await act(async () => { state().deleteDemand('original'); await fixture.host.settle() })
  expect(state().goalEditDrafts.original?.title?.value).toBe('A later original edit')
  await seedStoredDemand(fixture.host.demands, { id: 'original', title: 'Explicitly recreated again', description: '', status: 'backlog', sessionIds: [] })
  await state().refreshDemand('original')
  await act(async () => { state().deleteDemand('original'); await fixture.host.settle() })
  expect(state().goalEditDrafts.original).toBeUndefined()
  expect(state().goalEditDrafts.other?.tags?.value).toBe('Other original text')
})
