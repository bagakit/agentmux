// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
let app: MoteAppFixture
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
let observed = reference
beforeEach(() => {
  app = createMoteApp(); observed = reference
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }): Promise<MoteDialoguePage> => ({
    main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null,
      documentRevision: 'original-file', roleRevision: 'original-role', current: observed, issue: null },
    links: [], incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null
  }))
})
afterEach(async () => { await app.dispose() })
const surface = () => app.container.querySelector<HTMLElement>('.workbench-context-frame[data-mote-workface-presentation]')!
const chrome = () => surface().querySelector<HTMLElement>('.pane-tabbar__workface')!
const action = () => surface().querySelector<HTMLButtonElement>('.mote-workface__presentation-action')!
function retained() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, drafts: state.agentComposerDrafts, queues: state.agentSteerQueues }
}
function noExecution() {
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}
it('the actual App folds IDE chrome, then reveals and restores the original workface without remounting its body', async () => {
  await app.mount()
  await vi.waitFor(() => expect(action()?.textContent).toBe('原工作面'))
  const original = retained(), body = surface().querySelector('.pane-body'), reader = surface().querySelector('[data-activity-session="default-agent"]'), composer = surface().querySelector('[aria-label="Message Agent"]')
  expect(body).not.toBeNull(); expect(reader).not.toBeNull(); expect(composer).not.toBeNull()
  expect(chrome().hidden).toBe(true); expect(chrome().inert).toBe(true)
  await moteClick(action())
  expect(action().textContent).toBe('返回主对话'); expect(chrome().hidden).toBe(false); expect(chrome().inert).toBe(false)
  expect(chrome().querySelectorAll('.workbench-tab')).not.toHaveLength(0)
  await moteClick(action())
  expect(action().textContent).toBe('原工作面'); expect(chrome().hidden).toBe(true)
  expect(surface().querySelector('.pane-body')).toBe(body); expect(surface().querySelector('[data-activity-session="default-agent"]')).toBe(reader)
  expect(surface().querySelector('[aria-label="Message Agent"]')).toBe(composer)
  expect(retained()).toEqual(original); noExecution()
})
it('a human terminal choice keeps original controls available and the explicit return restores only presentation', async () => {
  await app.mount(); await moteClick(action())
  await act(async () => useAppStore.getState().setViewMode(defaultAgent.id, 'terminal', { focus: false }))
  await settleMoteApp()
  const original = retained()
  expect(chrome().hidden).toBe(false); expect(surface().querySelector('[data-terminal-session="default-agent"]')).not.toBeNull()
  await moteClick(action())
  expect(useAppStore.getState().viewModes[defaultAgent.id]).toBe('activity'); expect(chrome().hidden).toBe(true)
  expect(retained()).toEqual(original); noExecution()
})
it('an observed main tuple naming another Session cannot move the original workface or clear its draft', async () => {
  observed = { ...reference, sessionId: 'foreign-original-session' }
  await app.mount(); await moteClick(action())
  const original = retained(), selection = useAppStore.getState().workbenchSpaceSelection
  await moteClick(action())
  expect(chrome().hidden).toBe(false); expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(selection)
  expect(retained()).toEqual(original); noExecution()
})
