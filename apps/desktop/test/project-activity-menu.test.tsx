// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

const dom = composerDOM()
async function openAgents() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('.project-activity')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.querySelector('.project-activity-menu[data-direct="true"]')).not.toBeNull()
  expect(document.querySelector('.project-activity-zone')).toBeNull()
  const cards = [...document.querySelectorAll<HTMLButtonElement>('.project-activity-menu .focus-context')]
  expect(cards.length).toBeGreaterThan(0)
  return cards
}

it('keeps both same-SID Host subjects readable without jumping to an ambiguous original Session', async () => {
  const local = composerSession('same-session')
  const remote = { ...local, hostId: 'remote', label: 'Remote original', control: { ...local.control, hostId: 'remote', run: { runId: 'remote-original-run' } } }
  const selectSession = vi.fn(), reportError = vi.fn()
  useAppStore.setState({ sessions: [local, remote], tabs: {}, layouts: {}, agentNames: {}, timelines: {},
    selectSession, reportError, agentComposerDrafts: { [local.id]: 'Keep the existing draft' } })
  const held = useAppStore.getState()
  await dom.render(<ProjectActivity sessions={[local, remote]} />)
  const cards = await openAgents()
  expect(cards).toHaveLength(2)
  expect(cards.map(card => card.dataset.sessionId)).toEqual([local.id, remote.id])
  expect(cards[1]!.textContent).toContain(remote.label)
  for (const card of cards) {
    await act(async () => card.click())
    expect(selectSession).not.toHaveBeenCalled()
    expect(document.querySelector('.project-activity-menu')).not.toBeNull()
    expect(document.querySelectorAll('.project-activity-menu .focus-context')).toHaveLength(2)
  }
  expect(reportError).toHaveBeenCalledTimes(2)
  expect(reportError.mock.calls.every(([error, context]) => error.message.includes('not uniquely confirmed') && context.kind === 'indeterminate')).toBe(true)
  expect(useAppStore.getState().sessions).toBe(held.sessions)
  expect(useAppStore.getState().tabs).toBe(held.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(held.agentComposerDrafts)
})

it('does not let a retained no-position card select a different Host after its original observation changes', async () => {
  const original = composerSession('original-session')
  const selectSession = vi.fn(), reportError = vi.fn()
  useAppStore.setState({ sessions: [original], tabs: {}, layouts: {}, selectSession, reportError })
  await dom.render(<ProjectActivity sessions={[original]} />)
  const [card] = await openAgents()
  const replacement = { ...original, hostId: 'another-host', control: { ...original.control, hostId: 'another-host' } }
  await act(async () => useAppStore.setState({ sessions: [replacement] }))
  await act(async () => card!.click())
  expect(selectSession).not.toHaveBeenCalled()
  expect(reportError).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.project-activity-menu .focus-context')).toBe(card)
  expect(useAppStore.getState().sessions).toEqual([replacement])
})

it('retains Activity after the original navigation fails and closes only after a successful retry', async () => {
  const original = composerSession('unplaced-original')
  useAppStore.setState({ config: composerConfig, sessions: [original], tabs: {}, layouts: {}, timelines: {},
    agentNames: {}, workbenchSpaceSelection: null, agentComposerDrafts: { [original.id]: 'Keep the original draft' } })
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  useAppStore.setState({ config: { ...composerConfig, workspaces: [] } })
  const held = useAppStore.getState()
  await dom.render(<ProjectActivity sessions={[original]} />)
  const [card] = await openAgents()
  const menu = document.querySelector('.project-activity-menu')
  await act(async () => card!.click())
  expect(select).toHaveReturnedWith(false)
  expect(document.querySelector('.project-activity-menu')).toBe(menu)
  expect(document.querySelector('.project-activity-agent')).toBe(card)
  expect(useAppStore.getState().sessions).toBe(held.sessions)
  expect(useAppStore.getState().tabs).toBe(held.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(held.agentComposerDrafts)
  expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()

  await act(async () => useAppStore.setState({ config: composerConfig }))
  await act(async () => card!.click())
  expect(select).toHaveReturnedWith(true)
  expect(select).toHaveBeenCalledTimes(2)
  expect(document.querySelector('.project-activity-menu')).toBeNull()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(original.id)
  expect(useAppStore.getState().agentComposerDrafts).toBe(held.agentComposerDrafts)
})
