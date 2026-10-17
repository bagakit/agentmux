// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { api } from '../src/renderer/src/lib/api'
import * as quickSwitch from '../src/renderer/src/lib/quick-switch'
import * as workbenchTabs from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), originalId = 'original-agent'
const surface = (open: boolean) => <QuickSwitcher open={open} onClose={() => {}} />
function sessions(count: number) {
  useAppStore.setState({ sessions: [
    { ...composerSession(originalId), label: 'Original named Agent' },
    ...Array.from({ length: count - 1 }, (_, index) => composerSession(`unrelated-${index}`))
  ], tabs: {}, layouts: {}, activeWorkspaceId: 'workspace', mainSurface: 'workbench' })
}
async function status(observedAt: number, state: 'working' | 'waiting' = 'working') {
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: originalId, state,
    evidence: { source: 'native-hook', observedAt, run: { runId: `run-${originalId}` } }
  } }))
}
function cost() {
  const build = vi.spyOn(quickSwitch, 'buildQuickSwitchIndex')
  const rank = vi.spyOn(quickSwitch, 'rankQuickSwitchItems')
  const workspace = vi.spyOn(workbenchTabs, 'workspaceForSession')
  return {
    clear: () => { build.mockClear(); rank.mockClear(); workspace.mockClear() },
    read: () => ({ builds: build.mock.calls.length, ranks: rank.mock.calls.length,
      sessionVisits: build.mock.calls.reduce((total, [input]) => total + input.sessions.length, 0),
      workspaceLookups: workspace.mock.calls.length })
  }
}
const noCost = { builds: 0, ranks: 0, sessionVisits: 0, workspaceLookups: 0 }
function expectIdle(work: ReturnType<typeof cost>) {
  const measured = work.read()
  expect(measured, JSON.stringify(measured)).toEqual(noCost)
}
function rows() { return document.querySelectorAll<HTMLButtonElement>('.quick-switch__row') }
async function mode(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.quick-switch__modes button')]
    .find(value => value.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
async function input(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(field: HTMLInputElement, value: string, isComposing = false) {
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', {
    key: value, isComposing, bubbles: true, cancelable: true
  })))
}

it.each([1, 32, 100])('does no closed index or rank work across %i Sessions while original facts stay live', async count => {
  sessions(count)
  const work = cost()
  await dom.render(surface(false))
  work.clear()
  for (let index = 0; index < 5; index++) await status(100 + index)
  expectIdle(work)
  expect(useAppStore.getState().sessions.find(value => value.id === originalId)?.status?.state).toBe('working')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('opens and reopens with current facts without needing another Store publication', async () => {
  sessions(2)
  await dom.render(surface(false))
  await status(200, 'waiting')
  const current = useAppStore.getState().sessions
  await dom.render(surface(true))
  expect(useAppStore.getState().sessions).toBe(current)
  expect(rows()).toHaveLength(2)
  expect(rows()[0]?.textContent).toContain('Original named Agent')
  expect(rows()[0]?.dataset.attention).toBe('needs-you')
  await dom.render(surface(false))
  await dom.render(surface(true))
  expect(useAppStore.getState().sessions).toBe(current)
  expect(rows()).toHaveLength(2)
  expect(rows()[0]?.dataset.attention).toBe('needs-you')
})

it.each([1, 32, 100])('keeps the file reader and query while skipping Session derivation across %i Sessions', async count => {
  sessions(count)
  const files = vi.spyOn(api.files, 'list').mockResolvedValue({ status: 'listed',
    files: ['original.ts', 'other.ts'], complete: true, omitted: 'git-ignored', partialReason: null })
  const work = cost()
  await dom.render(surface(true))
  expect(rows()).toHaveLength(count)
  await mode('Project files')
  const field = document.querySelector<HTMLInputElement>('[aria-label="Find project files"]')!
  expect(field).not.toBeNull()
  await input(field, 'original')
  expect(document.querySelector('.quick-file-picker')?.textContent).toContain('original.ts')
  expect(document.querySelector('.quick-file-picker')?.textContent).not.toContain('other.ts')
  work.clear()
  for (let index = 0; index < 5; index++) await status(300 + index, 'waiting')
  expectIdle(work)
  expect(document.querySelector('[aria-label="Find project files"]')).toBe(field)
  expect(field.value).toBe('original')
  expect(files).toHaveBeenCalledExactlyOnceWith('workspace')
  const current = useAppStore.getState().sessions
  await mode('Sessions & tabs')
  expect(useAppStore.getState().sessions).toBe(current)
  expect(rows()).toHaveLength(count)
  expect(rows()[0]?.textContent).toContain('Original named Agent')
  expect(rows()[0]?.dataset.attention).toBe('needs-you')
})

it('keeps query ranking, IME and keyboard selection on the exact original Store action', async () => {
  sessions(3)
  // No replacement implementation: require the original action to succeed and update exact focus.
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(surface(true))
  const field = document.querySelector<HTMLInputElement>('[aria-label="Search sessions and tabs"]')!
  expect(field).not.toBeNull()
  await input(field, 'unrelated')
  expect(rows()).toHaveLength(2)
  await key(field, 'ArrowDown')
  expect(rows()[1]?.dataset.active).toBe('true')
  await key(field, 'ArrowUp')
  expect(rows()[0]?.dataset.active).toBe('true')
  await input(field, originalId)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]?.textContent).toContain('Original named Agent')
  await key(field, 'Enter', true)
  expect(select).not.toHaveBeenCalled()
  await key(field, 'Enter')
  expect(select).toHaveBeenCalledExactlyOnceWith(originalId)
  expect(select.mock.results[0]?.value).toBe(true)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(originalId)
})
