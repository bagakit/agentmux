// @vitest-environment happy-dom
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { agentRegionExecution, useAppStore } from '../src/renderer/src/store'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

const dom = composerDOM({ agentInformation: true })
const originalWidth = window.innerWidth
afterEach(() => Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }))
const workspace = composerConfig.workspaces[0]!
const review = { ...workspace, id: 'activity-review', name: 'Review', path: fixturePath('review'), kind: 'worktree' as const, branch: 'review' }
const spaceId = directoryIdentity('local', workspace.path)
const zoneId = workspaceZoneId(spaceId, workspace.id)
const reviewZoneId = workspaceZoneId(spaceId, review.id)

async function arrange(singleZone = false, repeatInTab = false) {
  const observedAt = Date.now()
  const sessions = ['primary', 'neighbor', 'reviewer'].slice(0, singleZone ? 2 : 3).map((id, index) => {
    const state = index === 1 ? 'waiting' as const : 'working' as const
    return { ...composerSession(id), label: `Task ${id}`, workspacePath: index === 2 ? review.path : workspace.path,
      status: { state, source: 'native-hook' as const, observedAt }, semanticStatus: { state, source: 'native-hook' as const, observedAt } }
  })
  let first = { ...addWorkbenchRegion(createWorkbenchTab('primary-tab', { kind: 'agent', phase: 'attached',
    regionId: 'primary-region', workspaceId: workspace.id, sessionId: 'primary' }), 'primary-region', 'right',
  { kind: 'agent', phase: 'attached', regionId: 'neighbor-region', workspaceId: workspace.id, sessionId: 'neighbor' }),
  name: 'Delivery', space: { spaceId, zoneId } }
  if (repeatInTab) first = addWorkbenchRegion(first, 'neighbor-region', 'right', { kind: 'agent', phase: 'attached',
    regionId: 'repeated-region', workspaceId: workspace.id, sessionId: 'primary' }) as typeof first
  const second = { ...createWorkbenchTab('second-tab', { kind: 'agent', phase: 'attached', regionId: 'second-region',
    workspaceId: workspace.id, sessionId: 'primary' }), name: 'Verification', space: { spaceId, zoneId } }
  const third = { ...createWorkbenchTab('review-tab', { kind: 'agent', phase: 'attached', regionId: 'review-region',
    workspaceId: review.id, sessionId: 'reviewer' }), name: 'Review work', space: { spaceId, zoneId: reviewZoneId } }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, review] }, sessions,
    tabs: Object.fromEntries((singleZone ? [first, second] : [first, second, third]).map(tab => [tab.id, tab])),
    layouts: { [workspace.id]: createWorkspaceLayout('primary-group', [first.id, second.id]),
      ...(singleZone ? {} : { [review.id]: createWorkspaceLayout('review-group', [third.id]) }) },
    spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id }, [reviewZoneId]: { spaceId, workspaceId: review.id } },
    scratchTopicSnapshots: {}, spatialRequests: {}, timelines: {}, agentNames: {},
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, workbenchSpaceSelection: null })
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
  expect(agentRegionExecution({ tabId: first.id, regionId: 'primary-region', agentSessionId: 'primary' })?.hostId).toBe('local')
  await dom.render(<ProjectActivity sessions={sessions} />)
}

async function openRoot() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('.project-activity')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  const root = document.querySelector<HTMLElement>('.project-activity-menu')!
  expect(root).not.toBeNull()
  return root
}

async function openZone() {
  const root = await openRoot()
  const zone = [...root.querySelectorAll<HTMLElement>('[data-zone-id]')].find(choice => choice.dataset.zoneId === zoneId)!
  expect(zone).not.toBeNull()
  await act(async () => zone.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => vi.waitFor(() => expect(document.querySelector('.project-activity-submenu')).not.toBeNull()))
  return document.querySelector<HTMLElement>('.project-activity-submenu')!
}

it('opens a single Zone directly with every original position and a clear repeated-Agent relationship', async () => {
  await arrange(true)
  const root = await openRoot()
  expect(root.dataset.direct).toBe('true')
  expect(root.querySelector('.project-activity-zone')).toBeNull()
  expect(document.querySelector('.project-activity-submenu')).toBeNull()
  const cards = [...root.querySelectorAll<HTMLElement>('.project-activity-agent')]
  expect(cards.map(card => [card.dataset.sessionId, card.dataset.regionId])).toEqual([
    ['primary', 'primary-region'], ['neighbor', 'neighbor-region'], ['primary', 'second-region']
  ])
  expect(cards.map(card => card.querySelector('.project-activity-agent__occurrence')?.textContent ?? null))
    .toEqual(['Same Agent · 2 positions', null, 'Same Agent · 2 positions'])
  expect(cards[0]!.getAttribute('aria-description')).toContain('Same Agent · 2 positions')
  expect(root.querySelector<HTMLElement>('.project-activity-submenu__heading')?.title).toContain('repo')
  expect(root.querySelector<HTMLElement>('.project-activity-submenu__heading')?.title).toContain('local')
  expect(root.querySelector('.focus-context__position')).toBeNull()
  expect(root.querySelectorAll('.project-activity-menu__summary')).toHaveLength(1)
  expect(root.querySelector('.project-activity-menu__summary')?.textContent).toBe('1 Needs you · 1 Working')
})

