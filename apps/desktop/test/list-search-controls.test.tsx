// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { BrowserProfileLibrary } from '../src/renderer/src/components/settings/BrowserProfileLibrary'
import { BrowserProfileTrash } from '../src/renderer/src/components/settings/BrowserProfileTrash'
import type { BrowserProfilesState } from '../src/renderer/src/lib/browser-profiles'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const mode = process.env.AGENTMUX_LIST_CONTROLS_MODE
const config = { ...composerConfig, executors: { codex: composerConfig.executors.codex! } }
const goal: DemandRecord = { id: 'original-goal', title: 'Review the original plan', description: '', priority: 'normal', status: 'in_progress',
  projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' }

function field(label: string) {
  const result = dom.container.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')
  expect(result).not.toBeNull()
  return result!
}
function action(label: string) {
  const result = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
  expect(result).toBeTruthy()
  return result!
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function clear(button: HTMLButtonElement, input: HTMLInputElement) {
  await act(async () => { button.focus(); button.click() })
  expect(input.value).toBe('')
  expect(document.activeElement).toBe(input)
}
async function showAgents(onKeys = vi.fn()) {
  const save = vi.fn(async () => {})
  useAppStore.setState({ config, executorDetections: {} })
  await dom.render(<div onKeyDown={onKeys}><AgentSettingsPane config={config} onSave={save} /></div>)
  return save
}
async function showGoals() {
  useAppStore.setState({ config, demands: { [goal.id]: goal }, selectedDemandId: null })
  await dom.render(<GlobalBoardSurface />)
}

describe.skipIf(mode === 'empty')('Search in the actual Settings and Goal lists', () => {
  it('clears only the Executor query and returns the original field while preserving composition', async () => {
    const ancestor = vi.fn(), save = await showAgents(ancestor)
    const search = field('Filter executors')
    expect(search.type).toBe('search')
    expect(dom.container.querySelector('[data-resource-row="codex"]')).not.toBeNull()
    await type(search, '  not an executor  ')
    expect(search.value).toBe('  not an executor  ')
    expect(dom.container.querySelector('[data-resource-row="codex"]')).toBeNull()
    const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    await act(async () => { search.dispatchEvent(composing) })
    expect(ancestor).not.toHaveBeenCalled()
    expect(composing.defaultPrevented).toBe(false)
    expect(search.value).toBe('  not an executor  ')
    const normal = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    await act(async () => { search.dispatchEvent(normal) })
    expect(ancestor).toHaveBeenCalledOnce()
    await clear(action('Clear executors filter'), search)
    expect(field('Filter executors')).toBe(search)
    expect(dom.container.querySelector('[data-resource-row="codex"]')).not.toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('clears the original Goal filter without changing the store or moving the input', async () => {
    await showGoals()
    const search = field('Search goals')
    await type(search, 'missing outcome')
    expect(dom.container.querySelector('[data-demand-id="original-goal"]')).toBeNull()
    await clear(action('Clear search'), search)
    expect(field('Search goals')).toBe(search)
    expect(dom.container.querySelector('[data-demand-id="original-goal"]')).not.toBeNull()
    expect(useAppStore.getState().demands[goal.id]).toBe(goal)
  })
})

describe.skipIf(mode === 'search')('Confirmed empty states in actual Desktop lists', () => {
  it('reports a confirmed Executor projection without adding a live message inside the listbox', async () => {
    await showAgents()
    const search = field('Filter executors')
    await type(search, 'not an executor')
    const list = search.closest('.settings-resource-library')!
    expect(list.querySelector('[role="listbox"] [role="status"]')).toBeNull()
    expect(list.querySelector('.settings-resource-empty.surface-state h2')?.textContent).toBe('No executors match “not an executor”.')
    await clear(action('Clear executors filter'), search)
    expect(list.querySelector('.settings-resource-empty')).toBeNull()
  })

  it('preserves Goal result, its documented scope and the original zero-match recovery action', async () => {
    await showGoals()
    const search = field('Search goals')
    await type(search, 'unknown phrase')
    expect(dom.container.querySelector('.goals-empty.surface-state h2')?.textContent).toBe('No goals match this view.')
    expect(dom.container.querySelector('.goals-empty')?.textContent).toContain('unknown phrase')
    await clear(action('Clear search & filters'), search)
    expect(dom.container.querySelector('[data-demand-id="original-goal"]')).not.toBeNull()
  })

  it('separates a pending original trash read and an actionable refusal from a confirmed empty list', async () => {
    let reject!: (reason: Error) => void
    const read = vi.spyOn(api.browser, 'readProfileTrash').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    read.mockResolvedValue({ revision: 2, sequence: 2, entries: [], legacyPendingDeletes: [] })
    await dom.render(<BrowserProfileTrash active folders={[]} onBack={() => {}} onRestored={() => {}} />)
    const title = () => dom.container.querySelector('.browser-profile-trash .surface-state h2')?.textContent
    expect(title()).toBeUndefined()
    expect(dom.container.textContent).toContain('Reading recycled Profiles')
    await act(async () => reject(new Error('Original archive could not be read.')))
    expect(title()).toBeUndefined()
    expect(dom.container.textContent).toContain('Original archive could not be read.')
    await act(async () => action('Retry').click())
    expect(title()).toBe('No recycled Profiles.')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('withholds an old empty archive after a failed refresh while Retry awaits a fresh receipt', async () => {
    const empty = { revision: 2, sequence: 2, entries: [], legacyPendingDeletes: [] }
    let profileChanged!: () => void
    let finishRetry!: (result: typeof empty) => void
    vi.spyOn(api.browser, 'onProfilesChanged').mockImplementation(listener => {
      profileChanged = () => listener({ revision: 3, sequence: 3, profiles: [], folders: [], views: [] })
      return () => {}
    })
    const read = vi.spyOn(api.browser, 'readProfileTrash')
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(new Error('Archive refresh failed.'))
      .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve }))
    await dom.render(<BrowserProfileTrash active folders={[]} onBack={() => {}} onRestored={() => {}} />)
    const title = () => dom.container.querySelector('.browser-profile-trash .surface-state h2')?.textContent
    expect(title()).toBe('No recycled Profiles.')
    await act(async () => profileChanged())
    expect(title()).toBeUndefined()
    expect(dom.container.textContent).toContain('Archive refresh failed.')
    await act(async () => action('Retry').click())
    expect(read).toHaveBeenCalledTimes(3)
    expect(title()).toBeUndefined()
    expect(dom.container.textContent).toContain('Reading recycled Profiles')
    expect(dom.container.textContent).not.toContain('Archive refresh failed.')
    await act(async () => finishRetry({ ...empty, revision: 3, sequence: 3 }))
    expect(title()).toBe('No recycled Profiles.')
  })

  it('leaves an unavailable Profile projection for its existing status instead of claiming no data', async () => {
    const blank: BrowserProfilesState = { revision: null, sequence: null, profiles: null, folders: null, views: null, error: null, reading: true }
    const render = (list: BrowserProfilesState) => dom.render(<BrowserProfileLibrary list={list} active={false} selectedId={null}
      onSelect={() => {}} focusRequest={null} assignment={new Map()} openCounts={new Map()} detailLine={() => ''} />)
    await render(blank)
    expect(dom.container.querySelector('.settings-resource-empty')).toBeNull()
    await render({ ...blank, profiles: [], reading: false, error: 'Original list unavailable' })
    expect(dom.container.querySelector('.settings-resource-empty')).toBeNull()
    await render({ ...blank, profiles: [], reading: false })
    expect(dom.container.querySelector('.settings-resource-empty.surface-state h2')?.textContent).toBe('No profiles yet.')
  })
})
