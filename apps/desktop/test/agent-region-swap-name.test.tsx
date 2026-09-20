// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, regionIds } from '@agentmux/layout'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const terminalRenders = vi.hoisted(() => vi.fn())
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)(
    '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'
  )
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: { id: string } }) => {
    terminalRenders(session.id)
    return <div>Original terminal</div>
  }
}))
vi.mock('../src/renderer/src/lib/workbench-tab-actions', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/workbench-tab-actions')>()
  return { ...actual, regionSwapMenuEntries: vi.fn(actual.regionSwapMenuEntries) }
})

import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { regionSwapMenuEntries } from '../src/renderer/src/lib/workbench-tab-actions'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
const workspaceId = 'swap-name-workspace', tabId = 'swap-name-tab'
const ids = ['swap-left', 'swap-right', 'swap-third']
const names = ['Layout coordinator', 'Notes researcher', 'Build reviewer']
let root: Root, container: HTMLDivElement, sessionIds: string[]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const available = (await api.sessions.snapshot()).sessions.filter(session => session.kind === 'agent')
  expect(available.length).toBeGreaterThanOrEqual(2)
  const sessions = [available[0]!, available[1]!, { ...available[1]!, id: 'swap-third-session',
    control: { ...available[1]!.control, agentSessionId: 'swap-third-session' }
  }].map(session => ({
    ...session, providerId: available[0]!.providerId, executorId: available[0]!.executorId,
    label: available[0]!.label
  }))
  sessionIds = sessions.map(session => session.id)
  let tab = createWorkbenchTab(tabId, {
    regionId: ids[0]!, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[0]!
  })
  for (let index = 1; index < ids.length; index++) {
    tab = addWorkbenchRegion(tab, ids[index - 1]!, 'right', {
      regionId: ids[index]!, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[index]!
    })
  }
  useAppStore.setState({ ...initial, config: await api.config.get(), sessions,
    tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('swap-group', [tabId]) },
    activeWorkspaceId: workspaceId, agentNames: Object.fromEntries(sessionIds.map((id, index) => [id, names[index]!])),
    viewModes: Object.fromEntries(sessionIds.map(id => [id, 'terminal'])),
    agentComposerDrafts: Object.fromEntries(sessionIds.map(id => [id, `Unsent ${id}`]))
  }, true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(regionSwapMenuEntries).mockClear()
  terminalRenders.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount() {
  await act(async () => root.render(<WorkspaceWorkbench workspaceId={workspaceId} />))
}
function region(id: string) {
  const element = container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)
  expect(element).not.toBeNull()
  return element!
}
function headerName(id: string) {
  const strong = region(id).querySelector<HTMLElement>('.agent-region-header strong')
  expect(strong).not.toBeNull()
  expect(strong!.textContent!.length).toBeGreaterThan(0)
  expect(strong!.title).toBe(strong!.textContent)
  return strong!.textContent!
}
async function menu() {
  const trigger = region(ids[0]!).querySelector<HTMLButtonElement>('.agent-region-header__more')
  expect(trigger).not.toBeNull()
  await act(async () => {
    trigger!.focus()
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  await act(async () => vi.waitFor(() => expect(document.querySelector('.agent-region-menu [role="menuitem"]')).not.toBeNull()))
  const content = document.querySelector<HTMLElement>(`.agent-region-menu[data-owner-region-id="${ids[0]}"]`)
  expect(content).not.toBeNull()
  expect(content!.dataset.state).toBe('open')
  return content!
}
function swapItems(content: HTMLElement) {
  const items = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .filter(item => item.textContent?.trim().startsWith('Swap with '))
  expect(items).toHaveLength(2)
  return items
}
function expectTargetNames(content: HTMLElement) {
  const calls = vi.mocked(regionSwapMenuEntries)
  const index = calls.mock.calls.findLastIndex(([input]) => input.regionId === ids[0])
  expect(index).toBeGreaterThan(-1)
  const result = calls.mock.results[index]!
  expect(result.type).toBe('return')
  expect(result.value.map((entry: { targetRegionId: string }) => entry.targetRegionId)).toEqual(ids.slice(1))
  expect(swapItems(content).map(item => item.title)).toEqual(swapItems(content).map(item => item.textContent!.trim()))
  expect(swapItems(content).map(item => item.textContent!.trim())).toEqual(
    ids.slice(1).map(id => `Swap with ${headerName(id)}`)
  )
}

it('the actual Swap menu identifies its two Agent targets by their current Header names', async () => {
  await mount()
  expect(ids.map(headerName)).toEqual(names)
  expectTargetNames(await menu())
})

it('an already open menu follows rename, first prompt, Session label and Provider fallback', async () => {
  await mount()
  const content = await menu(), id = sessionIds[1]!
  await act(async () => useAppStore.getState().renameAgent(id, 'Updated investigation'))
  expect(headerName(ids[1]!)).toBe('Updated investigation')
  expectTargetNames(content)
  await act(async () => {
    useAppStore.getState().renameAgent(id, null)
    useAppStore.setState({ timelines: { [id]: { agentSessionId: id, revision: 1, items: [{
      id: 'first-prompt', agentSessionId: id, kind: 'user_message', status: 'complete', source: 'native-hook',
      createdAt: 1, updatedAt: 1, title: 'Investigate current delivery', content: 'Investigate current delivery'
    }] } } })
  })
  expect(headerName(ids[1]!)).toBe('Investigate current delivery')
  expectTargetNames(content)
  await act(async () => useAppStore.setState({ timelines: {} }))
  expect(headerName(ids[1]!)).toBe(useAppStore.getState().sessions[1]!.label)
  expectTargetNames(content)
  await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(
    session => session.id === id ? { ...session, label: '   ' } : session
  ) }))
  expect(headerName(ids[1]!)).toBe('Codex')
  expectTargetNames(content)
})

