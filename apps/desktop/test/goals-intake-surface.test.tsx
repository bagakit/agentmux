// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'

const baseline = useAppStore.getState()
const config = { workspaces: [{ id: 'repo', name: 'Repo', path: '/repo', hostId: 'local', kind: 'folder' }], executors: {} } as AppConfig
function goal(id = 'goal:one', status = 'backlog' as const) { return { id, title: 'A readable outcome', description: 'Make the original work recoverable.', status, priority: 'normal' as const, projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' as const } }
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config, sessions: [], demands: {}, selectedDemandId: null, mainSurface: 'board' })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text); expect(result, text).toBeDefined(); return result! }
async function click(text: string) { await act(async () => button(text).click()) }
async function edit(label: string, text: string) { const node = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`)!; expect(node).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true })) }); return node }

describe('Goals real-intent intake and reading surface', () => {
  it('creates nothing for blank, whitespace or cancelled input and returns focus', async () => {
    const create = vi.fn(); const request = vi.fn(); useAppStore.setState({ createDemand: create, requestDemandPmoTask: request })
    await mount(); await click('New Goal')
    expect(button('Save & discuss').disabled).toBe(true)
    await edit('Goal intent', '   \n  '); expect(button('Save & discuss').disabled).toBe(true)
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await click('Cancel'); expect(create).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(Object.keys(useAppStore.getState().demands)).toEqual([])
    expect(document.activeElement).toBe(button('New Goal'))
  })

  it('saves the exact user intent before sending the saved Goal to Mote', async () => {
    const original = '  Keep my original work after restart.\nDo not lose a healthy Agent.  '
    let resolve!: (value: string) => void
    const create = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const request = vi.fn(async () => 'goal-tab')
    useAppStore.setState({ createDemand: create, requestDemandPmoTask: request })
    await mount(); await click('Goal filters')
    const project = container.querySelector<HTMLSelectElement>('[aria-label="Filter project"]')!
    await act(async () => { project.value = 'repo'; project.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Goal filters'); await click('New Goal'); await edit('Goal intent', original); await click('Save & discuss')
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: original, projectId: 'repo', projectName: 'Repo', status: 'backlog' }))
    expect(request).not.toHaveBeenCalled(); expect(useAppStore.getState().selectedDemandId).toBeNull()
    await act(async () => { useAppStore.setState({ demands: { 'goal:saved': { ...goal('goal:saved'), description: original } } }); resolve('goal:saved') })
    expect(request).toHaveBeenCalledExactlyOnceWith('goal:saved', 'grill')
    expect(useAppStore.getState().selectedDemandId).toBe('goal:saved')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')?.value).toBe(original)
    expect(container.querySelector('.goals-intake')).toBeNull()
  })

  it('retains a failed creation draft and lets the same real intent retry', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockImplementationOnce(async () => { useAppStore.setState({ demands: { 'goal:retry': goal('goal:retry') } }); return 'goal:retry' })
    const request = vi.fn(async () => 'goal-tab')
    useAppStore.setState({ createDemand: create, requestDemandPmoTask: request })
    await mount(); await click('New Goal'); await edit('Goal intent', 'A real intent'); await click('Save & discuss')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal intent"]')?.value).toBe('A real intent')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Your draft is kept')
    expect(request).not.toHaveBeenCalled(); expect(Object.keys(useAppStore.getState().demands)).toEqual([])
    await click('Save & discuss'); expect(create).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledExactlyOnceWith('goal:retry', 'grill')
  })

  it('keeps the saved goal and visible recovery action when Mote delivery fails', async () => {
    const saved = goal('goal:saved')
    const create = vi.fn(async () => { useAppStore.setState({ demands: { [saved.id]: saved } }); return saved.id })
    const request = vi.fn().mockRejectedValueOnce(new Error('Mote launch unavailable')).mockResolvedValueOnce('mote-tab')
    useAppStore.setState({ createDemand: create, requestDemandPmoTask: request })
    await mount(); await click('New Goal'); await edit('Goal intent', saved.description); await click('Save & discuss')
    expect(Object.keys(useAppStore.getState().demands)).toEqual([saved.id]); expect(useAppStore.getState().selectedDemandId).toBe(saved.id)
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('Goal saved')
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('delivery is unconfirmed')
    await click('Retry discussion'); expect(request).toHaveBeenCalledTimes(2); expect(create).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.goals-detail [role="status"]')).toBeNull()
  })

  it('retries a failed Mote open as an open action without silently starting Grill', async () => {
    const original = goal(); const open = vi.fn().mockRejectedValueOnce(new Error('Mote view unavailable')).mockResolvedValueOnce('mote-tab'); const request = vi.fn()
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, openDemandPmo: open, requestDemandPmoTask: request })
    await mount(); await click(`Open Mote for ${original.title}`)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('workspace could not be opened')
    expect(request).not.toHaveBeenCalled(); await click('Retry opening Mote')
    expect(open.mock.calls).toEqual([[original.id], [original.id]]); expect(request).not.toHaveBeenCalled()
  })

  it('defaults to a nonempty list, filters honestly and keeps the same identity in the horizontal board', async () => {
    useAppStore.setState({ demands: { 'goal:one': goal(), 'goal:done': { ...goal('goal:done'), title: 'Previously done', status: 'done' } } })
    await mount(); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one'])
    expect(container.querySelector('.goals-list')).toBeTruthy(); expect(container.querySelector('.goals-filters')).toBeNull()
    await act(async () => (container.querySelector('[data-demand-id]') as HTMLElement).click()); expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Board view'); expect(container.querySelector('.goals-board')).toBeTruthy(); expect(container.querySelector('[data-demand-id="goal:one"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Show finished'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one', 'goal:done'])
    await edit('Search goals', 'previously'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:done'])
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Clear search'); await click('List view'); expect(container.querySelectorAll('[data-demand-id]')).toHaveLength(2)
  })

  it('keeps durable selection during an empty startup projection and recovers its same detail', async () => {
    useAppStore.setState({ selectedDemandId: 'goal:restored', demands: {} }); await mount()
    expect(useAppStore.getState().selectedDemandId).toBe('goal:restored'); expect(container.querySelector('.goals-detail')?.textContent).toContain('identity is kept')
    await act(async () => useAppStore.setState({ demands: { 'goal:restored': goal('goal:restored') } }))
    expect(container.querySelector('[aria-label="Goal workspace for A readable outcome"]')).toBeTruthy()
    expect(useAppStore.getState().selectedDemandId).toBe('goal:restored')
  })

  it('retains an unsaved title when the owner rejects a save and retries through the public caller', async () => {
    const original = goal(); const update = vi.fn().mockRejectedValueOnce(new Error('Save unconfirmed')).mockResolvedValueOnce(undefined)
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'My clearer outcome')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(update).toHaveBeenCalledWith(original.id, { title: 'My clearer outcome' })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('My clearer outcome')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('draft is kept')
    await click('Retry save'); expect(update).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer title draft while the earlier save is in flight', async () => {
    const original = goal(); let resolve!: () => void
    const update = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'First revision')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await edit('Goal title', 'A newer unsent revision')
    await act(async () => { useAppStore.setState({ demands: { [original.id]: { ...original, title: 'First revision' } } }); resolve() })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('A newer unsent revision')
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { title: 'First revision' })
  })

  it('retains a failed detail draft when reading another Goal and returning', async () => {
    const original = goal(), second = { ...goal('goal:two'), title: 'Another goal' }
    const update = vi.fn().mockRejectedValue(new Error('Save unavailable'))
    useAppStore.setState({ demands: { [original.id]: original, [second.id]: second }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'An unsaved but valuable title')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('draft is kept')
    await act(async () => (container.querySelector('[data-demand-id="goal:two"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('Another goal')
    await act(async () => (container.querySelector('[data-demand-id="goal:one"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('An unsaved but valuable title')
    expect(Object.keys(useAppStore.getState().demands)).toEqual(['goal:one', 'goal:two'])
  })

  it('retries the actual failed property patch rather than pretending an empty save succeeded', async () => {
    const original = goal(); const update = vi.fn().mockRejectedValueOnce(new Error('Priority save unavailable')).mockResolvedValueOnce(undefined)
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const priority = container.querySelector<HTMLSelectElement>('[aria-label="Goal priority"]')!
    await act(async () => { priority.value = 'high'; priority.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { priority: 'high' })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Priority save unavailable')
    await click('Retry save'); expect(update.mock.calls).toEqual([[original.id, { priority: 'high' }], [original.id, { priority: 'high' }]])
  })

  it('does no default Goal render work for unrelated Session output and tab facts', async () => {
    const related = { id: 'linked', label: 'Linked Agent', status: { state: 'working' }, workspacePath: '/repo' } as SessionSnapshot
    const unrelated = { ...related, id: 'unrelated' }
    useAppStore.setState({ demands: { 'goal:one': { ...goal(), sessionIds: ['linked'] } }, sessions: [related, unrelated], selectedDemandId: 'goal:one' })
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'goals', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelector('[data-demand-id]')?.textContent).toContain('1 linked · working')
    expect(container.querySelector('.goals-execution__link')).toBeNull(); expect(container.querySelector('.agent-topology-summary')).toBeNull()
    const count = commits.mock.calls.length; expect(count).toBeGreaterThan(0)
    await act(async () => useAppStore.setState({ sessions: [related, { ...unrelated, latestOutputBytes: 900000, updatedAt: 12 }], tabs: {} }))
    expect(commits.mock.calls.length).toBe(count)
  })
})
