// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { focusProjectKey, type FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM(), onSelect = vi.fn()
const summary = 'Original Topic description with full task requirements. '.repeat(8) + 'COMPLETE TOPIC DESCRIPTION TAIL'
const lane: FocusProjectLane = { id: 'original-lane', workspaceId: 'original-workspace', projectId: 'original-project', name: 'Original Topic', path: fixturePath('original-topic'), hostId: 'original-host',
  labels: ['Original Topic'], topicId: 'original-topic', recovery: null, projectWorkspaceId: null, summary, objectKind: 'topic', activeAgentIds: ['original-agent'], contextIds: ['original-agent'], lastActivityAt: null }
async function render(visible = true) { await dom.render(<FocusProjectLanes lanes={[lane]} selectedProjectKey="unchanged-selection" onSelect={onSelect} visible={visible} renderLane={(_lane, heading) => <>{heading}<p>Original Agent card content</p></>} />) }
const article = () => dom.container.querySelector<HTMLElement>('article')!
const axis = () => dom.container.querySelector<HTMLButtonElement>('.focus-project-lanes__axis')!
const tooltip = () => document.querySelector<HTMLElement>('.workbench-tab-name-tooltip')
beforeEach(() => { onSelect.mockReset(); useAppStore.setState({ config: { ...composerConfig, hosts: [{ id: 'original-host', kind: 'local', label: 'Original machine label' }] }, spaceObjectIcons: {} }) })

it.each(['pointer', 'keyboard'] as const)('reveals the complete held description through %s without navigating', async input => {
  await render()
  const before = useAppStore.getState(), selection = before.workbenchSpaceSelection, focus = before.agentFocus
  const host = axis().querySelector<HTMLElement>('[data-host-id="original-host"]')!
  expect(host.getAttribute('aria-label')).toBe('Host: Original machine label · original-host')
  expect(host.textContent).toBe(''); expect(host.querySelector('svg')).not.toBeNull()
  if (input === 'pointer') await act(async () => article().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  else await act(async () => axis().focus())
  await act(async () => vi.waitFor(() => expect(tooltip()?.textContent).toContain('COMPLETE TOPIC DESCRIPTION TAIL')))
  expect(tooltip()?.textContent).toContain(summary)
  expect(article().contains(tooltip())).toBe(false)
    expect(onSelect).not.toHaveBeenCalled(); expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection); expect(useAppStore.getState().agentFocus).toBe(focus)
  await act(async () => axis().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(tooltip()).toBeNull(); expect(onSelect).not.toHaveBeenCalled()
})
it('hides the same lane disclosure when inactive and retains explicit original project selection', async () => {
  await render(); await act(async () => axis().focus()); expect(tooltip()).not.toBeNull()
  const original = article(); await render(false)
  expect(tooltip()).toBeNull(); expect(article()).toBe(original)
  await act(async () => original.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(tooltip()).toBeNull(); expect(onSelect).not.toHaveBeenCalled()
  await render(); await act(async () => axis().click())
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(focusProjectKey(lane.hostId, lane.projectId))
})

it('keeps the actual HTML lane disclosure event driven without a per-frame anchor read', async () => {
  await render()
  const heading = article().querySelector<HTMLElement>('.focus-project-lanes__heading')!
  const reads = vi.spyOn(heading, 'getBoundingClientRect')
  await act(async () => axis().focus())
  const panel = tooltip()!
  expect(panel.textContent).toContain(summary)
  const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await act(async () => frames())
  const settled = reads.mock.calls.length
  expect(settled).toBeGreaterThan(0)
  await act(async () => frames())
  expect(reads).toHaveBeenCalledTimes(settled)
  expect(tooltip()).toBe(panel); expect(onSelect).not.toHaveBeenCalled()
  await render(false)
  expect(tooltip()).toBeNull()
})