it('duplicate names number the entire visual order, including the original source Region', async () => {
  await mount()
  await act(async () => {
    useAppStore.getState().renameAgent(sessionIds[0]!, 'Same investigation')
    useAppStore.getState().renameAgent(sessionIds[2]!, 'Same investigation')
  })
  expect(ids.map(headerName)).toEqual(['Same investigation', names[1], 'Same investigation'])
  expect(swapItems(await menu()).map(item => item.textContent!.trim())).toEqual([
    `Swap with ${headerName(ids[1]!)}`, `Swap with ${headerName(ids[2]!)} 2`
  ])
})

it.each(['mouse', 'touch', 'keyboard'])('Swap retains its original two endpoints while the neighbor is active (%s)', async input => {
  const swap = vi.spyOn(useAppStore.getState(), 'swapRegions')
  await mount()
  const content = await menu(), items = swapItems(content)
  await act(async () => useAppStore.getState().focusRegion(workspaceId, tabId, ids[1]!, 'pointer'))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(ids[1])
  expect(content.dataset.state).toBe('open')
  const before = structuredClone(useAppStore.getState().tabs[tabId]!)
  const sessions = structuredClone(useAppStore.getState().sessions)
  const drafts = structuredClone(useAppStore.getState().agentComposerDrafts)
  await act(async () => {
    if (input === 'keyboard') {
      items[1]!.focus()
      items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    } else {
      items[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: input }))
      expect(content.dataset.state).toBe('open')
      expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(ids[1])
      items[1]!.click()
    }
  })
  const after = useAppStore.getState().tabs[tabId]!
  expect(swap.mock.calls).toEqual([[workspaceId, tabId, ids[0], ids[2]]])
  expect(regionIds(after.layout.root)).toEqual([ids[2], ids[1], ids[0]])
  expect(after.regions).toEqual(before.regions)
  expect(after.layout.activeRegionId).toBe(ids[1])
  expect(useAppStore.getState().sessions).toEqual(sessions)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
})

it('unrelated Session/name/timeline updates do not rederive the current menu targets', async () => {
  await mount()
  const calls = vi.mocked(regionSwapMenuEntries)
  expect(calls.mock.calls.length).toBeGreaterThan(0)
  const count = calls.mock.calls.length
  const terminalCalls = [...terminalRenders.mock.calls]
  expect(terminalCalls).toEqual([[sessionIds[0]]])
  await act(async () => useAppStore.setState(state => ({
    sessions: [...state.sessions, { ...state.sessions[0]!, id: 'unrelated-session' }],
    agentNames: { ...state.agentNames, 'unrelated-session': 'Unrelated work' },
    timelines: { ...state.timelines, 'unrelated-session': { agentSessionId: 'unrelated-session', revision: 1, items: [] } }
  })))
  expect(calls.mock.calls).toHaveLength(count)
  expect(terminalRenders.mock.calls).toEqual(terminalCalls)
  await act(async () => useAppStore.getState().renameAgent(sessionIds[1]!, 'Related update'))
  expect(calls.mock.calls.length).toBeGreaterThan(count)
  expectTargetNames(await menu())
})