it('keeps one readable summary and two-line Zone choices before the shared Agent cards', async () => {
  await arrange()
  const root = await openRoot()
  expect(root.querySelectorAll('.project-activity-menu__heading')).toHaveLength(1)
  expect(root.querySelectorAll('.project-activity-menu__summary')).toHaveLength(1)
  expect(root.querySelector('.project-activity-menu__summary')?.textContent).toBe('1 Needs you · 2 Working')
  expect(root.querySelector('.project-activity__metrics')).toBeNull()
  const choices = [...root.querySelectorAll<HTMLElement>('.project-activity-zone')]
  expect(choices).toHaveLength(2)
  expect(choices.map(choice => choice.querySelector('.project-activity-zone__identity')?.children.length)).toEqual([2, 2])
  expect(choices.map(choice => choice.querySelector('strong')?.textContent)).toEqual(['repo', 'review'])
  expect(choices[0]!.title).toContain('repo')
  expect(root.textContent).not.toContain(workspace.path)
  const submenu = await openZone()
  expect(submenu.querySelector('.project-activity__metrics')).toBeNull()
  expect([...submenu.querySelectorAll<HTMLElement>('.project-activity-tab')].map(tab => tab.dataset.tabId))
    .toEqual(['primary-tab', 'second-tab'])
  expect(submenu.querySelectorAll('.project-activity-agent')).toHaveLength(3)
})

it('uses one row hover destination while the shared Reader retains complete position identity', async () => {
  await arrange()
  const submenu = await openZone()
  const card = submenu.querySelector<HTMLButtonElement>('[data-region-id="primary-region"]')!
  expect(card).not.toBeNull()
  expect(card.querySelector('.focus-context__position')).toBeNull()
  expect(card.querySelector('.focus-context__identity .agent-avatar')).not.toBeNull()
  await act(async () => card.focus())
  const reader = document.querySelector<HTMLElement>('.agent-information-reader')!
  expect(reader).not.toBeNull()
  await act(async () => reader.querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  const source = [...reader.querySelectorAll<HTMLButtonElement>('.agent-information-details__tabs button')].find(button => button.textContent === 'Source')!
  expect(source).not.toBeNull()
  await act(async () => source.click())
  expect(reader.querySelector('.focus-context-hover__workbench')?.getAttribute('aria-label')).toBe('2 confirmed positions')
  expect([...reader.querySelectorAll<HTMLElement>('[data-focus-occurrence-key]')].map(position => position.dataset.focusOccurrenceKey))
    .toEqual([JSON.stringify([workspace.id, 'primary-group', 'primary-tab']), JSON.stringify([workspace.id, 'primary-group', 'second-tab'])])
})

it('describes the configured keyboard reading action without advertising unavailable hover reading', async () => {
  await arrange(true)
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus, previewTrigger: 'keyboard' } } })))
  const root = await openRoot()
  expect(root.querySelector('.project-activity-menu__hint')?.textContent).toBe('Select an Agent · → to read · Enter to open')
  const card = root.querySelector<HTMLElement>('.project-activity-agent')!
  await act(async () => card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => card.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.querySelector('.agent-information-reader')).toBeNull()
})

it('distinguishes the exact Regions when one Tab shows the same Agent more than once', async () => {
  await arrange(true, true)
  const root = await openRoot()
  const positions = [...root.querySelectorAll<HTMLButtonElement>('.project-activity-agent[data-session-id="primary"]')]
  expect(positions.map(card => [card.dataset.regionId, card.querySelector('.project-activity-agent__occurrence')?.textContent]))
    .toEqual([
      ['primary-region', 'Same Agent · 3 positions · Region 1'],
      ['repeated-region', 'Same Agent · 3 positions · Region 3'],
      ['second-region', 'Same Agent · 3 positions']
    ])
  await act(async () => positions[1]!.click())
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: workspace.id,
    groupId: 'primary-group', tabId: 'primary-tab', regionId: 'repeated-region' })
})

async function resize(width: number) {
  await act(async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
  })
}

async function enterNarrowGroup(root: HTMLElement, target = reviewZoneId) {
  const choice = [...root.querySelectorAll<HTMLElement>('[data-zone-id]')].find(node => node.dataset.zoneId === target)!
  expect(choice).not.toBeNull()
  await act(async () => {
    choice.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }))
    choice.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  })
  expect(document.querySelector('.project-activity-menu')).toBe(root)
  expect(root.querySelector('[data-activity-back]')).not.toBeNull()
  expect(document.querySelector('.project-activity-submenu')).toBeNull()
}

it('keeps narrow group hover on the list, then enters on click and returns to that exact group', async () => {
  await resize(360); await arrange()
  const input = document.createElement('input'); dom.container.append(input)
  input.value = 'Keep typing in the original workface'
  await act(async () => input.focus())
  const root = await openRoot()
  const choice = [...root.querySelectorAll<HTMLElement>('[data-zone-id]')].find(node => node.dataset.zoneId === reviewZoneId)!
  await act(async () => choice.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(root.querySelector('[data-activity-back]')).toBeNull()
  expect(root.querySelectorAll('.project-activity-zone')).toHaveLength(2)
  expect(document.activeElement).toBe(input)
  root.scrollTop = 137
  await enterNarrowGroup(root)
  expect(root.scrollTop).toBe(0)
  expect([...root.querySelectorAll<HTMLElement>('.project-activity-agent')].map(card => card.dataset.sessionId)).toEqual(['reviewer'])
  expect(document.activeElement).toBe(root.querySelector('[data-activity-back]'))
  expect(document.querySelector('.agent-information-reader')).toBeNull()
  expect(input.value).toBe('Keep typing in the original workface')
  const back = root.querySelector<HTMLElement>('[data-activity-back]')!
  await act(async () => back.click())
  await vi.waitFor(() => expect((document.activeElement as HTMLElement).dataset.zoneId).toBe(reviewZoneId))
  expect(document.querySelector('.project-activity-menu')).toBe(root)
  expect(root.querySelector('[data-activity-back]')).toBeNull()
  expect(root.querySelectorAll('.project-activity-zone')).toHaveLength(2)
  expect(root.scrollTop).toBe(137)
  expect([...root.querySelectorAll<HTMLElement>('[data-zone-id]')].find(node => node.dataset.zoneId === reviewZoneId)).toBeDefined()
})

it.each(['ArrowLeft', 'Escape'])('returns from a narrow group with %s while keeping the original root', async key => {
  await resize(639); await arrange()
  const root = await openRoot(); await enterNarrowGroup(root)
  const back = root.querySelector<HTMLElement>('[data-activity-back]')!
  await act(async () => {
    back.focus()
    back.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await vi.waitFor(() => expect((document.activeElement as HTMLElement).dataset.zoneId).toBe(reviewZoneId))
  expect(document.querySelector('.project-activity-menu')).toBe(root)
  expect(root.querySelector('[data-activity-back]')).toBeNull()
})

it('waits for real pointer movement after a narrow group replaces the hovered row', async () => {
  await resize(360); await arrange()
  const root = await openRoot(); await enterNarrowGroup(root)
  const card = root.querySelector<HTMLElement>('.project-activity-agent')!
  expect(card.dataset.regionId).toBe('review-region')
  await act(async () => {
    card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 }))
    await new Promise(resolve => setTimeout(resolve, 350))
  })
  expect(document.querySelector('.agent-information-reader')).toBeNull()
  expect(document.activeElement).toBe(root.querySelector('[data-activity-back]'))
  await act(async () => card.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => vi.waitFor(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull()))
  expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
  expect(document.querySelector('.project-activity-menu')).toBe(root)
})

it('keeps a disclosed group and the typing target while resizing until explicit Back', async () => {
  await resize(1280); await arrange()
  const input = document.createElement('input'); dom.container.append(input)
  input.value = 'Original unsent text'; await act(async () => input.focus())
  const submenu = await openZone()
  const root = document.querySelector<HTMLElement>('.project-activity-menu')!
  submenu.scrollTop = 81
  for (const width of [360, 1280, 360]) {
    await resize(width)
    expect(document.querySelector('.project-activity-menu')).toBe(root)
    expect(root.dataset.singlePanel).toBe('true')
    expect(root.querySelector('[data-activity-back]')).not.toBeNull()
    expect([...root.querySelectorAll<HTMLElement>('.project-activity-agent')].map(card => card.dataset.sessionId)).toEqual(['primary', 'neighbor', 'primary'])
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Original unsent text')
    expect(root.scrollTop).toBe(81)
    expect(document.querySelector('.project-activity-submenu')).toBeNull()
  }
})

it('preserves the exact focused Agent occurrence when a wide cascade becomes a single panel', async () => {
  await resize(1280); await arrange()
  const submenu = await openZone()
  const card = submenu.querySelector<HTMLElement>('[data-region-id="second-region"]')!
  await act(async () => card.focus())
  submenu.scrollTop = 83
  await resize(360)
  const expected = JSON.stringify([workspace.id, 'primary-group', 'second-tab', 'second-region'])
  await vi.waitFor(() => expect((document.activeElement as HTMLElement).dataset.activityPosition).toBe(expected))
  expect(document.querySelector('.project-activity-submenu')).toBeNull()
  expect(document.querySelectorAll('.project-activity-menu .project-activity-agent')).toHaveLength(3)
  expect(document.querySelector('.project-activity-menu')?.scrollTop).toBe(83)
})
